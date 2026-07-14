import { Router, Request, Response } from 'express';
import pool from '../db';
import { authenticate, AuthRequest } from '../middleware/auth';
import { io } from '../index';
import { mikrotikRemoveGuestByIp, mikrotikReleasePortVlan, mikrotikFlushConntrack } from '../mikrotik';
import { mikrotikRemoveThrottleQueue, mikrotikCreateThrottleQueue } from '../bandwidth';

const router = Router();

// GET /api/sessions — active sessions with VAP info
router.get('/', authenticate, async (_req: AuthRequest, res: Response): Promise<void> => {
  try {
    const [rows] = await pool.query(`
      SELECT s.*, v.code AS voucher_code, r.room_number,
             vap.vlan_id, vap.bandwidth_limit_mbps, vap.is_isolated,
             COALESCE(
               (SELECT AVG(bl.usage_mbps) FROM bandwidth_logs bl
                WHERE bl.session_id = s.id
                  AND bl.id >= COALESCE(
                    (SELECT bl2.id FROM bandwidth_logs bl2
                     WHERE bl2.session_id = s.id
                     ORDER BY bl2.id DESC LIMIT 1 OFFSET 4), 0)),
             0) AS avg_usage_mbps
      FROM sessions s
      JOIN vouchers v ON s.voucher_id = v.id
      LEFT JOIN rooms r ON v.room_id = r.id
      LEFT JOIN vaps vap ON s.vap_id = vap.id
      WHERE s.is_active = TRUE
      ORDER BY s.connected_at DESC
    `);
    res.json(rows);
  } catch {
    res.status(500).json({ error: 'Failed to fetch sessions' });
  }
});

// GET /api/sessions/history
router.get('/history', authenticate, async (_req: AuthRequest, res: Response): Promise<void> => {
  try {
    const [rows] = await pool.query(`
      SELECT s.*, v.code AS voucher_code, r.room_number, vap.vlan_id
      FROM sessions s
      JOIN vouchers v ON s.voucher_id = v.id
      LEFT JOIN rooms r ON v.room_id = r.id
      LEFT JOIN vaps vap ON s.vap_id = vap.id
      ORDER BY s.connected_at DESC
      LIMIT 200
    `);
    res.json(rows);
  } catch {
    res.status(500).json({ error: 'Failed to fetch session history' });
  }
});

// GET /api/sessions/isolation-events
router.get('/isolation-events', authenticate, async (_req: AuthRequest, res: Response): Promise<void> => {
  try {
    const [rows] = await pool.query(`
      SELECT ie.*,
        s1.ip_address AS source_ip, r1.room_number AS source_room,
        s2.ip_address AS target_ip, r2.room_number AS target_room
      FROM isolation_events ie
      JOIN sessions s1 ON ie.source_session_id = s1.id
      JOIN sessions s2 ON ie.target_session_id = s2.id
      JOIN vouchers v1 ON s1.voucher_id = v1.id
      JOIN vouchers v2 ON s2.voucher_id = v2.id
      LEFT JOIN rooms r1 ON v1.room_id = r1.id
      LEFT JOIN rooms r2 ON v2.room_id = r2.id
      ORDER BY ie.occurred_at DESC
      LIMIT 100
    `);
    res.json(rows);
  } catch {
    res.status(500).json({ error: 'Failed to fetch isolation events' });
  }
});

// POST /api/sessions/check-isolation — check if two sessions can communicate
router.post('/check-isolation', authenticate, async (req: AuthRequest, res: Response): Promise<void> => {
  const { source_session_id, target_session_id } = req.body;

  try {
    const [rows] = await pool.query<any[]>(`
      SELECT s.id, s.vap_id, vap.is_isolated, r.room_number
      FROM sessions s
      LEFT JOIN vaps vap ON s.vap_id = vap.id
      LEFT JOIN vouchers v ON s.voucher_id = v.id
      LEFT JOIN rooms r ON v.room_id = r.id
      WHERE s.id IN (?, ?) AND s.is_active = TRUE
    `, [source_session_id, target_session_id]);

    if (rows.length < 2) {
      res.status(404).json({ error: 'One or both sessions not found' }); return;
    }

    const source = rows.find((r: any) => r.id === source_session_id);
    const target = rows.find((r: any) => r.id === target_session_id);

    const sameVap = source.vap_id === target.vap_id;
    const isolated = source.is_isolated || target.is_isolated;
    const blocked = !sameVap && isolated;

    // Log isolation event if blocked
    if (blocked) {
      await pool.query(
        'INSERT INTO isolation_events (source_session_id, target_session_id, action, reason) VALUES (?, ?, ?, ?)',
        [source_session_id, target_session_id, 'BLOCKED', `Cross-VAP communication blocked: VAP ${source.vap_id} → VAP ${target.vap_id}`]
      );
      io.emit('isolation:blocked', {
        source: { sessionId: source.id, room: source.room_number },
        target: { sessionId: target.id, room: target.room_number },
      });
    }

    res.json({
      blocked,
      reason: blocked ? `Client isolation active — Room ${source.room_number} cannot communicate with Room ${target.room_number}` : 'Same VAP — communication allowed',
      source_vap: source.vap_id,
      target_vap: target.vap_id,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Isolation check failed' });
  }
});

// DELETE /api/sessions/:id — disconnect
// Accepts admin JWT (any Bearer token) or the special guest "Bearer guest" token
router.delete('/:id', async (req: Request, res: Response): Promise<void> => {
  const authHeader = req.headers.authorization || '';
  // Accept any Bearer token — admins have JWT, guests send "Bearer guest"
  if (!authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Unauthorized — Bearer token required' });
    return;
  }

  try {
    // Fetch the session's IP and room info before closing it
    const [rows] = await pool.query<any[]>(
      `SELECT s.ip_address, r.room_number, vap.vlan_id
       FROM sessions s
       LEFT JOIN vouchers v ON s.voucher_id = v.id
       LEFT JOIN rooms r ON v.room_id = r.id
       LEFT JOIN vaps vap ON s.vap_id = vap.id
       WHERE s.id = ?`,
      [req.params.id]
    );
    const sessionIp: string | null = rows[0]?.ip_address
      ? rows[0].ip_address.replace(/^::ffff:/, '').trim()
      : null;
    const roomNumber: string | null = rows[0]?.room_number ?? null;
    const vlanId: number | null = rows[0]?.vlan_id ?? null;

    // Update DB and emit socket event immediately — don't wait for MikroTik
    await pool.query(
      'UPDATE sessions SET is_active = FALSE, disconnected_at = NOW() WHERE id = ?',
      [req.params.id]
    );

    // Emit immediately so portal and admin update right away
    io.emit('session:disconnected', { sessionId: Number(req.params.id) });
    res.json({ message: 'Session disconnected' });

    console.log(`[Disconnect] Session #${req.params.id} — IP: ${sessionIp || 'none'}, Room: ${roomNumber || 'none'}`);

    // Run MikroTik calls in parallel after responding — don't block the HTTP response
    const mikrotikTasks: Promise<any>[] = [];
    if (sessionIp) {
      // Remove from address-list and flush conntrack in parallel — fastest cutoff
      mikrotikTasks.push(mikrotikRemoveGuestByIp(sessionIp));
      mikrotikTasks.push(mikrotikFlushConntrack(sessionIp));
    } else {
      console.log(`[Disconnect] No IP stored for session #${req.params.id} — skipping MikroTik removal`);
    }
    if (roomNumber && vlanId) {
      mikrotikTasks.push(mikrotikReleasePortVlan(roomNumber, vlanId, Number(req.params.id)));
    }
    // Always remove throttle queue on disconnect
    mikrotikTasks.push(mikrotikRemoveThrottleQueue(Number(req.params.id)));
    // Fire and forget — errors are logged inside each function
    Promise.all(mikrotikTasks).catch(err =>
      console.error(`[Disconnect] MikroTik error for session #${req.params.id}:`, err)
    );
  } catch (err) {
    console.error(`[Disconnect] Error for session #${req.params.id}:`, err);
    res.status(500).json({ error: 'Failed to disconnect session' });
  }
});

// POST /api/sessions/:id/throttle — manually throttle or unthrottle a session
router.post('/:id/throttle', authenticate, async (req: AuthRequest, res: Response): Promise<void> => {
  const sessionId = Number(req.params.id);
  const throttle: boolean = req.body?.throttle ?? true;
  try {
    const [rows] = await pool.query<any[]>(
      `SELECT s.ip_address, vap.bandwidth_limit_mbps
       FROM sessions s LEFT JOIN vaps vap ON s.vap_id = vap.id
       WHERE s.id = ? AND s.is_active = TRUE`,
      [sessionId]
    );
    if (!rows[0]) { res.status(404).json({ error: 'Session not found' }); return; }

    const ip: string | null = rows[0]?.ip_address?.replace(/^::ffff:/, '').trim() ?? null;
    const limitMbps: number = rows[0]?.bandwidth_limit_mbps ?? 2;

    if (ip) {
      if (throttle) {
        await mikrotikRemoveThrottleQueue(sessionId);
        await mikrotikCreateThrottleQueue(sessionId, ip, limitMbps);
      } else {
        await mikrotikRemoveThrottleQueue(sessionId);
      }
    }

    await pool.query('UPDATE sessions SET is_throttled = ? WHERE id = ?', [throttle, sessionId]);
    io.emit('session:throttle', { sessionId, is_throttled: throttle, manual: true });
    res.json({ ok: true, sessionId, throttled: throttle, ip, limitMbps });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
