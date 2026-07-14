import pool from './db';
import { io } from './index';

// ── Real MikroTik Bandwidth Monitoring + Queue-based Throttling ───────────────
//
// Runs every 15 seconds. For each active session it:
//   1. Reads real Mbps from MikroTik — priority order:
//        a) Per-session simple queue bytes (most accurate, available when throttled)
//        b) hotel-monitor queue bytes split across active sessions (pre-throttle)
//        c) Bridge interface rx/tx counter diff split across active sessions
//   2. Writes the reading to bandwidth_logs
//   3. Computes a rolling average over the last 5 samples
//   4. If average >= throttle_threshold: creates a MikroTik simple queue to cap speed
//   5. If average < threshold and was throttled: removes the queue
//   6. Emits Socket.IO events so the admin dashboard updates in real time
//
// MikroTik Simple Queue naming convention: "hotel-session-{sessionId}"

const INTERVAL_MS = 15_000; // poll every 15 seconds for live stats

// ── Bridge interface counter state ────────────────────────────────────────────
// Stores the last rx-byte + tx-byte reading per interface so we can diff each poll.
// RouterOS counters are cumulative and reset on reboot — handle wrap-around below.
interface IfaceCounters { rx: number; tx: number; ts: number }
const lastIfaceCounters = new Map<string, IfaceCounters>();

const MT_BASE = () => `http://${process.env.MIKROTIK_HOST}/rest`;
const MT_AUTH = () =>
  'Basic ' + Buffer.from(`${process.env.MIKROTIK_USER}:${process.env.MIKROTIK_PASS}`).toString('base64');
const MT_HEADERS = () => ({ 'Content-Type': 'application/json', Authorization: MT_AUTH() });

/**
 * Read rx-byte + tx-byte for the guest bridge interface and return the
 * byte-delta since the last call, converted to Mbps.
 *
 * RouterOS 7 REST: GET /rest/interface?name=<bridge>
 * Response includes "rx-byte" and "tx-byte" as cumulative counters.
 *
 * Returns total Mbps (rx+tx combined) or null on failure.
 */
async function getBridgeUsageMbps(bridgeName: string): Promise<number | null> {
  try {
    const res = await fetch(
      `${MT_BASE()}/interface?name=${encodeURIComponent(bridgeName)}`,
      { method: 'GET', headers: MT_HEADERS(), signal: AbortSignal.timeout(4000) }
    );
    if (!res.ok) return null;

    const ifaces: any[] = await res.json() as any[];
    const iface = ifaces[0];
    if (!iface) return null;

    const rx = Number(iface['rx-byte'] ?? 0);
    const tx = Number(iface['tx-byte'] ?? 0);
    const now = Date.now();

    const last = lastIfaceCounters.get(bridgeName);
    lastIfaceCounters.set(bridgeName, { rx, tx, ts: now });

    if (!last) return null; // First poll — no delta yet

    const elapsedSec = (now - last.ts) / 1000;
    if (elapsedSec <= 0) return null;

    // Handle counter wrap-around (32-bit on some devices)
    const MAX_COUNTER = 2 ** 32;
    const rxDelta = rx >= last.rx ? rx - last.rx : MAX_COUNTER - last.rx + rx;
    const txDelta = tx >= last.tx ? tx - last.tx : MAX_COUNTER - last.tx + tx;

    const totalBytes = rxDelta + txDelta;
    const mbps = (totalBytes * 8) / elapsedSec / 1_000_000;
    return parseFloat(mbps.toFixed(2));
  } catch {
    return null;
  }
}

/**
 * Read bytes from the hotel-monitor umbrella queue (covers 192.168.88.0/24).
 * The queue bytes field resets each time it's read (RouterOS behaviour).
 * Returns total Mbps or null if the queue doesn't exist or has no data.
 */
async function getMonitorQueueMbps(): Promise<number | null> {
  try {
    const res = await fetch(
      `${MT_BASE()}/queue/simple?name=hotel-monitor`,
      { method: 'GET', headers: MT_HEADERS(), signal: AbortSignal.timeout(4000) }
    );
    if (!res.ok) return null;

    const queues: any[] = await res.json() as any[];
    if (queues.length === 0) return null;

    const bytes = queues[0].bytes as string | undefined;
    if (!bytes) return null;

    const [dl, ul] = bytes.split('/').map(Number);
    const totalBytes = (dl || 0) + (ul || 0);
    if (totalBytes === 0) return null;

    const mbps = (totalBytes * 8) / (INTERVAL_MS / 1000) / 1_000_000;
    return parseFloat(mbps.toFixed(2));
  } catch {
    return null;
  }
}

/**
 * Get real-time bandwidth usage for a specific session IP from MikroTik.
 *
 * Priority:
 *   1. Per-session simple queue bytes (exact, available after throttle starts)
 *   2. Returns null — caller will use shared bridge/monitor reading split across sessions
 *
 * Returns Mbps or null.
 */
async function getSessionQueueMbps(sessionId: number): Promise<number | null> {
  try {
    const res = await fetch(
      `${MT_BASE()}/queue/simple?name=hotel-session-${sessionId}`,
      { method: 'GET', headers: MT_HEADERS(), signal: AbortSignal.timeout(4000) }
    );
    if (!res.ok) return null;

    const queues: any[] = await res.json() as any[];
    if (queues.length === 0) return null;

    const bytes = queues[0].bytes as string | undefined;
    if (!bytes) return null;

    const [dl, ul] = bytes.split('/').map(Number);
    const totalBytes = (dl || 0) + (ul || 0);
    const mbps = (totalBytes * 8) / (INTERVAL_MS / 1000) / 1_000_000;
    return parseFloat(mbps.toFixed(2));
  } catch {
    return null;
  }
}

/**
 * Simulate a realistic bandwidth reading as fallback when MikroTik is unavailable.
 */
function simulateUsage(): number {
  const roll = Math.random();
  if (roll < 0.10) return parseFloat((9 + Math.random() * 5).toFixed(2));
  if (roll < 0.30) return parseFloat((4 + Math.random() * 5).toFixed(2));
  if (roll < 0.70) return parseFloat((1 + Math.random() * 3).toFixed(2));
  return parseFloat((0.1 + Math.random() * 0.9).toFixed(2));
}

/**
 * Create a MikroTik simple queue to throttle a guest's bandwidth.
 * Queue name: "hotel-session-{sessionId}"
 * Max rate: bandwidth_limit_mbps (e.g. "2M/2M" for 2 Mbps up/down)
 */
export async function mikrotikCreateThrottleQueue(
  sessionId: number,
  ip: string,
  limitMbps: number
): Promise<boolean> {
  if (!process.env.MIKROTIK_HOST) return false;
  try {
    const name = `hotel-session-${sessionId}`;
    const rate = `${limitMbps}M`;

    // Remove existing queue for this session first (idempotent)
    await mikrotikRemoveThrottleQueue(sessionId);

    const res = await fetch(`${MT_BASE()}/queue/simple`, {
      method: 'PUT',
      headers: MT_HEADERS(),
      body: JSON.stringify({
        name,
        target: `${ip}/32`,
        'max-limit': `${rate}/${rate}`,
        comment: `Hotel WiFi throttle — Session ${sessionId}`,
      }),
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) {
      // Try POST if PUT fails
      const res2 = await fetch(`${MT_BASE()}/queue/simple`, {
        method: 'POST',
        headers: MT_HEADERS(),
        body: JSON.stringify({
          name,
          target: `${ip}/32`,
          'max-limit': `${rate}/${rate}`,
          comment: `Hotel WiFi throttle — Session ${sessionId}`,
        }),
        signal: AbortSignal.timeout(5000),
      });
      if (!res2.ok) {
        const err = await res2.text();
        console.error(`[Throttle] Failed to create queue for Session #${sessionId}: ${err}`);
        return false;
      }
    }

    console.log(`[Throttle] ⚡ Queue created: hotel-session-${sessionId} → ${ip} capped at ${limitMbps} Mbps`);
    return true;
  } catch (e: any) {
    console.error(`[Throttle] Error creating queue: ${e.message}`);
    return false;
  }
}

/**
 * Remove a MikroTik simple queue when throttle is lifted or session ends.
 */
export async function mikrotikRemoveThrottleQueue(sessionId: number): Promise<boolean> {
  if (!process.env.MIKROTIK_HOST) return false;
  try {
    const name = `hotel-session-${sessionId}`;

    // Find the queue by name
    const res = await fetch(
      `${MT_BASE()}/queue/simple?name=${encodeURIComponent(name)}`,
      { method: 'GET', headers: MT_HEADERS(), signal: AbortSignal.timeout(4000) }
    );
    if (!res.ok) return false;

    const queues: any[] = await res.json() as any[];
    for (const q of queues) {
      await fetch(`${MT_BASE()}/queue/simple/${q['.id']}`, {
        method: 'DELETE',
        headers: MT_HEADERS(),
        signal: AbortSignal.timeout(4000),
      });
    }

    if (queues.length > 0) {
      console.log(`[Throttle] ✅ Queue removed: hotel-session-${sessionId}`);
    }
    return true;
  } catch (e: any) {
    console.error(`[Throttle] Error removing queue: ${e.message}`);
    return false;
  }
}

export function startBandwidthJob(): void {
  const hasMikrotik = !!process.env.MIKROTIK_HOST;
  const bridgeName  = process.env.MIKROTIK_BRIDGE || 'bridge';

  if (hasMikrotik) {
    console.log('[Bandwidth] Real MikroTik monitoring started (15s interval)');
    console.log(`[Bandwidth] Bridge interface: ${bridgeName} — using counter diffing for pre-throttle stats`);
    console.log('[Bandwidth] Throttling via MikroTik simple queues enabled');
  } else {
    console.log('[Bandwidth] Simulation job started (15s interval) — set MIKROTIK_HOST to enable real monitoring');
  }

  setInterval(async () => {
    try {
      const [sessions] = await pool.query<any[]>(`
        SELECT s.id, s.ip_address, s.device_mac, s.is_throttled,
               vap.throttle_threshold_mbps, vap.bandwidth_limit_mbps, vap.id AS vap_id,
               r.room_number
        FROM sessions s
        LEFT JOIN vaps vap ON s.vap_id = vap.id
        LEFT JOIN vouchers v ON s.voucher_id = v.id
        LEFT JOIN rooms r ON v.room_id = r.id
        WHERE s.is_active = TRUE
      `);

      if (sessions.length === 0) return;

      // ── Fetch shared bridge stats once for all sessions ───────────────────
      // These are read once per cycle and split across sessions that don't
      // have a per-session queue. This avoids N parallel requests to MikroTik.
      let sharedMbps: number | null = null;
      if (hasMikrotik) {
        // Priority 1: hotel-monitor umbrella queue (resets each read — accurate per-interval)
        const monitorMbps = await getMonitorQueueMbps();
        if (monitorMbps !== null) {
          sharedMbps = monitorMbps;
        } else {
          // Priority 2: bridge interface counter diff
          sharedMbps = await getBridgeUsageMbps(bridgeName);
        }
      }

      // Count sessions that will use the shared reading (no per-session queue)
      // so we can split the total fairly across them.
      // Only count unthrottled sessions — throttled ones have their own queue reading.
      const unthrottledCount = sessions.filter(s => !s.is_throttled).length || 1;

      // Process all sessions in parallel for speed
      await Promise.all(sessions.map(async (session) => {
        try {
          const ip = session.ip_address?.replace(/^::ffff:/, '').trim() || null;

          // Get real usage from MikroTik, fall back to 0 (not simulation) when configured
          let usageMbps: number;
          if (hasMikrotik && ip) {
            // Try per-session queue first (throttled sessions have one)
            const queueMbps = await getSessionQueueMbps(session.id);
            if (queueMbps !== null) {
              // Exact per-session reading from the throttle queue
              usageMbps = queueMbps;
            } else if (sharedMbps !== null) {
              // Shared bridge/monitor reading — split evenly across unthrottled sessions.
              const perSessionMbps = sharedMbps / unthrottledCount;
              const cap = (session.bandwidth_limit_mbps ?? 50) * 1.2;
              usageMbps = parseFloat(Math.min(perSessionMbps, cap).toFixed(2));
            } else {
              // MikroTik reachable but bridge returned no stats — record 0, don't fabricate data
              usageMbps = 0;
            }
          } else {
            // No MikroTik configured — use simulation for demo/testing purposes only
            usageMbps = simulateUsage();
          }

          // Write bandwidth sample
          await pool.query(
            'INSERT INTO bandwidth_logs (session_id, usage_mbps) VALUES (?, ?)',
            [session.id, usageMbps]
          );

          // Rolling average of last 5 samples
          const [avgRows] = await pool.query<any[]>(`
            SELECT AVG(usage_mbps) AS avg_mbps
            FROM (
              SELECT usage_mbps FROM bandwidth_logs
              WHERE session_id = ?
              ORDER BY id DESC LIMIT 5
            ) AS recent
          `, [session.id]);

          const avgMbps: number = parseFloat(avgRows[0]?.avg_mbps ?? 0);
          const threshold: number = session.throttle_threshold_mbps ?? 8;
          const limitMbps: number = session.bandwidth_limit_mbps ?? 2;
          const shouldThrottle = avgMbps >= threshold;

          // Apply or remove MikroTik queue when throttle state changes
          if (shouldThrottle !== Boolean(session.is_throttled)) {
            await pool.query('UPDATE sessions SET is_throttled = ? WHERE id = ?', [shouldThrottle, session.id]);

            if (hasMikrotik && ip) {
              if (shouldThrottle) {
                await mikrotikCreateThrottleQueue(session.id, ip, limitMbps);
              } else {
                await mikrotikRemoveThrottleQueue(session.id);
              }
            }

            io.emit('session:throttle', {
              sessionId: session.id,
              is_throttled: shouldThrottle,
              avg_mbps: avgMbps,
              threshold,
              room_number: session.room_number,
            });

            console.log(
              `[Bandwidth] Session #${session.id} (Room ${session.room_number}) ` +
              `${shouldThrottle ? '⚡ THROTTLED' : '✅ UNTHROTTLED'} ` +
              `— avg ${avgMbps.toFixed(2)} Mbps (threshold: ${threshold} Mbps, cap: ${limitMbps} Mbps)`
            );
          }

          // Always emit live update
          io.emit('session:bandwidth', {
            sessionId: session.id,
            usage_mbps: usageMbps,
            avg_mbps: avgMbps,
            is_throttled: shouldThrottle,
          });
        } catch (err) {
          console.error(`[Bandwidth] Error processing session #${session.id}:`, err);
        }
      }));
    } catch (err) {
      console.error('[Bandwidth] Job error:', err);
    }
  }, INTERVAL_MS);
}
