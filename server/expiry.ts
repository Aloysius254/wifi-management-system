import pool from './db';
import { io } from './index';

// Retention settings — configure in .env
// VOUCHER_CLEANUP_HOURS   — how long to keep inactive vouchers (default: 48h)
// SESSION_HISTORY_DAYS    — how long to keep ended session history (default: 30 days)
// BANDWIDTH_LOG_DAYS      — how long to keep bandwidth logs (default: 7 days)
// AUDIT_LOG_DAYS          — how long to keep audit logs (default: 90 days)
// ISOLATION_EVENT_DAYS    — how long to keep isolation events (default: 30 days)

const CLEANUP_HOURS       = parseInt(process.env.VOUCHER_CLEANUP_HOURS  || '48',  10);
const SESSION_HISTORY_DAYS= parseInt(process.env.SESSION_HISTORY_DAYS   || '30',  10);
const BANDWIDTH_LOG_DAYS  = parseInt(process.env.BANDWIDTH_LOG_DAYS     || '7',   10);
const AUDIT_LOG_DAYS      = parseInt(process.env.AUDIT_LOG_DAYS         || '90',  10);
const ISOLATION_EVENT_DAYS= parseInt(process.env.ISOLATION_EVENT_DAYS   || '30',  10);

// Runs every 60 seconds — expires vouchers, disconnects sessions, and cleans up old data
export function startExpiryJob() {
  console.log('[Expiry] Auto-expiry job started');
  console.log(`[Expiry] Retention policy:`);
  console.log(`  Inactive vouchers  → deleted after ${CLEANUP_HOURS}h`);
  console.log(`  Session history    → deleted after ${SESSION_HISTORY_DAYS} days`);
  console.log(`  Bandwidth logs     → deleted after ${BANDWIDTH_LOG_DAYS} days`);
  console.log(`  Audit logs         → deleted after ${AUDIT_LOG_DAYS} days`);
  console.log(`  Isolation events   → deleted after ${ISOLATION_EVENT_DAYS} days`);

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

      // 3. Auto-delete inactive vouchers older than CLEANUP_HOURS
      const [deletedVouchers] = await pool.query<any>(`
        DELETE v FROM vouchers v
        WHERE v.is_active = FALSE
          AND NOT EXISTS (
            SELECT 1 FROM sessions s
            WHERE s.voucher_id = v.id AND s.is_active = TRUE
          )
          AND (
            (v.is_used = FALSE AND v.created_at < DATE_SUB(NOW(), INTERVAL ? HOUR))
            OR
            (v.expires_at IS NOT NULL AND v.expires_at < DATE_SUB(NOW(), INTERVAL ? HOUR))
          )
      `, [CLEANUP_HOURS, CLEANUP_HOURS]);
      if (deletedVouchers.affectedRows > 0) {
        console.log(`[Expiry] Auto-deleted ${deletedVouchers.affectedRows} old inactive voucher(s)`);
        io.emit('vouchers:updated');
      }

      // 4. Delete old ended session history
      const [deletedSessions] = await pool.query<any>(
        `DELETE FROM sessions
         WHERE is_active = FALSE
           AND disconnected_at IS NOT NULL
           AND disconnected_at < DATE_SUB(NOW(), INTERVAL ? DAY)`,
        [SESSION_HISTORY_DAYS]
      );
      if (deletedSessions.affectedRows > 0) {
        console.log(`[Cleanup] Deleted ${deletedSessions.affectedRows} old session record(s) (>${SESSION_HISTORY_DAYS} days)`);
      }

      // 5. Delete old bandwidth logs
      const [deletedBW] = await pool.query<any>(
        `DELETE FROM bandwidth_logs
         WHERE logged_at < DATE_SUB(NOW(), INTERVAL ? DAY)`,
        [BANDWIDTH_LOG_DAYS]
      );
      if (deletedBW.affectedRows > 0) {
        console.log(`[Cleanup] Deleted ${deletedBW.affectedRows} old bandwidth log(s) (>${BANDWIDTH_LOG_DAYS} days)`);
      }

      // 6. Delete old audit logs
      const [deletedAudit] = await pool.query<any>(
        `DELETE FROM audit_logs
         WHERE occurred_at < DATE_SUB(NOW(), INTERVAL ? DAY)`,
        [AUDIT_LOG_DAYS]
      );
      if (deletedAudit.affectedRows > 0) {
        console.log(`[Cleanup] Deleted ${deletedAudit.affectedRows} old audit log(s) (>${AUDIT_LOG_DAYS} days)`);
      }

      // 7. Delete old isolation events
      const [deletedIso] = await pool.query<any>(
        `DELETE FROM isolation_events
         WHERE occurred_at < DATE_SUB(NOW(), INTERVAL ? DAY)`,
        [ISOLATION_EVENT_DAYS]
      );
      if (deletedIso.affectedRows > 0) {
        console.log(`[Cleanup] Deleted ${deletedIso.affectedRows} old isolation event(s) (>${ISOLATION_EVENT_DAYS} days)`);
      }

    } catch (err) {
      console.error('[Expiry] Error:', err);
    }
  }, 60_000);
}
