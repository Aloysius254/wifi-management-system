import { Router, Request, Response } from 'express';
import { nanoid } from 'nanoid';
import pool from '../db';
import { authenticate, AuthRequest } from '../middleware/auth';
import { io } from '../index';
import { sendVoucherSMS } from '../sms';

const router = Router();

// GET /api/vouchers  (admin)
router.get('/', authenticate, async (_req: AuthRequest, res: Response): Promise<void> => {
  try {
    const [rows] = await pool.query(`
      SELECT v.*, r.room_number,
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
  const clientIp = ip_address || req.ip || null;
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
      res.status(200).json({
        sessionId: existing.id,
        message: 'Reconnected successfully',
        room_number: voucher.room_number,
        expires_at: voucher.expires_at,
        vap_id: existing.vap_id,
        device_name: existing.device_name,
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
    const [sessionResult] = await pool.query<any>(
      'INSERT INTO sessions (voucher_id, device_name, ip_address, user_agent, vap_id) VALUES (?, ?, ?, ?, ?)',
      [voucher.id, detectedDevice, clientIp, userAgent, vapId]
    );

    const sessionId = sessionResult.insertId;

    // Emit real-time event to admin dashboard
    io.emit('session:new', {
      sessionId,
      voucher_code: voucher.code,
      room_number: voucher.room_number,
      device_name: detectedDevice,
      ip_address: clientIp,
      vap_id: vapId,
      connected_at: new Date(),
    });

    res.status(201).json({
      sessionId,
      message: 'Connected successfully',
      room_number: voucher.room_number,
      expires_at: expiresAt,
      vap_id: vapId,
      device_name: detectedDevice,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to activate voucher' });
  }
});

// DELETE /api/vouchers/:id  (admin)
router.delete('/:id', authenticate, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    await pool.query('UPDATE vouchers SET is_active = FALSE WHERE id = ?', [req.params.id]);
    res.json({ message: 'Voucher deactivated' });
  } catch {
    res.status(500).json({ error: 'Failed to deactivate voucher' });
  }
});

export default router;
