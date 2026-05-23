import pool from './db';

export async function logAction(
  username: string,
  action: string,
  details: string,
  ip?: string | null
): Promise<void> {
  try {
    await pool.query(
      'INSERT INTO audit_logs (admin_username, action, details, ip_address) VALUES (?, ?, ?, ?)',
      [username, action, details, ip ?? null]
    );
  } catch (err) {
    console.error('[Audit] Failed to log:', err);
  }
}
