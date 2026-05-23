import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import pool from '../db';
import { Admin } from '../types';
import { authenticate, AuthRequest } from '../middleware/auth';

const router = Router();

// POST /api/auth/login
router.post('/login', async (req: Request, res: Response): Promise<void> => {
  const { username, password } = req.body;

  if (!username || !password) {
    res.status(400).json({ error: 'Username and password are required' });
    return;
  }

  try {
    const [rows] = await pool.query<any[]>(
      'SELECT * FROM admins WHERE username = ?',
      [username]
    );

    const admin = rows[0] as Admin | undefined;
    if (!admin) {
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }

    const valid = await bcrypt.compare(password, admin.password_hash);
    if (!valid) {
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }

    const secret = process.env.JWT_SECRET;
    if (!secret) throw new Error('JWT_SECRET not configured');

    const token = jwt.sign(
      { adminId: admin.id, username: admin.username },
      secret,
      { expiresIn: (process.env.JWT_EXPIRES_IN || '7d') as any }
    );

    res.json({ token, username: admin.username });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Login failed' });
  }
});

// GET /api/auth/me
router.get('/me', authenticate, (req: AuthRequest, res: Response) => {
  res.json({ admin: req.admin });
});

// POST /api/auth/change-password
router.post('/change-password', authenticate, async (req: AuthRequest, res: Response): Promise<void> => {
  const { current_password, new_password } = req.body;
  if (!current_password || !new_password) {
    res.status(400).json({ error: 'Both current and new password are required' }); return;
  }
  try {
    const [rows] = await pool.query<any[]>('SELECT * FROM admins WHERE id = ?', [req.admin?.adminId]);
    const admin = rows[0];
    if (!admin) { res.status(404).json({ error: 'Admin not found' }); return; }
    const valid = await bcrypt.compare(current_password, admin.password_hash);
    if (!valid) { res.status(401).json({ error: 'Current password is incorrect' }); return; }
    const hash = await bcrypt.hash(new_password, 10);
    await pool.query('UPDATE admins SET password_hash = ? WHERE id = ?', [hash, admin.id]);
    res.json({ message: 'Password updated successfully' });
  } catch {
    res.status(500).json({ error: 'Failed to update password' });
  }
});

export default router;
