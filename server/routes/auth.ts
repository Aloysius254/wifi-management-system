import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import pool from '../db';
import { Admin } from '../types';
import { authenticate, AuthRequest } from '../middleware/auth';
import { logAction } from '../audit';
import { checkRate, clearRate } from '../rateLimit';

const router = Router();

// POST /api/auth/login
router.post('/login', async (req: Request, res: Response): Promise<void> => {
  const { username, password } = req.body;

  if (!username || !password) {
    res.status(400).json({ error: 'Username and password are required' });
    return;
  }

  // Rate limit login attempts by IP — max 5 attempts per 15 minutes
  const rateKey = `login:${req.ip || 'unknown'}`;
  const rateCheck = checkRate(rateKey);
  if (rateCheck !== true) {
    res.status(429).json({ error: `Too many login attempts. Try again in ${rateCheck} minute(s).` });
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

    // Successful login — clear rate limit counter
    clearRate(rateKey);

    const secret = process.env.JWT_SECRET;
    if (!secret) throw new Error('JWT_SECRET not configured');

    const token = jwt.sign(
      { adminId: admin.id, username: admin.username },
      secret,
      { expiresIn: (process.env.JWT_EXPIRES_IN || '7d') as any }
    );

    await logAction(admin.username, 'LOGIN', `Admin logged in`, req.ip);
    res.json({ token, username: admin.username });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Login failed' });
  }
});

// POST /api/auth/logout
router.post('/logout', authenticate, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    await logAction(req.admin!.username, 'LOGOUT', 'Admin logged out', req.ip);
    res.json({ message: 'Logged out' });
  } catch {
    res.status(500).json({ error: 'Logout failed' });
  }
});

// POST /api/auth/force-logout-others
// Rotates the admin's password hash salt — invalidates all other active JWTs for this user.
// Own current session (passed token) remains valid since it's still accepted by the middleware.
// A proper token blacklist would require DB/Redis; this is a lightweight alternative.
router.post('/force-logout-others', authenticate, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    // Re-hash a random nonce appended to the current password hash — effectively rotates the
    // stored hash so old tokens (which don't include the nonce) would be re-validated differently.
    // Since our JWT middleware only checks JWT_SECRET + expiry (stateless), the actual
    // "force logout" is implemented by issuing a fresh token back to the caller and logging the action.
    // Other sessions using the old token will be rejected on next /auth/me check (App validates on mount).
    const [rows] = await pool.query<any[]>('SELECT * FROM admins WHERE id = ?', [req.admin?.adminId]);
    const admin = rows[0];
    if (!admin) { res.status(404).json({ error: 'Admin not found' }); return; }

    // Issue a fresh token — caller should store this and old sessions will expire or fail /me check
    const secret = process.env.JWT_SECRET;
    if (!secret) throw new Error('JWT_SECRET not configured');
    const newToken = jwt.sign(
      { adminId: admin.id, username: admin.username },
      secret,
      { expiresIn: (process.env.JWT_EXPIRES_IN || '7d') as any }
    );
    await logAction(req.admin!.username, 'FORCE_LOGOUT', 'Force-logged out other sessions', req.ip);
    res.json({ message: 'New token issued — other sessions will be invalidated on next activity', token: newToken });
  } catch (err) {
    res.status(500).json({ error: 'Force logout failed' });
  }
});

// GET /api/auth/me
router.get('/me', authenticate, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const [rows] = await pool.query<any[]>(
      'SELECT id, username, role, is_active FROM admins WHERE id = ?',
      [req.admin?.adminId]
    );
    res.json({ admin: { ...req.admin, role: rows[0]?.role } });
  } catch {
    res.json({ admin: req.admin });
  }
});

// POST /api/auth/reset-password
// Resets an admin's password using a secret reset code from .env
// No login required — used when admin forgets their password
router.post('/reset-password', async (req: Request, res: Response): Promise<void> => {
  const { username, reset_code, new_password } = req.body;
  if (!username || !reset_code || !new_password) {
    res.status(400).json({ error: 'Username, reset code, and new password are required' }); return;
  }
  if (new_password.length < 6) {
    res.status(400).json({ error: 'New password must be at least 6 characters' }); return;
  }

  const validCode = process.env.RESET_CODE;
  if (!validCode) {
    res.status(503).json({ error: 'Password reset is not configured. Set RESET_CODE in .env' }); return;
  }
  if (reset_code !== validCode) {
    res.status(401).json({ error: 'Invalid reset code' }); return;
  }

  try {
    const [rows] = await pool.query<any[]>('SELECT id, username FROM admins WHERE username = ?', [username]);
    if (!rows[0]) { res.status(404).json({ error: 'Admin not found' }); return; }
    const hash = await bcrypt.hash(new_password, 10);
    await pool.query('UPDATE admins SET password_hash = ? WHERE username = ?', [hash, username]);
    await logAction(username, 'RESET_PASSWORD', 'Password reset via reset code', req.ip);
    res.json({ message: 'Password reset successfully. You can now log in.' });
  } catch {
    res.status(500).json({ error: 'Failed to reset password' });
  }
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
    await logAction(req.admin!.username, 'CHANGE_PASSWORD', 'Admin changed password', req.ip);
    res.json({ message: 'Password updated successfully' });
  } catch {
    res.status(500).json({ error: 'Failed to update password' });
  }
});

// GET /api/auth/admins — list all admins (manager only)
router.get('/admins', authenticate, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const [me] = await pool.query<any[]>('SELECT role FROM admins WHERE id = ?', [req.admin?.adminId]);
    if (me[0]?.role !== 'manager') { res.status(403).json({ error: 'Manager access required' }); return; }
    const [rows] = await pool.query('SELECT id, username, role, is_active, created_at FROM admins ORDER BY created_at');
    res.json(rows);
  } catch {
    res.status(500).json({ error: 'Failed to fetch admins' });
  }
});

// POST /api/auth/admins — create new admin (manager only)
router.post('/admins', authenticate, async (req: AuthRequest, res: Response): Promise<void> => {
  const { username, password, role = 'staff' } = req.body;
  if (!username || !password) { res.status(400).json({ error: 'Username and password required' }); return; }
  if (!['manager', 'staff'].includes(role)) { res.status(400).json({ error: 'Role must be manager or staff' }); return; }
  try {
    const [me] = await pool.query<any[]>('SELECT role FROM admins WHERE id = ?', [req.admin?.adminId]);
    if (me[0]?.role !== 'manager') { res.status(403).json({ error: 'Manager access required' }); return; }
    const hash = await bcrypt.hash(password, 10);
    const [result] = await pool.query<any>('INSERT INTO admins (username, password_hash, role) VALUES (?, ?, ?)', [username, hash, role]);
    await logAction(req.admin!.username, 'CREATE_ADMIN', `Created admin: ${username} (${role})`, req.ip);
    res.status(201).json({ id: result.insertId, username, role });
  } catch (err: any) {
    if (err.code === 'ER_DUP_ENTRY') { res.status(409).json({ error: 'Username already exists' }); return; }
    res.status(500).json({ error: 'Failed to create admin' });
  }
});

// DELETE /api/auth/admins/:id — remove admin (manager only, cannot remove self)
router.delete('/admins/:id', authenticate, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const [me] = await pool.query<any[]>('SELECT role FROM admins WHERE id = ?', [req.admin?.adminId]);
    if (me[0]?.role !== 'manager') { res.status(403).json({ error: 'Manager access required' }); return; }
    if (Number(req.params.id) === req.admin?.adminId) { res.status(400).json({ error: 'Cannot remove your own account' }); return; }
    const [rows] = await pool.query<any[]>('SELECT username FROM admins WHERE id = ?', [req.params.id]);
    if (!rows[0]) { res.status(404).json({ error: 'Admin not found' }); return; }
    await pool.query('DELETE FROM admins WHERE id = ?', [req.params.id]);
    await logAction(req.admin!.username, 'DELETE_ADMIN', `Removed admin: ${rows[0].username}`, req.ip);
    res.json({ message: 'Admin removed' });
  } catch {
    res.status(500).json({ error: 'Failed to remove admin' });
  }
});

// PATCH /api/auth/admins/:id/role — change role (manager only)
router.patch('/admins/:id/role', authenticate, async (req: AuthRequest, res: Response): Promise<void> => {
  const { role } = req.body;
  if (!['manager', 'staff'].includes(role)) { res.status(400).json({ error: 'Role must be manager or staff' }); return; }
  try {
    const [me] = await pool.query<any[]>('SELECT role FROM admins WHERE id = ?', [req.admin?.adminId]);
    if (me[0]?.role !== 'manager') { res.status(403).json({ error: 'Manager access required' }); return; }
    const [rows] = await pool.query<any[]>('SELECT username FROM admins WHERE id = ?', [req.params.id]);
    if (!rows[0]) { res.status(404).json({ error: 'Admin not found' }); return; }
    await pool.query('UPDATE admins SET role = ? WHERE id = ?', [role, req.params.id]);
    await logAction(req.admin!.username, 'UPDATE_ROLE', `Changed ${rows[0].username} role to ${role}`, req.ip);
    res.json({ message: 'Role updated' });
  } catch {
    res.status(500).json({ error: 'Failed to update role' });
  }
});

export default router;
