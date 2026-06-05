import { Router, Response } from 'express';
import pool from '../db';
import { authenticate, AuthRequest } from '../middleware/auth';

const router = Router();
router.use(authenticate);

router.get('/', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const [me] = await pool.query<any[]>('SELECT role FROM admins WHERE id = ?', [req.admin?.adminId]);
    if (me[0]?.role !== 'manager') { res.status(403).json({ error: 'Manager access required' }); return; }
    const [rows] = await pool.query(
      'SELECT * FROM audit_logs ORDER BY occurred_at DESC LIMIT 1000'
    );
    res.json(rows);
  } catch {
    res.status(500).json({ error: 'Failed to fetch audit log' });
  }
});

export default router;
