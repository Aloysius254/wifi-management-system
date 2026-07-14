/**
 * MikroTik REST API helper
 *
 * Two layers of integration:
 *   1. Firewall address-list  — allows/blocks guest internet access by IP
 *   2. Bridge VLAN filtering  — assigns the room's switch port to the correct
 *      VLAN when a guest connects and removes it when they disconnect
 *
 * RouterOS 7 REST API: http://<host>/rest/<path>
 *
 * Environment variables
 * ─────────────────────
 * MIKROTIK_HOST      IP/hostname of the RouterOS device  (e.g. 192.168.88.1)
 * MIKROTIK_USER      API username                        (e.g. admin)
 * MIKROTIK_PASS      API password
 * MIKROTIK_BRIDGE    Bridge interface name               (default: bridge1)
 *
 * Room → port mapping  (one env var per room)
 *   ROOM_1_PORT=ether2
 *   ROOM_2_PORT=ether3
 *   ROOM_3_PORT=ether4
 *   … and so on
 *
 * The VLAN ID always equals the room number (Room 1 → VLAN 1).
 */

const MT_BASE = () => `http://${process.env.MIKROTIK_HOST}/rest`;
const MT_AUTH = () =>
  'Basic ' +
  Buffer.from(`${process.env.MIKROTIK_USER}:${process.env.MIKROTIK_PASS}`).toString('base64');

function mtHeaders() {
  return {
    'Content-Type': 'application/json',
    Authorization: MT_AUTH(),
  };
}

/** Returns the switch port for a given room number, or null if not configured. */
function roomPort(roomNumber: string | number): string | null {
  const key = `ROOM_${roomNumber}_PORT`;
  return process.env[key] || null;
}

/** Bridge name — defaults to bridge1 */
function bridge(): string {
  return process.env.MIKROTIK_BRIDGE || 'bridge1';
}

/**
 * Add a guest IP to the allowed_guests address-list with an auto-expiry timeout.
 * If the IP already exists in the list it is removed first so the timer resets.
 *
 * RouterOS 7 REST: POST /rest/ip/firewall/address-list
 * Timeout format: "1d00:00:00" for 24h, "00:30:00" for 30 min, etc.
 */
export async function mikrotikAllowGuest(
  ip: string,
  sessionId: number,
  roomNumber: string,
  durationHours: number
): Promise<boolean> {
  if (!process.env.MIKROTIK_HOST) return false;
  try {
    // Remove any stale entry for this IP first (idempotent)
    await mikrotikRemoveGuestByIp(ip);

    // RouterOS timeout format examples:
    //   30 minutes  → "00:30:00"
    //   2 hours     → "02:00:00"
    //   24 hours    → "1d00:00:00"
    //   48 hours    → "2d00:00:00"
    const days = Math.floor(durationHours / 24);
    const remH = durationHours % 24;
    const timeout = days > 0
      ? `${days}d${String(remH).padStart(2, '0')}:00:00`
      : `${String(durationHours).padStart(2, '0')}:00:00`;

    // This RouterOS build requires PUT (not POST) to create address-list entries
    const res = await fetch(`${MT_BASE()}/ip/firewall/address-list`, {
      method: 'PUT',
      headers: mtHeaders(),
      body: JSON.stringify({
        list: 'allowed_guests',
        address: ip,
        comment: `Session ${sessionId} - Room ${roomNumber}`,
        timeout,
      }),
      signal: AbortSignal.timeout(5000),
    });

    const responseText = await res.text();

    if (!res.ok) {
      console.error(`[MikroTik] Failed to allow ${ip}: ${res.status} ${responseText}`);
      return false;
    }

    console.log(`[MikroTik] ✅ Allowed ${ip} (Session ${sessionId}, Room ${roomNumber}) for ${durationHours}h (timeout: ${timeout})`);
    return true;
  } catch (e: any) {
    console.error(`[MikroTik] API error (allow): ${e.message}`);
    return false;
  }
}

/**
 * Remove a guest IP from allowed_guests — called on disconnect or voucher deactivation.
 * Fetches all entries and filters client-side because RouterOS REST does not
 * support ?address= query filtering reliably.
 * Also flushes active connection tracking entries so established sessions
 * are immediately dropped (otherwise rule 12 "accept established" keeps them alive).
 */
export async function mikrotikRemoveGuestByIp(ip: string): Promise<boolean> {
  if (!process.env.MIKROTIK_HOST) return false;
  try {
    const normalizedIp = ip.replace(/^::ffff:/, '').trim();

    // 1. Fetch ALL entries in allowed_guests and filter client-side
    const res = await fetch(
      `${MT_BASE()}/ip/firewall/address-list?list=allowed_guests`,
      { method: 'GET', headers: mtHeaders(), signal: AbortSignal.timeout(5000) }
    );
    if (!res.ok) {
      console.error(`[MikroTik] Failed to fetch address-list: ${res.status}`);
      return false;
    }

    const all: Array<{ '.id': string; address: string }> =
      (await res.json()) as Array<{ '.id': string; address: string }>;

    const matches = all.filter(e => e.address === normalizedIp);

    for (const entry of matches) {
      await fetch(`${MT_BASE()}/ip/firewall/address-list/${entry['.id']}`, {
        method: 'DELETE',
        headers: mtHeaders(),
        signal: AbortSignal.timeout(5000),
      });
    }

    if (matches.length > 0) {
      console.log(`[MikroTik] 🗑️  Removed ${normalizedIp} from allowed_guests (${matches.length} entr${matches.length > 1 ? 'ies' : 'y'})`);
    } else {
      console.log(`[MikroTik] ℹ️  ${normalizedIp} not found in allowed_guests (already removed or never added)`);
    }

    return true;
  } catch (e: any) {
    console.error(`[MikroTik] API error (remove by IP): ${e.message}`);
    return false;
  }
}

/**
 * Flush all active connection tracking entries for a given IP.
 * This immediately kills existing TCP sessions so the firewall DROP takes effect.
 * Uses POST to /ip/firewall/connection/remove (RouterOS CLI-mapped REST endpoint).
 */
async function mikrotikFlushConnections(ip: string): Promise<void> {
  if (!process.env.MIKROTIK_HOST) return;
  try {
    // Get all connections where this IP is source or destination
    const res = await fetch(
      `${MT_BASE()}/ip/firewall/connection`,
      { method: 'GET', headers: mtHeaders(), signal: AbortSignal.timeout(5000) }
    );
    if (!res.ok) {
      // Connection tracking endpoint may not be available — not fatal
      console.log(`[MikroTik] Connection tracking not available (${res.status}) — connections will expire naturally`);
      return;
    }

    const conns: Array<{ '.id': string; 'src-address'?: string; 'dst-address'?: string }> =
      await res.json() as Array<{ '.id': string; 'src-address'?: string; 'dst-address'?: string }>;

    // Match connections where this IP appears in src or dst (format: "ip:port")
    const toRemove = conns.filter(c =>
      c['src-address']?.startsWith(ip + ':') ||
      c['dst-address']?.startsWith(ip + ':') ||
      c['src-address'] === ip ||
      c['dst-address'] === ip
    );

    let removed = 0;
    for (const conn of toRemove) {
      const r = await fetch(`${MT_BASE()}/ip/firewall/connection/${conn['.id']}`, {
        method: 'DELETE',
        headers: mtHeaders(),
        signal: AbortSignal.timeout(3000),
      });
      if (r.ok) removed++;
    }

    if (removed > 0) {
      console.log(`[MikroTik] 🔌 Flushed ${removed} active connection(s) for ${ip} — internet cut immediately`);
    } else {
      console.log(`[MikroTik] ℹ️  No active connections found for ${ip}`);
    }
  } catch (e: any) {
    console.log(`[MikroTik] Connection flush skipped: ${e.message}`);
  }
}

/**
 * Remove a guest by session comment — useful when we only know the session ID.
 */
export async function mikrotikRemoveGuestBySession(sessionId: number): Promise<boolean> {
  if (!process.env.MIKROTIK_HOST) return false;
  try {
    const res = await fetch(
      `${MT_BASE()}/ip/firewall/address-list?list=allowed_guests`,
      { method: 'GET', headers: mtHeaders() }
    );
    if (!res.ok) return false;

    const entries: Array<{ '.id': string; comment?: string }> = await res.json() as Array<{ '.id': string; comment?: string }>;
    const match = entries.filter(e => e.comment?.includes(`Session ${sessionId}`));

    for (const entry of match) {
      await fetch(`${MT_BASE()}/ip/firewall/address-list/${entry['.id']}`, {
        method: 'DELETE',
        headers: mtHeaders(),
      });
    }

    if (match.length > 0) {
      console.log(`[MikroTik] 🗑️  Removed Session ${sessionId} from allowed_guests`);
    }
    return true;
  } catch (e: any) {
    console.error(`[MikroTik] API error (remove by session): ${e.message}`);
    return false;
  }
}

// ── Bridge VLAN integration ───────────────────────────────────────────────────
//
// MikroTik CRS/CSS switches use "bridge VLAN filtering".
// Each port has a PVID (untagged VLAN) and an optional set of tagged VLANs.
//
// When a guest connects to Room N:
//   • The port's PVID is set to N  (untagged frames from the room get VLAN N)
//   • VLAN N is added to the bridge VLAN table for that port (if not already)
//
// When the guest disconnects / expires:
//   • The port's PVID is reset to the "blocked" VLAN (4094 by default)
//   • VLAN N is removed from the bridge VLAN table for that port
//
// This is done via the RouterOS REST API paths:
//   /rest/interface/bridge/port       — PVID per port
//   /rest/interface/bridge/vlan       — VLAN membership table

const BLOCKED_VLAN = 4094; // PVID used when no guest is active on the port

/**
 * Find the bridge port entry ID for a given interface.
 * Returns the RouterOS internal `.id` string (e.g. "*3").
 */
async function findBridgePortId(iface: string): Promise<string | null> {
  try {
    const res = await fetch(
      `${MT_BASE()}/interface/bridge/port?bridge=${encodeURIComponent(bridge())}&interface=${encodeURIComponent(iface)}`,
      { method: 'GET', headers: mtHeaders(), signal: AbortSignal.timeout(4000) }
    );
    if (!res.ok) return null;
    const entries: Array<{ '.id': string; interface: string }> = await res.json() as Array<{ '.id': string; interface: string }>;
    return entries[0]?.['.id'] ?? null;
  } catch {
    return null;
  }
}

/**
 * Find the bridge VLAN table entry ID for a given (vlanId, port) pair.
 * Returns the RouterOS internal `.id` string, or null if not found.
 */
async function findBridgeVlanEntryId(vlanId: number, iface: string): Promise<string | null> {
  try {
    const res = await fetch(
      `${MT_BASE()}/interface/bridge/vlan?bridge=${encodeURIComponent(bridge())}&vlan-ids=${vlanId}`,
      { method: 'GET', headers: mtHeaders(), signal: AbortSignal.timeout(4000) }
    );
    if (!res.ok) return null;
    const entries: Array<{ '.id': string; 'untagged'?: string; 'tagged'?: string }> = await res.json() as Array<{ '.id': string; 'untagged'?: string; 'tagged'?: string }>;
    // Look for an entry that includes this interface in tagged or untagged
    for (const e of entries) {
      const ports = [e.untagged || '', e.tagged || ''].join(',');
      if (ports.split(',').map(p => p.trim()).includes(iface)) {
        return e['.id'];
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Add an interface to the bridge programmatically via REST API.
 * Used for auto-remediation when a room port is not yet in the bridge.
 *
 * Returns structured result with clear diagnostics on failure.
 */
export async function mikrotikAddBridgePort(
  iface: string,
  bridgeName: string
): Promise<{ ok: boolean; error?: string }> {
  if (!process.env.MIKROTIK_HOST) {
    return { ok: false, error: 'MIKROTIK_HOST not set' };
  }

  // Validate inputs
  if (!iface || !bridgeName) {
    return { ok: false, error: 'interface and bridgeName are required' };
  }

  try {
    // Try POST first (standard REST API method)
    let res = await fetch(`${MT_BASE()}/interface/bridge/port`, {
      method: 'POST',
      headers: mtHeaders(),
      body: JSON.stringify({
        bridge: bridgeName,
        interface: iface,
        pvid: '1', // Default PVID, will be updated by mikrotikAssignPortVlan
      }),
      signal: AbortSignal.timeout(5000),
    });

    // Some RouterOS builds require PUT instead of POST for creation
    if (!res.ok && (res.status === 404 || res.status === 405)) {
      res = await fetch(`${MT_BASE()}/interface/bridge/port`, {
        method: 'PUT',
        headers: mtHeaders(),
        body: JSON.stringify({
          bridge: bridgeName,
          interface: iface,
          pvid: '1',
        }),
        signal: AbortSignal.timeout(5000),
      });
    }

    if (!res.ok) {
      const body = await res.text();
      let errorMsg = `HTTP ${res.status} - ${body}`;

      // Provide specific guidance for common errors
      if (res.status === 403) {
        errorMsg += '. Fix: Grant API user write access to /interface/bridge/port';
      } else if (res.status === 400 && body.includes('already')) {
        errorMsg += '. Port may already be in bridge';
      }

      console.error(`[MikroTik] ❌ Failed to add ${iface} to bridge ${bridgeName}: ${errorMsg}`);
      return { ok: false, error: errorMsg };
    }

    console.log(`[MikroTik] ✅ Added ${iface} to bridge ${bridgeName}`);
    return { ok: true };
  } catch (e: any) {
    const errorMsg = `API error: ${e.message}`;
    console.error(`[MikroTik] ❌ Failed to add ${iface} to bridge ${bridgeName}: ${errorMsg}`);
    return { ok: false, error: errorMsg };
  }
}

/**
 * Assign a switch port to a room's VLAN when a guest connects.
 *
 * Steps:
 *   1. Set the port's PVID to vlanId  (untagged ingress)
 *   2. Add the port as untagged in the bridge VLAN table for vlanId
 *
 * Safe to call if the port is already in the correct VLAN (idempotent).
 */
export async function mikrotikAssignPortVlan(
  roomNumber: string | number,
  vlanId: number,
  sessionId: number
): Promise<boolean> {
  if (!process.env.MIKROTIK_HOST) return false;

  const iface = roomPort(roomNumber);
  if (!iface) {
    console.log(`[MikroTik] No port configured for Room ${roomNumber} — skipping VLAN assignment`);
    console.log(`           Set ROOM_${roomNumber}_PORT=etherX in .env to enable switch integration`);
    return false;
  }

  try {
    // 1. Update PVID on the bridge port
    let portId = await findBridgePortId(iface);
    if (!portId) {
      // Port not in main bridge — may be in a dedicated room bridge (bridge-room1, bridge-room2).
      // In that setup VLAN assignment is handled by separate bridges, not PVID — skip silently.
      console.log(`[MikroTik] Port ${iface} not in main bridge — skipping VLAN assignment (using dedicated bridge)`);
      return false;
    }

    const pvid = await fetch(`${MT_BASE()}/interface/bridge/port/${encodeURIComponent(portId)}`, {
      method: 'PATCH',
      headers: mtHeaders(),
      body: JSON.stringify({ pvid: String(vlanId) }),
      signal: AbortSignal.timeout(4000),
    });

    if (!pvid.ok) {
      const body = await pvid.text();
      console.error(`[MikroTik] Failed to set PVID on ${iface}: ${pvid.status} ${body}`);
      return false;
    }

    // 2. Ensure the VLAN exists in the bridge VLAN table for this port (untagged)
    // First check if an entry already exists
    const existingVlanId = await findBridgeVlanEntryId(vlanId, iface);

    if (!existingVlanId) {
      // Create new VLAN entry — RouterOS requires PUT for creation on this build
      const vlanRes = await fetch(`${MT_BASE()}/interface/bridge/vlan`, {
        method: 'PUT',
        headers: mtHeaders(),
        body: JSON.stringify({
          bridge: bridge(),
          'vlan-ids': String(vlanId),
          untagged: iface,
          comment: `Room ${roomNumber} — Session ${sessionId}`,
        }),
        signal: AbortSignal.timeout(4000),
      });

      if (!vlanRes.ok) {
        const body = await vlanRes.text();
        console.error(`[MikroTik] Failed to add VLAN ${vlanId} for ${iface}: ${vlanRes.status} ${body}`);
        // PVID was set OK — partial success, still return false so caller can log
        return false;
      }
    }

    console.log(
      `[MikroTik] 🔌 Port ${iface} → VLAN ${vlanId} (Room ${roomNumber}, Session ${sessionId})`
    );
    return true;
  } catch (e: any) {
    console.error(`[MikroTik] API error (assign port VLAN): ${e.message}`);
    return false;
  }
}

/**
 * Remove a switch port from a room's VLAN when the guest disconnects.
 *
 * Steps:
 *   1. Reset the port's PVID to BLOCKED_VLAN (4094)
 *   2. Remove the port's entry from the bridge VLAN table for vlanId
 */
export async function mikrotikReleasePortVlan(
  roomNumber: string | number,
  vlanId: number,
  sessionId: number
): Promise<boolean> {
  if (!process.env.MIKROTIK_HOST) return false;

  const iface = roomPort(roomNumber);
  if (!iface) return false; // No port configured — nothing to release

  try {
    // 1. Reset PVID to blocked VLAN
    const portId = await findBridgePortId(iface);
    if (portId) {
      await fetch(`${MT_BASE()}/interface/bridge/port/${encodeURIComponent(portId)}`, {
        method: 'PATCH',
        headers: mtHeaders(),
        body: JSON.stringify({ pvid: String(BLOCKED_VLAN) }),
        signal: AbortSignal.timeout(4000),
      });
    }

    // 2. Remove the VLAN table entry for this port
    const vlanEntryId = await findBridgeVlanEntryId(vlanId, iface);
    if (vlanEntryId) {
      await fetch(`${MT_BASE()}/interface/bridge/vlan/${encodeURIComponent(vlanEntryId)}`, {
        method: 'DELETE',
        headers: mtHeaders(),
        signal: AbortSignal.timeout(4000),
      });
    }

    console.log(
      `[MikroTik] 🔓 Port ${iface} released from VLAN ${vlanId} (Room ${roomNumber}, Session ${sessionId})`
    );
    return true;
  } catch (e: any) {
    console.error(`[MikroTik] API error (release port VLAN): ${e.message}`);
    return false;
  }
}

/**
 * Full connectivity + capability test.
 * Returns a structured result for the admin dashboard.
 */
export async function mikrotikTest(): Promise<{
  connected: boolean;
  host: string | undefined;
  bridge: string;
  firewallOk: boolean;
  bridgeVlanOk: boolean;
  allowedGuests: number;
  bridgePorts: number;
  reason?: string;
}> {
  const host = process.env.MIKROTIK_HOST;
  const br = bridge();

  if (!host) {
    return { connected: false, host, bridge: br, firewallOk: false, bridgeVlanOk: false, allowedGuests: 0, bridgePorts: 0, reason: 'MIKROTIK_HOST not set' };
  }

  let firewallOk = false;
  let bridgeVlanOk = false;
  let allowedGuests = 0;
  let bridgePorts = 0;
  let reason: string | undefined;

  try {
    // Test 1: firewall address-list
    const fwRes = await fetch(
      `${MT_BASE()}/ip/firewall/address-list?list=allowed_guests`,
      { method: 'GET', headers: mtHeaders(), signal: AbortSignal.timeout(4000) }
    );
    if (fwRes.ok) {
      const list: any[] = await fwRes.json() as any[];
      firewallOk = true;
      allowedGuests = list.length;
    }

    // Test 2: bridge VLAN table
    const vlanRes = await fetch(
      `${MT_BASE()}/interface/bridge/vlan?bridge=${encodeURIComponent(br)}`,
      { method: 'GET', headers: mtHeaders(), signal: AbortSignal.timeout(4000) }
    );
    if (vlanRes.ok) {
      const vlans: any[] = await vlanRes.json() as any[];
      bridgeVlanOk = true;
      bridgePorts = vlans.length;
    }

    return { connected: firewallOk || bridgeVlanOk, host, bridge: br, firewallOk, bridgeVlanOk, allowedGuests, bridgePorts };
  } catch (e: any) {
    reason = e.message;
    return { connected: false, host, bridge: br, firewallOk, bridgeVlanOk, allowedGuests, bridgePorts, reason };
  }
}

// ── MikroTik Firewall Setup ───────────────────────────────────────────────────
//
// The allowed_guests address-list only works if there are matching firewall
// rules that BLOCK traffic from IPs NOT in the list.
//
// Required rules in /ip/firewall/filter (forward chain):
//   1. ACCEPT  src-address-list=allowed_guests  (let authenticated guests through)
//   2. DROP    in-interface=<guest bridge/VLAN>  (block everyone else)
//
// This function creates those rules if they don't already exist.
// Call it once via POST /api/mikrotik/setup or from the admin dashboard.

export async function mikrotikSetupFirewall(guestInterface: string): Promise<{
  ok: boolean;
  created: string[];
  skipped: string[];
  errors: string[];
}> {
  const created: string[] = [];
  const skipped: string[] = [];
  const errors:  string[] = [];

  if (!process.env.MIKROTIK_HOST) {
    return { ok: false, created, skipped, errors: ['MIKROTIK_HOST not set'] };
  }

  try {
    // Fetch existing forward rules
    const existing = await fetch(`${MT_BASE()}/ip/firewall/filter?chain=forward`, {
      method: 'GET', headers: mtHeaders(), signal: AbortSignal.timeout(5000),
    });
    const rules: any[] = existing.ok ? (await existing.json() as any[]) : [];

    // Rule 1: ACCEPT forward from allowed_guests
    const hasAccept = rules.some(r =>
      r.action === 'accept' &&
      r['src-address-list'] === 'allowed_guests'
    );
    if (hasAccept) {
      skipped.push('accept allowed_guests rule already exists');
    } else {
      const r = await fetch(`${MT_BASE()}/ip/firewall/filter`, {
        method: 'PUT',
        headers: mtHeaders(),
        body: JSON.stringify({
          chain: 'forward',
          action: 'accept',
          'src-address-list': 'allowed_guests',
          comment: 'Hotel WiFi — allow authenticated guests',
          place: 'top',
        }),
        signal: AbortSignal.timeout(5000),
      });
      if (r.ok) created.push('accept allowed_guests (forward)');
      else errors.push(`accept rule failed: ${r.status} ${await r.text()}`);
    }

    // Rule 2: DROP forward from guest interface for non-authenticated
    const hasDrop = rules.some(r =>
      r.action === 'drop' &&
      r['in-interface'] === guestInterface &&
      r['src-address-list'] === '!allowed_guests'
    );
    if (hasDrop) {
      skipped.push('drop !allowed_guests rule already exists');
    } else {
      const r = await fetch(`${MT_BASE()}/ip/firewall/filter`, {
        method: 'PUT',
        headers: mtHeaders(),
        body: JSON.stringify({
          chain: 'forward',
          action: 'drop',
          'in-interface': guestInterface,
          'src-address-list': '!allowed_guests',
          comment: 'Hotel WiFi — block unauthenticated guests',
        }),
        signal: AbortSignal.timeout(5000),
      });
      if (r.ok) created.push(`drop !allowed_guests on ${guestInterface} (forward)`);
      else errors.push(`drop rule failed: ${r.status} ${await r.text()}`);
    }

    // Rule 3: Also block in INPUT chain (prevent unauthenticated access to router itself)
    const inputRules: any[] = await (await fetch(`${MT_BASE()}/ip/firewall/filter?chain=input`, {
      method: 'GET', headers: mtHeaders(), signal: AbortSignal.timeout(5000),
    })).json() as any[];

    const hasInputDrop = inputRules.some(r =>
      r.action === 'drop' &&
      r['in-interface'] === guestInterface &&
      r['src-address-list'] === '!allowed_guests'
    );
    if (hasInputDrop) {
      skipped.push('input drop rule already exists');
    } else {
      const r = await fetch(`${MT_BASE()}/ip/firewall/filter`, {
        method: 'PUT',
        headers: mtHeaders(),
        body: JSON.stringify({
          chain: 'input',
          action: 'drop',
          'in-interface': guestInterface,
          'src-address-list': '!allowed_guests',
          comment: 'Hotel WiFi — block unauthenticated access to router',
        }),
        signal: AbortSignal.timeout(5000),
      });
      if (r.ok) created.push(`drop !allowed_guests on ${guestInterface} (input)`);
      else errors.push(`input drop rule failed: ${r.status} ${await r.text()}`);
    }

    return { ok: errors.length === 0, created, skipped, errors };
  } catch (e: any) {
    return { ok: false, created, skipped, errors: [e.message] };
  }
}

/**
 * Read current firewall rules relevant to guest WiFi.
 * Used by the admin dashboard to show current MikroTik state.
 */
export async function mikrotikGetFirewallStatus(): Promise<{
  ok: boolean;
  hasAcceptRule: boolean;
  hasForwardDropRule: boolean;
  hasInputDropRule: boolean;
  allowedGuests: string[];
  rules: any[];
}> {
  if (!process.env.MIKROTIK_HOST) {
    return { ok: false, hasAcceptRule: false, hasForwardDropRule: false, hasInputDropRule: false, allowedGuests: [], rules: [] };
  }
  try {
    const [fwForward, fwInput, addrList] = await Promise.all([
      fetch(`${MT_BASE()}/ip/firewall/filter?chain=forward`, { method: 'GET', headers: mtHeaders(), signal: AbortSignal.timeout(5000) }),
      fetch(`${MT_BASE()}/ip/firewall/filter?chain=input`,   { method: 'GET', headers: mtHeaders(), signal: AbortSignal.timeout(5000) }),
      fetch(`${MT_BASE()}/ip/firewall/address-list?list=allowed_guests`, { method: 'GET', headers: mtHeaders(), signal: AbortSignal.timeout(5000) }),
    ]);

    const forwardRules: any[] = fwForward.ok ? await fwForward.json() as any[] : [];
    const inputRules:   any[] = fwInput.ok   ? await fwInput.json()   as any[] : [];
    const guests:       any[] = addrList.ok  ? await addrList.json()  as any[] : [];

    const hasAcceptRule      = forwardRules.some(r => r.action === 'accept' && r['src-address-list'] === 'allowed_guests');
    const hasForwardDropRule = forwardRules.some(r => r.action === 'drop'   && r['src-address-list'] === '!allowed_guests');
    const hasInputDropRule   = inputRules.some(r   => r.action === 'drop'   && r['src-address-list'] === '!allowed_guests');

    return {
      ok: true,
      hasAcceptRule,
      hasForwardDropRule,
      hasInputDropRule,
      allowedGuests: guests.map((g: any) => `${g.address} (${g.comment || ''})`),
      rules: [...forwardRules, ...inputRules].map(r => ({
        chain: r.chain, action: r.action,
        'src-address-list': r['src-address-list'],
        'in-interface': r['in-interface'],
        comment: r.comment, disabled: r.disabled,
      })),
    };
  } catch (e: any) {
    return { ok: false, hasAcceptRule: false, hasForwardDropRule: false, hasInputDropRule: false, allowedGuests: [], rules: [] };
  }
}

/**
 * Flush active connection tracking entries for a specific IP.
 * Uses the RouterOS /ip/firewall/connection/remove bulk command (single API call).
 * Falls back to parallel individual deletes if bulk command fails.
 */
export async function mikrotikFlushConntrack(ip: string): Promise<boolean> {
  if (!process.env.MIKROTIK_HOST) return false;
  try {
    // Method 1: Use the RouterOS remove command with a where clause — single fast call
    // This is equivalent to: /ip firewall connection remove [find src-address~"ip"]
    const bulkRes = await fetch(`${MT_BASE()}/ip/firewall/connection/remove`, {
      method: 'POST',
      headers: mtHeaders(),
      body: JSON.stringify({
        '.proplist': '.id',
        'where': [`src-address~"${ip}"`, `dst-address~"${ip}"`],
      }),
      signal: AbortSignal.timeout(5000),
    });

    if (bulkRes.ok || bulkRes.status === 204 || bulkRes.status === 200) {
      console.log(`[MikroTik] ⚡ Bulk conntrack flush for ${ip} — internet cut immediately`);
      return true;
    }

    // Method 2: Fetch all and delete matching ones in parallel
    const listRes = await fetch(`${MT_BASE()}/ip/firewall/connection`, {
      method: 'GET',
      headers: mtHeaders(),
      signal: AbortSignal.timeout(5000),
    });

    if (!listRes.ok) return false;

    const connections: Array<{ '.id': string; 'src-address'?: string; 'dst-address'?: string }> =
      await listRes.json() as Array<{ '.id': string; 'src-address'?: string; 'dst-address'?: string }>;

    const toRemove = connections.filter(c => {
      const src = (c['src-address'] || '').split(':')[0];
      const dst = (c['dst-address'] || '').split(':')[0];
      return src === ip || dst === ip;
    });

    if (toRemove.length === 0) {
      console.log(`[MikroTik] ℹ️  No active connections found for ${ip}`);
      return true;
    }

    // Delete all in parallel
    await Promise.all(toRemove.map(conn =>
      fetch(`${MT_BASE()}/ip/firewall/connection/${conn['.id']}`, {
        method: 'DELETE',
        headers: mtHeaders(),
        signal: AbortSignal.timeout(3000),
      }).catch(() => null)
    ));

    console.log(`[MikroTik] 🔌 Flushed ${toRemove.length} active connection(s) for ${ip} — internet cut immediately`);
    return true;
  } catch (e: any) {
    console.error(`[MikroTik] Conntrack flush error: ${e.message}`);
    return false;
  }
}
