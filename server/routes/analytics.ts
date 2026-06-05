import { Router, Response } from 'express';
import pool from '../db';
import { authenticate, AuthRequest } from '../middleware/auth';

const router = Router();
router.use(authenticate);

// Each bandwidth log sample = 1 reading per 60-second interval
// Convert Mbps → GB: usage_mbps × 60s ÷ 8 (bits→bytes) ÷ 1024² (bytes→GB)
// Simplified: usage_mbps × 60 / 8388608 per sample
const MBPS_TO_GB_PER_SAMPLE = 60 / 8388608;

// GET /api/analytics/summary — per-room bandwidth stats + global totals
router.get('/summary', async (_req: AuthRequest, res: Response): Promise<void> => {
  try {
    const [rooms] = await pool.query(`
      SELECT r.id AS room_id, r.room_number,
        COUNT(DISTINCT s.id)                                                        AS total_sessions,
        COALESCE(ROUND(SUM(bl.usage_mbps) * ${MBPS_TO_GB_PER_SAMPLE}, 4), 0)       AS total_gb,
        COALESCE(ROUND(AVG(bl.usage_mbps), 2), 0)                                  AS avg_mbps,
        COALESCE(ROUND(MAX(bl.usage_mbps), 2), 0)                                  AS peak_mbps,
        COALESCE(SUM(CASE WHEN s.is_throttled THEN 1 ELSE 0 END), 0)               AS throttle_events
      FROM rooms r
      LEFT JOIN vouchers v  ON v.room_id    = r.id
      LEFT JOIN sessions s  ON s.voucher_id = v.id
      LEFT JOIN bandwidth_logs bl ON bl.session_id = s.id
      GROUP BY r.id, r.room_number
      ORDER BY total_gb DESC
    `);

    const [totals] = await pool.query<any[]>(`
      SELECT
        COUNT(DISTINCT s.id)                                                    AS total_sessions,
        COALESCE(ROUND(SUM(bl.usage_mbps) * ${MBPS_TO_GB_PER_SAMPLE}, 4), 0)   AS total_gb,
        COALESCE(ROUND(MAX(bl.usage_mbps), 2), 0)                              AS peak_mbps,
        COALESCE(COUNT(bl.id), 0)                                              AS log_entries
      FROM sessions s
      LEFT JOIN bandwidth_logs bl ON bl.session_id = s.id
    `);

    res.json({ rooms, totals: (totals as any[])[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch analytics' });
  }
});

// GET /api/analytics/session-bw?session_id=X&limit=30
router.get('/session-bw', async (req: AuthRequest, res: Response): Promise<void> => {
  const { session_id, limit = '30' } = req.query;
  if (!session_id) { res.status(400).json({ error: 'session_id required' }); return; }
  try {
    const [rows] = await pool.query<any[]>(
      `SELECT usage_mbps, logged_at FROM bandwidth_logs
       WHERE session_id = ? ORDER BY id DESC LIMIT ?`,
      [session_id, parseInt(limit as string)]
    );
    res.json((rows as any[]).reverse());
  } catch {
    res.status(500).json({ error: 'Failed to fetch session bandwidth' });
  }
});

export default router;
