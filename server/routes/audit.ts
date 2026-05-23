import { Router, Response } from 'express';
import pool from '../db';
import { authenticate, AuthRequest } from '../middleware/auth';

const router = Router();
router.use(authenticate);

router.get('/', async (_req: AuthRequest, res: Response): Promise<void> => {
  try {
    const [rows] = await pool.query(
      'SELECT * FROM audit_logs ORDER BY occurred_at DESC LIMIT 100'
    );
    res.json(rows);
  } catch {
    res.status(500).json({ error: 'Failed to fetch audit log' });
  }
});

export default router;
