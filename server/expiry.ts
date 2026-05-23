import pool from './db';
import { io } from './index';

// Runs every 60 seconds — expires vouchers and disconnects sessions
export function startExpiryJob() {
  console.log('[Expiry] Auto-expiry job started');

  setInterval(async () => {
    try {
      // 1. Find active sessions whose voucher has expired
      const [expiredSessions] = await pool.query<any[]>(`
        SELECT s.id, s.voucher_id, v.code, r.room_number
        FROM sessions s
        JOIN vouchers v ON s.voucher_id = v.id
        LEFT JOIN rooms r ON v.room_id = r.id
        WHERE s.is_active = TRUE
          AND v.expires_at IS NOT NULL
          AND v.expires_at < NOW()
      `);

      for (const session of expiredSessions) {
        await pool.query(
          'UPDATE sessions SET is_active = FALSE, disconnected_at = NOW() WHERE id = ?',
          [session.id]
        );
        io.emit('session:disconnected', { sessionId: session.id, reason: 'expired' });
        io.emit('session:expired', {
          sessionId: session.id,
          voucher_code: session.code,
          room_number: session.room_number,
        });
        console.log(`[Expiry] Session #${session.id} expired (voucher: ${session.code})`);
      }

      // 2. Deactivate expired vouchers
      const [result] = await pool.query<any>(
        `UPDATE vouchers SET is_active = FALSE
         WHERE is_active = TRUE
           AND expires_at IS NOT NULL
           AND expires_at < NOW()`
      );

      if (result.affectedRows > 0) {
        console.log(`[Expiry] Deactivated ${result.affectedRows} expired voucher(s)`);
        io.emit('vouchers:updated');
      }

    } catch (err) {
      console.error('[Expiry] Error:', err);
    }
  }, 60_000);
}
