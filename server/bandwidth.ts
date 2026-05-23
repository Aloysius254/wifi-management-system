import pool from './db';
import { io } from './index';

// Weighted random usage: skewed towards browsing (low) with occasional heavy usage
function randomUsageMbps(): number {
  const r = Math.random();
  if (r < 0.55) return +(Math.random() * 3.5 + 0.3).toFixed(2);  // 55%: 0.3–3.8 Mbps (browsing)
  if (r < 0.80) return +(Math.random() * 4.0 + 3.8).toFixed(2);  // 25%: 3.8–7.8 Mbps (video)
  return +(Math.random() * 7.0 + 7.8).toFixed(2);                 // 20%: 7.8–14.8 Mbps (heavy streaming)
}

export function startBandwidthSimulator() {
  console.log('[Bandwidth] Auto-simulator started (60s interval)');

  setInterval(async () => {
    try {
      const [sessions] = await pool.query<any[]>(`
        SELECT s.id, s.is_throttled,
               COALESCE(vap.throttle_threshold_mbps, 8) AS throttle_threshold_mbps
        FROM sessions s
        LEFT JOIN vaps vap ON s.vap_id = vap.id
        WHERE s.is_active = TRUE
      `);

      for (const session of sessions) {
        const usage = randomUsageMbps();

        await pool.query(
          'INSERT INTO bandwidth_logs (session_id, usage_mbps) VALUES (?, ?)',
          [session.id, usage]
        );

        const shouldThrottle = usage >= session.throttle_threshold_mbps;
        if (shouldThrottle !== Boolean(session.is_throttled)) {
          await pool.query('UPDATE sessions SET is_throttled = ? WHERE id = ?', [shouldThrottle, session.id]);
          io.emit(shouldThrottle ? 'session:throttled' : 'session:unthrottled', {
            sessionId: session.id,
            usage_mbps: usage,
          });
        }

        io.emit('bandwidth:update', {
          sessionId: session.id,
          usage_mbps: usage,
          is_throttled: shouldThrottle,
        });
      }

      if (sessions.length > 0) {
        console.log(`[Bandwidth] Logged usage for ${sessions.length} session(s)`);
      }
    } catch (err) {
      console.error('[Bandwidth] Error:', err);
    }
  }, 60_000);
}
