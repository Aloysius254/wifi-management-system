import { Router, Request, Response } from 'express';
import { nanoid } from 'nanoid';
import pool from '../db';
import { authenticate, AuthRequest } from '../middleware/auth';
import { io } from '../index';
import { sendVoucherSMS } from '../sms';
import { logAction } from '../audit';
import { checkRate, clearRate } from '../rateLimit';
import { mikrotikAllowGuest, mikrotikRemoveGuestByIp, mikrotikAssignPortVlan, mikrotikReleasePortVlan } from '../mikrotik';

const router = Router();

// GET /api/vouchers  (admin)
router.get('/', authenticate, async (_req: AuthRequest, res: Response): Promise<void> => {
  try {
    const [rows] = await pool.query(`
      SELECT v.*, r.room_number, r.ssid,
        (SELECT COUNT(*) FROM sessions s WHERE s.voucher_id = v.id AND s.is_active = TRUE) AS active_devices
      FROM vouchers v
      LEFT JOIN rooms r ON v.room_id = r.id
      ORDER BY v.created_at DESC
    `);
    res.json(rows);
  } catch {
    res.status(500).json({ error: 'Failed to fetch vouchers' });
  }
});

// GET /api/vouchers/check/:code  (guest — no auth needed)
router.get('/check/:code', async (req: Request, res: Response): Promise<void> => {
  try {
    const [rows] = await pool.query<any[]>(
      `SELECT v.*, r.room_number FROM vouchers v
       LEFT JOIN rooms r ON v.room_id = r.id
       WHERE v.code = ? AND v.is_active = TRUE`,
      [req.params.code]
    );
    const voucher = rows[0];
    if (!voucher) { res.status(404).json({ error: 'Voucher not found or inactive' }); return; }
    if (voucher.expires_at && new Date(voucher.expires_at) < new Date()) {
      res.status(410).json({ error: 'Voucher has expired' }); return;
    }
    res.json(voucher);
  } catch {
    res.status(500).json({ error: 'Failed to check voucher' });
  }
});

// POST /api/vouchers  (admin)
router.post('/', authenticate, async (req: AuthRequest, res: Response): Promise<void> => {
  const { room_id, duration_hours = 24, max_devices = 2, quantity = 1, guest_phone } = req.body;
  if (quantity < 1 || quantity > 100) {
    res.status(400).json({ error: 'quantity must be between 1 and 100' }); return;
  }
  try {
    const created: any[] = [];

    // Get room info for SMS
    let roomNumber = '';
    if (room_id) {
      const [roomRows] = await pool.query<any[]>('SELECT room_number FROM rooms WHERE id = ?', [room_id]);
      if (roomRows[0]) roomNumber = roomRows[0].room_number;
    }

    for (let i = 0; i < quantity; i++) {
      const code = nanoid(10).toUpperCase();
      const [result] = await pool.query<any>(
        'INSERT INTO vouchers (code, room_id, duration_hours, max_devices) VALUES (?, ?, ?, ?)',
        [code, room_id ?? null, duration_hours, max_devices]
      );
      created.push({ id: result.insertId, code, room_id, duration_hours, max_devices });
      await logAction(req.admin!.username, 'CREATE_VOUCHER', `Code ${code} — Room ${roomNumber || 'none'} — ${duration_hours}h / ${max_devices} devices`, req.ip);

      // Send SMS if phone number provided (only for single voucher)
      if (guest_phone && quantity === 1) {
        const guestPortalUrl = `${req.protocol}://${req.get('host')}/guest`;
        const smsSent = await sendVoucherSMS(guest_phone, code, roomNumber, duration_hours, guestPortalUrl);
        created[0].sms_sent = smsSent;
      }
    }
    res.status(201).json(quantity === 1 ? created[0] : created);
  } catch {
    res.status(500).json({ error: 'Failed to create voucher(s)' });
  }
});

// Generate a locally-administered unicast MAC address for demo purposes
function randomMac(): string {
  return Array.from({ length: 6 }, (_, i) => {
    const byte = Math.floor(Math.random() * 256);
    // Byte 0: clear multicast bit (LSB), set locally-administered bit (bit 1)
    return (i === 0 ? (byte & 0xfe) | 0x02 : byte).toString(16).padStart(2, '0');
  }).join(':');
}

// Detect device model from User-Agent string
function detectDevice(ua: string): string {
  if (!ua) return 'Unknown Device';
  if (/iPhone/.test(ua)) {
    const m = ua.match(/iPhone OS ([\d_]+)/);
    return `iPhone (iOS ${m ? m[1].replace(/_/g, '.') : ''})`;
  }
  if (/iPad/.test(ua)) return 'iPad';
  // Samsung — extract model number
  const samsungModel = ua.match(/SM-([A-Z0-9]+)/i);
  if (samsungModel) return `Samsung SM-${samsungModel[1]}`;
  if (/Samsung/i.test(ua)) return 'Samsung Galaxy';
  // Other Android brands
  if (/Xiaomi|Redmi/i.test(ua)) return 'Xiaomi Device';
  if (/HUAWEI|Huawei/i.test(ua)) return 'Huawei Device';
  if (/Tecno/i.test(ua)) return 'Tecno Device';
  if (/Infinix/i.test(ua)) return 'Infinix Device';
  if (/itel/i.test(ua)) return 'Itel Device';
  if (/OPPO/i.test(ua)) return 'OPPO Device';
  if (/vivo/i.test(ua)) return 'Vivo Device';
  if (/Nokia/i.test(ua)) return 'Nokia Device';
  // Generic Android — show brand from UA if available
  const androidBuild = ua.match(/;\s*([A-Za-z0-9_\- ]+)\s+Build\//);
  if (androidBuild) return androidBuild[1].trim();
  if (/Android/.test(ua)) {
    const ver = ua.match(/Android\s([\d.]+)/);
    return `Android ${ver ? ver[1] : 'Device'}`;
  }
  if (/Windows Phone/.test(ua)) return 'Windows Phone';
  if (/Windows/.test(ua)) return 'Windows PC';
  if (/Macintosh/.test(ua)) return 'Mac';
  if (/Linux/.test(ua)) return 'Linux Device';
  return 'Unknown Device';
}

// POST /api/vouchers/:code/activate  (guest — no auth needed)
router.post('/:code/activate', async (req: Request, res: Response): Promise<void> => {
  const { device_name, ip_address } = req.body;
  const userAgent = req.headers['user-agent'] || '';

  // Normalize the client IP — strip IPv6-mapped prefix (::ffff:192.168.x.x → 192.168.x.x)
  function normalizeIp(raw: string | undefined): string | null {
    if (!raw) return null;
    const s = Array.isArray(raw) ? raw[0] : raw;
    return s.replace(/^::ffff:/, '').trim() || null;
  }

  const rawIp = ip_address
    || (req.headers['x-forwarded-for'] as string | undefined)
    || req.socket.remoteAddress;
  const clientIp = normalizeIp(rawIp);

  // Rate limit by IP: max 5 failed attempts per 15 minutes
  const rateKey = clientIp || 'unknown';
  const rateCheck = checkRate(rateKey);
  if (rateCheck !== true) {
    res.status(429).json({ error: `Too many failed attempts. Try again in ${rateCheck} minute(s).` });
    return;
  }
  // Auto-detect device model if user didn't provide a name
  const detectedDevice = device_name || detectDevice(userAgent);

  try {
    const [rows] = await pool.query<any[]>(
      'SELECT v.*, r.room_number FROM vouchers v LEFT JOIN rooms r ON v.room_id = r.id WHERE v.code = ? AND v.is_active = TRUE',
      [req.params.code]
    );
    const voucher = rows[0];
    if (!voucher) { res.status(404).json({ error: 'Voucher not found or inactive' }); return; }
    if (voucher.expires_at && new Date(voucher.expires_at) < new Date()) {
      res.status(410).json({ error: 'Voucher has expired' }); return;
    }
    // Valid voucher — reset rate limit counter for this IP
    clearRate(rateKey);

    // CRITICAL: Enforce device-per-room constraint
    // Check if this device (by IP) already has an active session in a DIFFERENT room
    if (clientIp && voucher.room_id) {
      const [conflictRows] = await pool.query<any[]>(
        `SELECT s.id, v.room_id, r.room_number
         FROM sessions s
         JOIN vouchers v ON s.voucher_id = v.id
         LEFT JOIN rooms r ON v.room_id = r.id
         WHERE s.ip_address = ? AND s.is_active = TRUE AND v.room_id != ? AND v.room_id IS NOT NULL
         LIMIT 1`,
        [clientIp, voucher.room_id]
      );

      if (conflictRows[0]) {
        res.status(409).json({
          error: `This device is already connected in Room ${conflictRows[0].room_number}. A device cannot be active in multiple rooms simultaneously. Please disconnect from the other room first.`,
          conflictRoom: conflictRows[0].room_number,
        });
        return;
      }
    }

    // Check device limit — but allow reconnect from same IP
    const [deviceRows] = await pool.query<any[]>(
      'SELECT COUNT(*) AS count FROM sessions WHERE voucher_id = ? AND is_active = TRUE AND ip_address != ?',
      [voucher.id, clientIp]
    );
    // Also check if this IP already has an active session for this voucher (reconnect)
    const [existingRows] = await pool.query<any[]>(
      'SELECT * FROM sessions WHERE voucher_id = ? AND is_active = TRUE AND ip_address = ? LIMIT 1',
      [voucher.id, clientIp]
    );

    if (existingRows[0]) {
      // Same device reconnecting — return existing session
      const existing = existingRows[0];
      let reconnectVapLabel: string | null = null;
      if (existing.vap_id) {
        const [vapInfo] = await pool.query<any[]>('SELECT vlan_id FROM vaps WHERE id = ?', [existing.vap_id]);
        if (vapInfo[0]) reconnectVapLabel = `VAP-${vapInfo[0].vlan_id}`;
      }
      res.status(200).json({
        sessionId: existing.id,
        message: 'Reconnected successfully',
        room_number: voucher.room_number,
        expires_at: voucher.expires_at,
        vap_id: existing.vap_id,
        vap_label: reconnectVapLabel,
        device_name: existing.device_name,
        device_mac: existing.device_mac,
        ip_address: clientIp,
        reconnected: true,
      });
      return;
    }

    if (deviceRows[0].count >= voucher.max_devices) {
      res.status(403).json({ error: 'Maximum device limit reached for this voucher' }); return;
    }

    // Activate voucher on first use
    let expiresAt = voucher.expires_at;
    if (!voucher.is_used) {
      expiresAt = new Date();
      (expiresAt as Date).setHours((expiresAt as Date).getHours() + voucher.duration_hours);
      await pool.query(
        'UPDATE vouchers SET is_used = TRUE, activated_at = NOW(), expires_at = ? WHERE id = ?',
        [expiresAt, voucher.id]
      );
    }

    // Get VAP for this room
    let vapId: number | null = null;
    if (voucher.room_id) {
      const [vapRows] = await pool.query<any[]>('SELECT id FROM vaps WHERE room_id = ?', [voucher.room_id]);
      if (vapRows[0]) vapId = vapRows[0].id;
    }

    // Create session
    const deviceMac = randomMac();
    const [sessionResult] = await pool.query<any>(
      'INSERT INTO sessions (voucher_id, device_name, device_mac, ip_address, user_agent, vap_id) VALUES (?, ?, ?, ?, ?, ?)',
      [voucher.id, detectedDevice, deviceMac, clientIp, userAgent, vapId]
    );

    const sessionId = sessionResult.insertId;

    // Allow guest IP through MikroTik firewall after successful activation
    if (clientIp) {
      await mikrotikAllowGuest(clientIp, sessionId, voucher.room_number ?? 'unknown', voucher.duration_hours);
    }

    // Assign switch port to room VLAN (bridge VLAN filtering on CRS/CSS)
    if (voucher.room_number) {
      const vlanId = parseInt(voucher.room_number);
      if (!isNaN(vlanId)) {
        await mikrotikAssignPortVlan(voucher.room_number, vlanId, sessionId);
      }
    }

    // Emit real-time event to admin dashboard
    io.emit('session:new', {
      sessionId,
      voucher_code: voucher.code,
      room_number: voucher.room_number,
      device_name: detectedDevice,
      device_mac: deviceMac,
      ip_address: clientIp,
      vap_id: vapId,
      connected_at: new Date(),
    });

    // Fetch VAP VLAN label if available
    let vapLabel: string | null = null;
    if (vapId) {
      const [vapInfo] = await pool.query<any[]>('SELECT vlan_id FROM vaps WHERE id = ?', [vapId]);
      if (vapInfo[0]) vapLabel = `VAP-${vapInfo[0].vlan_id}`;
    }

    res.status(201).json({
      sessionId,
      message: 'Connected successfully',
      room_number: voucher.room_number,
      expires_at: expiresAt,
      vap_id: vapId,
      vap_label: vapLabel,
      device_name: detectedDevice,
      device_mac: deviceMac,
      ip_address: clientIp,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to activate voucher' });
  }
});

// PATCH /api/vouchers/:id/extend  (admin — add more hours to a voucher)
router.patch('/:id/extend', authenticate, async (req: AuthRequest, res: Response): Promise<void> => {
  const { hours } = req.body;
  if (!hours || isNaN(hours) || hours < 1) {
    res.status(400).json({ error: 'hours must be a positive number' }); return;
  }
  try {
    const [rows] = await pool.query<any[]>('SELECT * FROM vouchers WHERE id = ?', [req.params.id]);
    const voucher = rows[0];
    if (!voucher) { res.status(404).json({ error: 'Voucher not found' }); return; }

    // If voucher has been activated, extend from current expires_at
    // If not yet activated, extend the duration_hours instead
    if (voucher.expires_at) {
      const newExpiry = new Date(voucher.expires_at);
      newExpiry.setHours(newExpiry.getHours() + parseInt(hours));
      await pool.query(
        'UPDATE vouchers SET expires_at = ?, duration_hours = duration_hours + ?, is_active = TRUE WHERE id = ?',
        [newExpiry, hours, req.params.id]
      );
      await logAction(req.admin!.username, 'EXTEND_VOUCHER', `Voucher ID ${req.params.id} extended by ${hours}h — new expiry: ${newExpiry.toISOString()}`, req.ip);
      res.json({ message: `Voucher extended by ${hours} hour(s)`, expires_at: newExpiry });
    } else {
      // Not yet activated — just increase duration
      await pool.query(
        'UPDATE vouchers SET duration_hours = duration_hours + ? WHERE id = ?',
        [hours, req.params.id]
      );
      await logAction(req.admin!.username, 'EXTEND_VOUCHER', `Voucher ID ${req.params.id} duration increased by ${hours}h`, req.ip);
      res.json({ message: `Voucher duration increased by ${hours} hour(s)` });
    }
  } catch {
    res.status(500).json({ error: 'Failed to extend voucher' });
  }
});

// DELETE /api/vouchers/:id  (admin — deactivate)
router.delete('/:id', authenticate, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    // 1. Deactivate the voucher
    await pool.query('UPDATE vouchers SET is_active = FALSE WHERE id = ?', [req.params.id]);

    // 2. Close all active sessions tied to this voucher
    const [activeSessions] = await pool.query<any[]>(
      'SELECT id, ip_address FROM sessions WHERE voucher_id = ? AND is_active = TRUE',
      [req.params.id]
    );
    if (activeSessions.length > 0) {
      await pool.query(
        'UPDATE sessions SET is_active = FALSE, disconnected_at = NOW() WHERE voucher_id = ? AND is_active = TRUE',
        [req.params.id]
      );
      // Remove each session's IP from MikroTik and notify guest portal
      for (const session of activeSessions) {
        if (session.ip_address) {
          await mikrotikRemoveGuestByIp(session.ip_address);
        }
        io.emit('session:disconnected', { sessionId: session.id, reason: 'voucher_deactivated' });
      }
    }

    res.json({ message: 'Voucher deactivated', sessions_closed: activeSessions.length });
  } catch {
    res.status(500).json({ error: 'Failed to deactivate voucher' });
  }
});

// DELETE /api/vouchers/:id/delete  (admin — hard delete inactive voucher)
router.delete('/:id/delete', authenticate, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const [rows] = await pool.query<any[]>('SELECT is_active FROM vouchers WHERE id = ?', [req.params.id]);
    const voucher = rows[0];
    if (!voucher) { res.status(404).json({ error: 'Voucher not found' }); return; }
    if (voucher.is_active) { res.status(400).json({ error: 'Cannot delete an active voucher. Deactivate it first.' }); return; }
    await pool.query('DELETE FROM vouchers WHERE id = ?', [req.params.id]);
    await logAction(req.admin!.username, 'DELETE_VOUCHER', `Deleted voucher ID ${req.params.id}`, req.ip);
    res.json({ message: 'Voucher deleted' });
  } catch {
    res.status(500).json({ error: 'Failed to delete voucher' });
  }
});

export default router;
