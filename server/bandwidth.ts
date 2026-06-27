import pool from './db';
import { io } from './index';

// ── Bandwidth Simulation Job ──────────────────────────────────────────────────
//
// Runs every 60 seconds. For each active session it:
//   1. Generates a simulated Mbps reading (realistic random with occasional spikes)
//   2. Writes the reading to bandwidth_logs
//   3. Computes a rolling average over the last 5 samples
//   4. Compares average against the VAP's throttle_threshold_mbps
//   5. Sets / clears is_throttled on the session accordingly
//   6. Emits Socket.IO events so the admin dashboard updates in real time
//
// ── Replacing simulation with a real router later ────────────────────────────
// When you have a MikroTik / UniFi router, replace generateUsage() with a
// function that calls the router API using the session's device_mac address.
// Everything else (DB writes, throttle logic, socket events) stays the same.
// ─────────────────────────────────────────────────────────────────────────────

const INTERVAL_MS = 60_000; // run every 60 seconds

/**
 * Simulates a realistic bandwidth reading for one session.
 * Returns a value in Mbps between ~0.5 and ~14, with occasional heavy spikes.
 *
 * Replace this function body with a real router API call when you upgrade.
 * @param _deviceMac - MAC address of the device (used for real router lookup later)
 */
function generateUsage(_deviceMac: string): number {
  const roll = Math.random();

  if (roll < 0.10) {
    // 10% chance: heavy spike (streaming HD / large download) — 9–14 Mbps
    return parseFloat((9 + Math.random() * 5).toFixed(2));
  } else if (roll < 0.30) {
    // 20% chance: moderate usage — 4–9 Mbps
    return parseFloat((4 + Math.random() * 5).toFixed(2));
  } else if (roll < 0.70) {
    // 40% chance: normal browsing — 1–4 Mbps
    return parseFloat((1 + Math.random() * 3).toFixed(2));
  } else {
    // 30% chance: idle / low — 0.1–1 Mbps
    return parseFloat((0.1 + Math.random() * 0.9).toFixed(2));
  }
}

export function startBandwidthJob(): void {
  console.log('[Bandwidth] Simulation job started (60s interval)');
  console.log('[Bandwidth] Replace generateUsage() with router API when hardware is available');

  setInterval(async () => {
    try {
      // Fetch all active sessions with their VAP throttle threshold
      const [sessions] = await pool.query<any[]>(`
        SELECT s.id, s.device_mac, s.is_throttled,
               vap.throttle_threshold_mbps, vap.bandwidth_limit_mbps, vap.id AS vap_id,
               r.room_number
        FROM sessions s
        LEFT JOIN vaps vap ON s.vap_id = vap.id
        LEFT JOIN vouchers v ON s.voucher_id = v.id
        LEFT JOIN rooms r ON v.room_id = r.id
        WHERE s.is_active = TRUE
      `);

      if (sessions.length === 0) return;

      for (const session of sessions) {
        const usageMbps = generateUsage(session.device_mac || '');

        // 1. Write bandwidth sample
        await pool.query(
          'INSERT INTO bandwidth_logs (session_id, usage_mbps) VALUES (?, ?)',
          [session.id, usageMbps]
        );

        // 2. Compute rolling average of last 5 samples for this session
        const [avgRows] = await pool.query<any[]>(`
          SELECT AVG(usage_mbps) AS avg_mbps
          FROM (
            SELECT usage_mbps
            FROM bandwidth_logs
            WHERE session_id = ?
            ORDER BY id DESC
            LIMIT 5
          ) AS recent
        `, [session.id]);

        const avgMbps: number = parseFloat(avgRows[0]?.avg_mbps ?? 0);
        const threshold: number = session.throttle_threshold_mbps ?? 8;
        const shouldThrottle = avgMbps >= threshold;

        // 3. Update throttle flag only when state changes (avoids unnecessary writes)
        if (shouldThrottle !== Boolean(session.is_throttled)) {
          await pool.query(
            'UPDATE sessions SET is_throttled = ? WHERE id = ?',
            [shouldThrottle, session.id]
          );

          // 4. Emit real-time event to admin dashboard
          io.emit('session:throttle', {
            sessionId: session.id,
            is_throttled: shouldThrottle,
            avg_mbps: avgMbps,
            threshold,
            room_number: session.room_number,
          });

          console.log(
            `[Bandwidth] Session #${session.id} (${session.room_number}) ` +
            `${shouldThrottle ? '⚡ THROTTLED' : '✅ UNTHROTTLED'} ` +
            `— avg ${avgMbps.toFixed(2)} Mbps (threshold: ${threshold} Mbps)`
          );
        }

        // 5. Always emit live bandwidth update so dashboard shows current Mbps
        io.emit('session:bandwidth', {
          sessionId: session.id,
          usage_mbps: usageMbps,
          avg_mbps: avgMbps,
          is_throttled: shouldThrottle,
        });
      }
    } catch (err) {
      console.error('[Bandwidth] Error:', err);
    }
  }, INTERVAL_MS);
}
