import { Router, Request, Response } from 'express';
import pool from '../db';
import { authenticate, AuthRequest } from '../middleware/auth';
import { io } from '../index';

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
                ORDER BY bl.logged_at DESC LIMIT 5),
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

// POST /api/sessions/:id/simulate-usage — simulate bandwidth usage for demo
router.post('/:id/simulate-usage', authenticate, async (req: AuthRequest, res: Response): Promise<void> => {
  const { usage_mbps } = req.body;
  const sessionId = req.params.id;

  if (!usage_mbps || usage_mbps < 0) {
    res.status(400).json({ error: 'usage_mbps required' }); return;
  }

  try {
    // Log bandwidth usage
    await pool.query(
      'INSERT INTO bandwidth_logs (session_id, usage_mbps) VALUES (?, ?)',
      [sessionId, usage_mbps]
    );

    // Get session VAP limits
    const [rows] = await pool.query<any[]>(`
      SELECT s.id, s.is_throttled, vap.throttle_threshold_mbps, vap.bandwidth_limit_mbps
      FROM sessions s
      LEFT JOIN vaps vap ON s.vap_id = vap.id
      WHERE s.id = ?
    `, [sessionId]);

    const session = rows[0];
    if (!session) { res.status(404).json({ error: 'Session not found' }); return; }

    // Auto-throttle if over threshold
    const shouldThrottle = usage_mbps >= session.throttle_threshold_mbps;
    if (shouldThrottle && !session.is_throttled) {
      await pool.query('UPDATE sessions SET is_throttled = TRUE WHERE id = ?', [sessionId]);
      io.emit('session:throttled', { sessionId: Number(sessionId), usage_mbps });
    } else if (!shouldThrottle && session.is_throttled) {
      await pool.query('UPDATE sessions SET is_throttled = FALSE WHERE id = ?', [sessionId]);
      io.emit('session:unthrottled', { sessionId: Number(sessionId) });
    }

    io.emit('bandwidth:update', { sessionId: Number(sessionId), usage_mbps, is_throttled: shouldThrottle });

    res.json({ logged: true, is_throttled: shouldThrottle, threshold: session.throttle_threshold_mbps });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to log usage' });
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

// DELETE /api/sessions/:id — disconnect (public so guest portal can call it)
router.delete('/:id', async (req: Request, res: Response): Promise<void> => {
  try {
    await pool.query(
      'UPDATE sessions SET is_active = FALSE, disconnected_at = NOW() WHERE id = ?',
      [req.params.id]
    );
    io.emit('session:disconnected', { sessionId: Number(req.params.id) });
    res.json({ message: 'Session disconnected' });
  } catch {
    res.status(500).json({ error: 'Failed to disconnect session' });
  }
});

export default router;
