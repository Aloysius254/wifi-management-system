import pool from './db';
import { io } from './index';
import { mikrotikRemoveGuestByIp, mikrotikReleasePortVlan, mikrotikFlushConntrack } from './mikrotik';
import { mikrotikRemoveThrottleQueue } from './bandwidth';

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

// ── DHCP presence detection ───────────────────────────────────────────────────
// Tracks consecutive misses per session IP before closing the session.
// Requires 2 consecutive DHCP misses (~60s apart) to avoid false positives
// from brief WiFi drops or DHCP renewal gaps.
const dhcpMissCount = new Map<string, number>(); // ip → consecutive miss count
const DHCP_MISS_THRESHOLD = 2;

async function checkDhcpPresence(): Promise<void> {
  if (!process.env.MIKROTIK_HOST) return;
  try {
    const MT_BASE = `http://${process.env.MIKROTIK_HOST}/rest`;
    const MT_AUTH = 'Basic ' + Buffer.from(`${process.env.MIKROTIK_USER}:${process.env.MIKROTIK_PASS}`).toString('base64');

    // Use ARP table instead of DHCP leases — ARP entries expire within ~60s after
    // a device goes offline, whereas DHCP leases remain "bound" until the lease timer
    // expires even when the device is unreachable.
    // Only "reachable" or "stale" entries indicate a recently-seen device.
    // "incomplete", "failed", or absent entries mean the device is gone.
    const r = await fetch(`${MT_BASE}/ip/arp`, {
      headers: { Authorization: MT_AUTH },
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) return;

    const contentType = r.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) return; // router returned HTML error page

    const arpEntries: Array<{ address: string; status?: string; complete?: string }> =
      await r.json() as Array<{ address: string; status?: string; complete?: string }>;

    // Consider a device present if it has an ARP entry that is NOT failed/incomplete
    const presentIps = new Set(
      arpEntries
        .filter(e => e.status !== 'failed' && e.status !== 'incomplete' && e.complete !== 'false')
        .map(e => e.address)
    );

    // Get all active sessions with an IP
    const [activeSessions] = await pool.query<any[]>(
      `SELECT s.id, s.ip_address, r.room_number, vap.vlan_id
       FROM sessions s
       LEFT JOIN vouchers v ON s.voucher_id = v.id
       LEFT JOIN rooms r ON v.room_id = r.id
       LEFT JOIN vaps vap ON s.vap_id = vap.id
       WHERE s.is_active = TRUE AND s.ip_address IS NOT NULL`
    );

    for (const session of activeSessions) {
      const ip = session.ip_address?.replace(/^::ffff:/, '').trim();
      if (!ip) continue;

      if (presentIps.has(ip)) {
        // Device is present — reset miss counter
        dhcpMissCount.delete(ip);
      } else {
        // Device not in DHCP leases — increment miss counter
        const misses = (dhcpMissCount.get(ip) || 0) + 1;
        dhcpMissCount.set(ip, misses);

        if (misses >= DHCP_MISS_THRESHOLD) {
          // 2 consecutive misses — device has genuinely left
          dhcpMissCount.delete(ip);
          await pool.query(
            'UPDATE sessions SET is_active = FALSE, disconnected_at = NOW() WHERE id = ?',
            [session.id]
          );
          io.emit('session:disconnected', { sessionId: session.id, reason: 'offline' });
          console.log(`[Presence] Session #${session.id} (${ip}) closed — not in ARP table for ${DHCP_MISS_THRESHOLD} consecutive checks`);
          Promise.all([
            mikrotikRemoveGuestByIp(ip).then(() => mikrotikFlushConntrack(ip)),
            session.room_number && session.vlan_id
              ? mikrotikReleasePortVlan(session.room_number, session.vlan_id, session.id)
              : Promise.resolve(),
            mikrotikRemoveThrottleQueue(session.id),
          ]).catch(err => console.error(`[Presence] MikroTik cleanup error for #${session.id}:`, err));
        } else {
          console.log(`[Presence] Session #${session.id} (${ip}) — DHCP miss ${misses}/${DHCP_MISS_THRESHOLD} (waiting for confirmation)`);
        }
      }
    }

    // Clean up miss counters for IPs that no longer have active sessions
    const activeIps = new Set(activeSessions.map(s => s.ip_address?.replace(/^::ffff:/, '').trim()).filter(Boolean));
    for (const ip of dhcpMissCount.keys()) {
      if (!activeIps.has(ip)) dhcpMissCount.delete(ip);
    }
  } catch (e: any) {
    // Only log non-HTML errors (HTML = MikroTik returning login page, not a real error)
    if (!e.message?.includes('<!DOCTYPE') && !e.message?.includes('Unexpected token')) {
      console.log(`[Presence] ARP check skipped: ${e.message}`);
    }
  }
}

// Runs every 60 seconds — expires vouchers, disconnects sessions, and cleans up old data
export function startExpiryJob() {
  console.log('[Expiry] Auto-expiry job started');
  console.log(`[Expiry] Retention policy:`);
  console.log(`  Inactive vouchers  → deleted after ${CLEANUP_HOURS}h`);
  console.log(`  Session history    → deleted after ${SESSION_HISTORY_DAYS} days`);
  console.log(`  Bandwidth logs     → deleted after ${BANDWIDTH_LOG_DAYS} days`);
  console.log(`  Audit logs         → deleted after ${AUDIT_LOG_DAYS} days`);
  console.log(`  Isolation events   → deleted after ${ISOLATION_EVENT_DAYS} days`);

  // DHCP presence check runs every 30s — 2 consecutive misses = device offline
  if (process.env.MIKROTIK_HOST) {
    console.log('[Presence] ARP presence detection started (30s interval, 2-miss threshold)');
    setInterval(checkDhcpPresence, 30_000);
    // Run once immediately after a short delay to let the server settle
    setTimeout(checkDhcpPresence, 5_000);
  }

  setInterval(async () => {
    try {
      // 1. Find active sessions whose voucher has expired
      const [expiredSessions] = await pool.query<any[]>(`
        SELECT s.id, s.voucher_id, s.ip_address, v.code, r.room_number, vap.vlan_id
        FROM sessions s
        JOIN vouchers v ON s.voucher_id = v.id
        LEFT JOIN rooms r ON v.room_id = r.id
        LEFT JOIN vaps vap ON s.vap_id = vap.id
        WHERE s.is_active = TRUE
          AND v.expires_at IS NOT NULL
          AND v.expires_at < NOW()
      `);

      for (const session of expiredSessions) {
        await pool.query(
          'UPDATE sessions SET is_active = FALSE, disconnected_at = NOW() WHERE id = ?',
          [session.id]
        );
        // Emit immediately so portal updates right away
        io.emit('session:disconnected', { sessionId: session.id, reason: 'expired' });
        io.emit('session:expired', {
          sessionId: session.id,
          voucher_code: session.code,
          room_number: session.room_number,
        });
        console.log(`[Expiry] Session #${session.id} expired (voucher: ${session.code})`);
        // Run MikroTik cleanup in parallel — don't block the loop
        const ip = session.ip_address?.replace(/^::ffff:/, '').trim();
        Promise.all([
          ip ? mikrotikRemoveGuestByIp(ip).then(() => mikrotikFlushConntrack(ip)) : Promise.resolve(),
          session.room_number && session.vlan_id
            ? mikrotikReleasePortVlan(session.room_number, session.vlan_id, session.id)
            : Promise.resolve(),
          mikrotikRemoveThrottleQueue(session.id),
        ]).catch(err => console.error(`[Expiry] MikroTik error for session #${session.id}:`, err));
      }

      // 2. Close stale sessions — IPs no longer in MikroTik's allowed_guests
      //    (MikroTik auto-removed them when the timeout expired, but our DB still shows active)
      if (process.env.MIKROTIK_HOST) {
        try {
          const MT_BASE = `http://${process.env.MIKROTIK_HOST}/rest`;
          const MT_AUTH = 'Basic ' + Buffer.from(`${process.env.MIKROTIK_USER}:${process.env.MIKROTIK_PASS}`).toString('base64');
          const r = await fetch(`${MT_BASE}/ip/firewall/address-list?list=allowed_guests`, {
            headers: { Authorization: MT_AUTH },
            signal: AbortSignal.timeout(4000),
          });
          if (r.ok) {
            const allowed: Array<{ address: string }> = await r.json() as Array<{ address: string }>;
            const allowedIps = new Set(allowed.map(e => e.address));

            // Find active sessions whose IP is no longer in allowed_guests
            const [activeSessions] = await pool.query<any[]>(
              `SELECT s.id, s.ip_address, r.room_number, vap.vlan_id
               FROM sessions s
               LEFT JOIN vouchers v ON s.voucher_id = v.id
               LEFT JOIN rooms r ON v.room_id = r.id
               LEFT JOIN vaps vap ON s.vap_id = vap.id
               WHERE s.is_active = TRUE AND s.ip_address IS NOT NULL
                 AND (v.expires_at IS NULL OR v.expires_at > NOW())`
            );

            for (const session of activeSessions) {
              const ip = session.ip_address?.replace(/^::ffff:/, '').trim();
              if (ip && !allowedIps.has(ip)) {
                // IP was removed from MikroTik — close the session
                await pool.query(
                  'UPDATE sessions SET is_active = FALSE, disconnected_at = NOW() WHERE id = ?',
                  [session.id]
                );
                io.emit('session:disconnected', { sessionId: session.id, reason: 'expired' });
                console.log(`[Expiry] Session #${session.id} (${ip}) closed — no longer in MikroTik allowed_guests`);
                Promise.all([
                  mikrotikRemoveThrottleQueue(session.id),
                  session.room_number && session.vlan_id
                    ? mikrotikReleasePortVlan(session.room_number, session.vlan_id, session.id)
                    : Promise.resolve(),
                ]).catch(() => {});
              }
            }
          }
        } catch (e: any) {
          // Non-fatal — only log real errors, not HTML login page responses
          if (!e.message?.includes('<!DOCTYPE') && !e.message?.includes('Unexpected token')) {
            console.log(`[Expiry] Stale session check skipped: ${e.message}`);
          }
        }
      }

      // 3. Deactivate expired vouchers
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

      // 4. Auto-delete inactive vouchers older than CLEANUP_HOURS
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

      // 5. Delete old ended session history
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

      // 6. Delete old bandwidth logs
      const [deletedBW] = await pool.query<any>(
        `DELETE FROM bandwidth_logs
         WHERE logged_at < DATE_SUB(NOW(), INTERVAL ? DAY)`,
        [BANDWIDTH_LOG_DAYS]
      );
      if (deletedBW.affectedRows > 0) {
        console.log(`[Cleanup] Deleted ${deletedBW.affectedRows} old bandwidth log(s) (>${BANDWIDTH_LOG_DAYS} days)`);
      }

      // 7. Delete old audit logs
      const [deletedAudit] = await pool.query<any>(
        `DELETE FROM audit_logs
         WHERE occurred_at < DATE_SUB(NOW(), INTERVAL ? DAY)`,
        [AUDIT_LOG_DAYS]
      );
      if (deletedAudit.affectedRows > 0) {
        console.log(`[Cleanup] Deleted ${deletedAudit.affectedRows} old audit log(s) (>${AUDIT_LOG_DAYS} days)`);
      }

      // 8. Delete old isolation events
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
