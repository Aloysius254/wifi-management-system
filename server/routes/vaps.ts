import { Router, Response } from 'express';
import pool from '../db';
import { authenticate, AuthRequest } from '../middleware/auth';

const router = Router();
router.use(authenticate);

// GET /api/vaps — all VAPs with room info
router.get('/', async (_req: AuthRequest, res: Response): Promise<void> => {
  try {
    const [rows] = await pool.query(`
      SELECT vap.*, r.room_number, r.floor,
        (SELECT COUNT(*) FROM sessions s
         JOIN vouchers v ON s.voucher_id = v.id
         WHERE v.room_id = vap.room_id AND s.is_active = TRUE) AS active_devices,
        (SELECT COUNT(*) FROM sessions s
         JOIN vouchers v ON s.voucher_id = v.id
         WHERE v.room_id = vap.room_id AND s.is_throttled = TRUE AND s.is_active = TRUE) AS throttled_devices
      FROM vaps vap
      JOIN rooms r ON vap.room_id = r.id
      ORDER BY r.floor, r.room_number
    `);
    res.json(rows);
  } catch {
    res.status(500).json({ error: 'Failed to fetch VAPs' });
  }
});

// PATCH /api/vaps/:id — update bandwidth limits
router.patch('/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  const { bandwidth_limit_mbps, throttle_threshold_mbps, is_isolated } = req.body;
  try {
    await pool.query(
      `UPDATE vaps SET
        bandwidth_limit_mbps = COALESCE(?, bandwidth_limit_mbps),
        throttle_threshold_mbps = COALESCE(?, throttle_threshold_mbps),
        is_isolated = COALESCE(?, is_isolated)
       WHERE id = ?`,
      [bandwidth_limit_mbps ?? null, throttle_threshold_mbps ?? null, is_isolated ?? null, req.params.id]
    );
    res.json({ message: 'VAP updated' });
  } catch {
    res.status(500).json({ error: 'Failed to update VAP' });
  }
});

export default router;
