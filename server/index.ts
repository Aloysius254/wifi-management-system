import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import { createServer } from 'http';
import { createServer as createHttpServer } from 'http';
import { createServer as createHttpsServer } from 'https';
import { Server as SocketServer } from 'socket.io';
import { networkInterfaces } from 'os';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';

import pool from './db';
import { startExpiryJob } from './expiry';
import { startBandwidthJob } from './bandwidth';
import {
  mikrotikTest, mikrotikSetupFirewall, mikrotikGetFirewallStatus,
  mikrotikRemoveGuestByIp, mikrotikFlushConntrack, mikrotikAllowGuest,
} from './mikrotik';
import { mikrotikCreateThrottleQueue, mikrotikRemoveThrottleQueue } from './bandwidth';
import authRoutes from './routes/auth';
import roomRoutes from './routes/rooms';
import voucherRoutes from './routes/vouchers';
import sessionRoutes from './routes/sessions';
import vapRoutes from './routes/vaps';
import analyticsRoutes from './routes/analytics';
import auditRoutes from './routes/audit';
import { errorHandler } from './middleware/errorHandler';

dotenv.config();

// ── Self-signed TLS Certificate Generation ────────────────────────────────────
function ensureTlsCertificate(): { key: Buffer; cert: Buffer } | null {
  const sslDir = path.join(process.cwd(), 'server', 'ssl');
  const certPath = path.join(sslDir, 'cert.pem');
  const keyPath = path.join(sslDir, 'key.pem');

  if (existsSync(certPath) && existsSync(keyPath)) {
    console.log('[HTTPS] Using existing certificate from server/ssl/');
    try {
      return { key: readFileSync(keyPath), cert: readFileSync(certPath) };
    } catch (e: any) {
      console.error(`[HTTPS] ❌ Failed to read certificate: ${e.message}`);
      return null;
    }
  }

  console.log('[HTTPS] Generating self-signed certificate for captive portal...');
  try {
    if (!existsSync(sslDir)) mkdirSync(sslDir, { recursive: true });

    // Use node-forge (already a dependency via selfsigned/other packages)
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const forge = require('node-forge');
    const keys = forge.pki.rsa.generateKeyPair(2048);
    const cert = forge.pki.createCertificate();
    cert.publicKey = keys.publicKey;
    cert.serialNumber = '01';
    cert.validity.notBefore = new Date();
    cert.validity.notAfter = new Date();
    cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 10);
    const attrs = [{ name: 'commonName', value: 'Captive Portal' }];
    cert.setSubject(attrs);
    cert.setIssuer(attrs);
    cert.sign(keys.privateKey, forge.md.sha256.create());
    const keyPem = forge.pki.privateKeyToPem(keys.privateKey);
    const certPem = forge.pki.certificateToPem(cert);
    writeFileSync(keyPath, keyPem);
    writeFileSync(certPath, certPem);
    console.log('[HTTPS] ✅ Generated self-signed certificate');
    return { key: readFileSync(keyPath), cert: readFileSync(certPath) };
  } catch (e: any) {
    console.error(`[HTTPS] ❌ Failed to generate certificate: ${e.message}`);
    console.error('[HTTPS] ⚠️  iOS 14+ and Android 10+ captive portal may not show login popup');
    return null;
  }
}

// ── In-memory log buffer ──────────────────────────────────────────────────────
const recentLogs: Array<{ time: string; msg: string }> = [];
const _origLog = console.log.bind(console);
const _origErr = console.error.bind(console);
console.log = (...args: any[]) => {
  const msg = args.join(' ');
  if (/\[MikroTik\]|\[Disconnect\]|\[Socket\]/.test(msg)) {
    recentLogs.push({ time: new Date().toISOString(), msg });
    if (recentLogs.length > 200) recentLogs.shift();
  }
  _origLog(...args);
};
console.error = (...args: any[]) => {
  const msg = args.join(' ');
  if (/\[MikroTik\]|\[Disconnect\]/.test(msg)) {
    recentLogs.push({ time: new Date().toISOString(), msg: '❌ ' + msg });
    if (recentLogs.length > 200) recentLogs.shift();
  }
  _origErr(...args);
};

// ── Helper: get server's LAN IP ───────────────────────────────────────────────
function getServerIp(): string {
  // Use explicit env var if set (avoids VirtualBox/VMware IP confusion)
  if (process.env.MIKROTIK_SERVER_IP) return process.env.MIKROTIK_SERVER_IP;
  const nets = networkInterfaces();
  // Prefer the interface on the same subnet as MikroTik (192.168.88.x)
  const mikrotikSubnet = (process.env.MIKROTIK_HOST || '192.168.88.1').split('.').slice(0, 3).join('.');
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]!) {
      if (net.family === 'IPv4' && !net.internal && net.address.startsWith(mikrotikSubnet + '.')) {
        return net.address;
      }
    }
  }
  // Fallback: first non-internal IPv4
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]!) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return '127.0.0.1';
}

// ── Helper: MikroTik auth header ──────────────────────────────────────────────
function mtAuth(): string {
  return 'Basic ' + Buffer.from(`${process.env.MIKROTIK_USER}:${process.env.MIKROTIK_PASS}`).toString('base64');
}
function mtBase(): string {
  return `http://${process.env.MIKROTIK_HOST}/rest`;
}

const app = express();
const httpServer = createServer(app);

const io = new SocketServer(httpServer, {
  cors: { origin: '*', methods: ['GET', 'POST', 'DELETE', 'PATCH'] },
});

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.set('trust proxy', 1);

app.use(express.static(path.join(process.cwd(), 'client'), {
  etag: false, lastModified: false,
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
  },
}));

// ── API Routes ────────────────────────────────────────────────────────────────
app.use('/api/auth',      authRoutes);
app.use('/api/rooms',     roomRoutes);
app.use('/api/vouchers',  voucherRoutes);
app.use('/api/sessions',  sessionRoutes);
app.use('/api/vaps',      vapRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/audit',     auditRoutes);

// ── Health ────────────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

// ── MikroTik: info / test ─────────────────────────────────────────────────────
app.get('/api/mikrotik/test', async (_req, res) => res.json(await mikrotikTest()));

app.get('/api/mikrotik/firewall-status', async (_req, res) => res.json(await mikrotikGetFirewallStatus()));

app.get('/api/mikrotik/rules', async (_req, res) => {
  if (!process.env.MIKROTIK_HOST) { res.json({ error: 'no MIKROTIK_HOST' }); return; }
  try {
    const r = await fetch(`${mtBase()}/ip/firewall/filter`, { headers: { Authorization: mtAuth() }, signal: AbortSignal.timeout(5000) });
    res.json(await r.json());
  } catch (e: any) { res.json({ error: e.message }); }
});

app.get('/api/mikrotik/nat', async (_req, res) => {
  if (!process.env.MIKROTIK_HOST) { res.json({ error: 'no MIKROTIK_HOST' }); return; }
  try {
    const r = await fetch(`${mtBase()}/ip/firewall/nat`, { headers: { Authorization: mtAuth() }, signal: AbortSignal.timeout(5000) });
    res.json(await r.json());
  } catch (e: any) { res.json({ error: e.message }); }
});

app.get('/api/mikrotik/guests', async (_req, res) => {
  if (!process.env.MIKROTIK_HOST) { res.json({ error: 'no MIKROTIK_HOST' }); return; }
  try {
    const r = await fetch(`${mtBase()}/ip/firewall/address-list?list=allowed_guests`, { headers: { Authorization: mtAuth() }, signal: AbortSignal.timeout(4000) });
    res.json({ ok: r.ok, list: await r.json() });
  } catch (e: any) { res.json({ error: e.message }); }
});

app.get('/api/mikrotik/probe', async (_req, res) => {
  if (!process.env.MIKROTIK_HOST) { res.json({ error: 'MIKROTIK_HOST not set' }); return; }
  const out: Record<string, any> = {};
  try {
    const r = await fetch(`${mtBase()}/system/identity`, { headers: { Authorization: mtAuth() }, signal: AbortSignal.timeout(4000) });
    out.identity = { ok: r.ok, body: await r.text() };
  } catch (e: any) { out.identity = { error: e.message }; }
  try {
    const r = await fetch(`${mtBase()}/ip/firewall/address-list?list=allowed_guests`, { headers: { Authorization: mtAuth() }, signal: AbortSignal.timeout(4000) });
    out.address_list = { ok: r.ok, body: await r.text() };
  } catch (e: any) { out.address_list = { error: e.message }; }
  let id: string | null = null;
  try {
    const r = await fetch(`${mtBase()}/ip/firewall/address-list`, {
      method: 'PUT', headers: { Authorization: mtAuth(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ list: 'allowed_guests', address: '10.255.255.254', comment: 'probe-test', timeout: '00:01:00' }),
      signal: AbortSignal.timeout(4000),
    });
    const b = await r.text();
    out.write = { ok: r.ok, body: b };
    if (r.ok) { try { id = JSON.parse(b)['.id']; } catch {} }
  } catch (e: any) { out.write = { error: e.message }; }
  if (id) {
    try {
      const r = await fetch(`${mtBase()}/ip/firewall/address-list/${id}`, { method: 'DELETE', headers: { Authorization: mtAuth() }, signal: AbortSignal.timeout(4000) });
      out.delete = { ok: r.ok };
    } catch (e: any) { out.delete = { error: e.message }; }
  }
  res.json(out);
});

// ── MikroTik: setup / fix ─────────────────────────────────────────────────────
app.post('/api/mikrotik/setup-firewall', async (req, res) => {
  const iface = req.body?.interface || (process.env.MIKROTIK_BRIDGE || 'bridge1');
  res.json(await mikrotikSetupFirewall(iface));
});

app.post('/api/mikrotik/fix-rules', async (_req, res) => {
  if (!process.env.MIKROTIK_HOST) { res.json({ error: 'no MIKROTIK_HOST' }); return; }
  const results: string[] = [];
  for (const id of ['*D', '*11', '*12', '*13', '*14']) {
    try {
      const r = await fetch(`${mtBase()}/ip/firewall/filter/${id}`, {
        method: 'PATCH', headers: { Authorization: mtAuth(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ 'src-address-list': 'allowed_guests' }), signal: AbortSignal.timeout(5000),
      });
      results.push(r.ok ? `✅ Rule ${id}: added src-address-list=allowed_guests` : `❌ Rule ${id}: ${r.status} ${await r.text()}`);
    } catch (e: any) { results.push(`❌ Rule ${id}: ${e.message}`); }
  }
  res.json({ results });
});

app.post('/api/mikrotik/fix-block-rule', async (_req, res) => {
  if (!process.env.MIKROTIK_HOST) { res.json({ error: 'no MIKROTIK_HOST' }); return; }
  const results: string[] = [];
  try {
    // Revert portal-block (*10) back to DROP (no protocol restriction — blocks all)
    // The tcp-reset approach breaks non-TCP traffic blocking
    const r1 = await fetch(`${mtBase()}/ip/firewall/filter/*10`, {
      method: 'PATCH', headers: { Authorization: mtAuth(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'drop', protocol: '', 'reject-with': '' }),
      signal: AbortSignal.timeout(5000),
    });
    results.push(r1.ok ? '✅ portal-block restored to DROP (all protocols)' : `❌ portal-block restore: ${r1.status} ${await r1.text()}`);

    // Remove portal-block-udp if it was added — it causes duplication
    const rulesRes = await fetch(`${mtBase()}/ip/firewall/filter`, { headers: { Authorization: mtAuth() }, signal: AbortSignal.timeout(5000) });
    const rules: any[] = await rulesRes.json() as any[];
    const udpBlock = rules.find(r => r.comment === 'portal-block-udp');
    if (udpBlock) {
      const r2 = await fetch(`${mtBase()}/ip/firewall/filter/${udpBlock['.id']}`, {
        method: 'DELETE', headers: { Authorization: mtAuth() }, signal: AbortSignal.timeout(5000),
      });
      results.push(r2.ok ? '✅ portal-block-udp removed' : `❌ remove portal-block-udp: ${r2.status}`);
    } else {
      results.push('⏭️  portal-block-udp not found');
    }

    res.json({ ok: results.every(r => r.startsWith('✅') || r.startsWith('⏭')), results });
  } catch (e: any) { res.json({ error: e.message, results }); }
});

// Setup captive portal NAT redirect on MikroTik
app.post('/api/mikrotik/setup-captive-portal', async (req, res) => {
  if (!process.env.MIKROTIK_HOST) { res.json({ error: 'no MIKROTIK_HOST' }); return; }
  // Use explicit env var — auto-detect picks wrong interface on multi-NIC machines
  const serverIp   = req.body?.serverIp   || process.env.MIKROTIK_SERVER_IP || '192.168.88.2';
  const serverPort = req.body?.serverPort || 8080;
  const results: string[] = [];

  try {
    const natRes = await fetch(`${mtBase()}/ip/firewall/nat`, { headers: { Authorization: mtAuth() }, signal: AbortSignal.timeout(5000) });
    const natRules: any[] = await natRes.json() as any[];

    // HTTP redirect
    const hasHttp = natRules.some(r => r.action === 'dst-nat' && r['to-addresses'] === serverIp && r.comment?.includes('captive-portal'));
    if (hasHttp) {
      results.push('⏭️  HTTP NAT redirect already exists');
    } else {
      const r = await fetch(`${mtBase()}/ip/firewall/nat`, {
        method: 'PUT', headers: { Authorization: mtAuth(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ chain: 'dstnat', action: 'dst-nat', protocol: 'tcp', 'dst-port': '80', 'src-address-list': '!allowed_guests', 'to-addresses': serverIp, 'to-ports': String(serverPort), comment: 'captive-portal: redirect HTTP' }),
        signal: AbortSignal.timeout(5000),
      });
      results.push(r.ok ? `✅ HTTP redirect → ${serverIp}:${serverPort}` : `❌ HTTP redirect: ${r.status} ${await r.text()}`);
    }

    // HTTPS redirect (port 443 → 8443) — required for iOS 14+ and Android 10+ captive portal detection
    const hasHttps = natRules.some(r => r.action === 'dst-nat' && r['dst-port'] === '443' && r['to-addresses'] === serverIp);
    if (hasHttps) {
      results.push('⏭️  HTTPS NAT redirect already exists');
    } else {
      const r = await fetch(`${mtBase()}/ip/firewall/nat`, {
        method: 'PUT', headers: { Authorization: mtAuth(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ chain: 'dstnat', action: 'dst-nat', protocol: 'tcp', 'dst-port': '443', 'src-address-list': '!allowed_guests', 'to-addresses': serverIp, 'to-ports': '8443', comment: 'captive-portal: redirect HTTPS' }),
        signal: AbortSignal.timeout(5000),
      });
      results.push(r.ok ? `✅ HTTPS redirect → ${serverIp}:8443` : `❌ HTTPS redirect: ${r.status} ${await r.text()}`);
    }

    res.json({ ok: true, serverIp, serverPort, results });
  } catch (e: any) { res.json({ error: e.message, results }); }
});

// POST /api/mikrotik/bypass-device  (admin — add TV/device directly to allowed_guests)
// Use this for Smart TVs that can't complete the captive portal.
// Provide either ip or mac (or both). Duration defaults to 24h.
app.post('/api/mikrotik/bypass-device', async (req, res) => {
  if (!process.env.MIKROTIK_HOST) { res.json({ error: 'no MIKROTIK_HOST' }); return; }
  const { ip, mac, duration_hours = 24, label = 'Bypassed Device', room_id } = req.body;
  if (!ip && !mac) { res.status(400).json({ error: 'Provide ip or mac' }); return; }

  const results: string[] = [];

  try {
    // 1. Get or create system voucher for bypassed devices
    const [vouchers] = await pool.query<any[]>(
      'SELECT id FROM vouchers WHERE code = ? LIMIT 1',
      ['SYSTEM_BYPASS']
    );
    
    let systemVoucherId: number;
    if (vouchers.length === 0) {
      // Create system voucher
      const [voucherResult] = await pool.query<any>(
        'INSERT INTO vouchers (code, room_id, duration_hours, max_devices, is_used, is_active) VALUES (?, NULL, 999999, 999, TRUE, TRUE)',
        ['SYSTEM_BYPASS']
      );
      systemVoucherId = voucherResult.insertId;
      results.push('📝 Created system bypass voucher');
    } else {
      systemVoucherId = vouchers[0].id;
    }

    // 2. Add device to MikroTik
    if (ip) {
      const ok = await mikrotikAllowGuest(ip, 0, label, Number(duration_hours));
      results.push(ok ? `✅ IP ${ip} added to allowed_guests for ${duration_hours}h` : `❌ Failed to add IP ${ip}`);
      
      // 3. Create session record in database
      if (ok) {
        const [sessionResult] = await pool.query<any>(
          'INSERT INTO sessions (voucher_id, device_mac, device_name, ip_address, vap_id, is_active) VALUES (?, ?, ?, ?, NULL, TRUE)',
          [systemVoucherId, mac || null, label, ip]
        );
        results.push(`📊 Session #${sessionResult.insertId} recorded`);
        
        // Emit socket event so admin dashboard updates
        io.emit('session:connected', {
          sessionId: sessionResult.insertId,
          ip,
          deviceName: label,
          voucher: 'SYSTEM_BYPASS',
        });
      }
    }

    if (mac) {
      // Add MAC to MikroTik ARP static entry so it gets a consistent IP,
      // then add it to address-list. For pure MAC bypass, we add to a
      // separate bypass_devices list that the firewall ACCEPT rule also covers.
      const days = Math.floor(Number(duration_hours) / 24);
      const remH = Number(duration_hours) % 24;
      const timeout = days > 0
        ? `${days}d${String(remH).padStart(2, '0')}:00:00`
        : `${String(duration_hours).padStart(2, '0')}:00:00`;

      const r = await fetch(`http://${process.env.MIKROTIK_HOST}/rest/ip/firewall/address-list`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: 'Basic ' + Buffer.from(`${process.env.MIKROTIK_USER}:${process.env.MIKROTIK_PASS}`).toString('base64') },
        body: JSON.stringify({
          list: 'allowed_guests',
          address: mac,
          comment: `Bypassed: ${label}`,
          timeout,
        }),
        signal: AbortSignal.timeout(5000),
      });
      results.push(r.ok ? `✅ MAC ${mac} added to allowed_guests for ${duration_hours}h` : `❌ Failed to add MAC: ${await r.text()}`);
    }

    res.json({ ok: results.every(r => r.startsWith('✅') || r.startsWith('📝') || r.startsWith('📊')), results });
  } catch (e: any) { res.json({ error: e.message, results }); }
});

// Manual IP remove + flush for testing
app.get('/api/mikrotik/remove', async (req, res) => {
  const ip = req.query.ip as string;
  if (!ip) { res.json({ error: 'pass ?ip=x.x.x.x' }); return; }
  const removed = await mikrotikRemoveGuestByIp(ip);
  const flushed = await mikrotikFlushConntrack(ip);
  res.json({ removed, flushed, ip });
});

// Get all MikroTik simple queues (for admin bandwidth monitoring panel)
app.get('/api/mikrotik/queues', async (_req, res) => {
  if (!process.env.MIKROTIK_HOST) { res.json([]); return; }
  try {
    const r = await fetch(
      `http://${process.env.MIKROTIK_HOST}/rest/queue/simple`,
      { headers: { Authorization: 'Basic ' + Buffer.from(`${process.env.MIKROTIK_USER}:${process.env.MIKROTIK_PASS}`).toString('base64') }, signal: AbortSignal.timeout(5000) }
    );
    const queues: any[] = await r.json() as any[];
    // Only return hotel-managed queues
    res.json(queues.filter((q: any) => q.name?.startsWith('hotel-session-')));
  } catch (e: any) { res.json([]); }
});

// ── Captive portal detection URLs ─────────────────────────────────────────────
// Handles probe URLs from all major OSes and Smart TV platforms.
// The redirect goes to port 8080 (captive portal listener) so the TV/phone
// gets the guest portal page without needing HTTPS.
const portalUrl = () => `http://${getServerIp()}:8080/guest`;

// Android / ChromeOS
app.get('/generate_204',              (_req, res) => res.redirect(302, portalUrl()));
app.get('/gen_204',                   (_req, res) => res.redirect(302, portalUrl()));
app.get('/connecttest.txt',           (_req, res) => res.redirect(302, portalUrl()));

// Apple (iOS, macOS, Apple TV)
app.get('/hotspot-detect.html',       (_req, res) => res.redirect(302, portalUrl()));
app.get('/library/test/success.html', (_req, res) => res.redirect(302, portalUrl()));
app.get('/bag',                       (_req, res) => res.redirect(302, portalUrl()));

// Windows / Microsoft
app.get('/ncsi.txt',                  (_req, res) => res.redirect(302, portalUrl()));
app.get('/redirect',                  (_req, res) => res.redirect(302, portalUrl()));
app.get('/success.txt',               (_req, res) => res.redirect(302, portalUrl()));

// Samsung Smart TV (Tizen OS)
app.get('/captiveportal/login',       (_req, res) => res.redirect(302, portalUrl()));
app.get('/generate204',               (_req, res) => res.redirect(302, portalUrl()));

// LG Smart TV (webOS)
app.get('/check.js',                  (_req, res) => res.redirect(302, portalUrl()));

// Android TV / Google TV
app.get('/generate_204',              (_req, res) => res.redirect(302, portalUrl()));

// Catch-all for any HTTP request that looks like a captive portal probe
// (unknown host, non-API path) — redirect to guest portal
app.use((req, res, next) => {
  const host = req.headers.host || '';
  const isLocalHost = host.startsWith('localhost') || host.startsWith('127.') || host.startsWith('192.168.');
  const isApi = req.path.startsWith('/api') || req.path.startsWith('/socket.io') || req.path.startsWith('/guest') || req.path === '/health' || req.path === '/favicon.ico';
  // If request came to an unexpected external host (TV trying to reach google.com etc.)
  // and it's not a local API call, redirect to captive portal
  if (!isLocalHost && !isApi) {
    return res.redirect(302, portalUrl());
  }
  next();
});

// ── Utility ───────────────────────────────────────────────────────────────────
app.get('/api/socket-config', (_req, res) => {
  res.json({ socketUrl: `http://${getServerIp()}:${process.env.PORT || 3001}` });
});

app.get('/api/myip', (req, res) => {
  const raw = (req.headers['x-forwarded-for'] as string | undefined) || req.socket.remoteAddress || '—';
  const ip = (Array.isArray(raw) ? raw[0] : raw).replace(/^::ffff:/, '').trim();
  res.json({ ip });
});

app.get('/api/logs', (_req, res) => res.json(recentLogs.slice().reverse()));

app.get('/api/serverip', (_req, res) => {
  const ip = getServerIp();
  const PORT = process.env.PORT || 3001;
  res.json({ ip, guestUrl: `http://${ip}:${PORT}/guest` });
});

app.get('/favicon.ico', (_req, res) => {
  res.setHeader('Content-Type', 'image/svg+xml');
  res.send('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">🏨</text></svg>');
});

app.get('/guest', (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.sendFile(path.join(process.cwd(), 'client', 'guest.html'));
});

app.use(errorHandler);

// ── Socket.IO ─────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`[Socket] Client connected: ${socket.id}`);
  socket.on('disconnect', () => console.log(`[Socket] Client disconnected: ${socket.id}`));
});

export { io };

// ── Start main server ─────────────────────────────────────────────────────────
const PORT = Number(process.env.PORT) || 3001;
httpServer.listen(PORT, '0.0.0.0', () => {
  const ip = getServerIp();
  console.log(`\n🏨  Hotel WiFi Manager running`);
  console.log(`   Local:        http://localhost:${PORT}`);
  console.log(`   Network:      http://${ip}:${PORT}`);
  console.log(`   Guest portal: http://${ip}:${PORT}/guest\n`);
  startExpiryJob();
  startBandwidthJob();
});

// ── Port 8080 captive portal ──────────────────────────────────────────────────
// All unauthenticated traffic is NAT-redirected here by MikroTik.
// Smart TVs and phones hit this port when they probe for captive portals.
const portalApp = express();
portalApp.use(express.json());

// Inject real client IP before forwarding to main app
portalApp.use((req: any, _res: any, next: any) => {
  const realIp = (req.socket.remoteAddress as string | undefined)?.replace(/^::ffff:/, '') || '';
  if (realIp) req.headers['x-forwarded-for'] = realIp;
  next();
});

// Captive portal detection probe URLs — serve guest portal directly (no redirect)
// so Smart TVs that don't follow redirects still get the portal page.
const serveGuestPortal = (_req: any, res: any) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.sendFile(path.join(process.cwd(), 'client', 'guest.html'));
};
portalApp.get('/generate_204',              serveGuestPortal);
portalApp.get('/gen_204',                   serveGuestPortal);
portalApp.get('/generate204',               serveGuestPortal);
portalApp.get('/hotspot-detect.html',       serveGuestPortal);
portalApp.get('/library/test/success.html', serveGuestPortal);
portalApp.get('/ncsi.txt',                  serveGuestPortal);
portalApp.get('/connecttest.txt',           serveGuestPortal);
portalApp.get('/success.txt',               serveGuestPortal);
portalApp.get('/captiveportal/login',       serveGuestPortal);
portalApp.get('/check.js',                  serveGuestPortal);
portalApp.get('/bag',                       serveGuestPortal);
portalApp.get('/redirect',                  serveGuestPortal);

portalApp.use('/api', (req: any, res: any, next: any) => { req.url = '/api' + req.url; (app as any)(req, res, next); });
portalApp.use('/socket.io', (req: any, res: any, next: any) => { (app as any)(req, res, next); });
portalApp.get('/style.css', (_req, res) => res.sendFile(path.join(process.cwd(), 'client', 'style.css')));
portalApp.use(serveGuestPortal);

createHttpServer(portalApp).listen(8080, '0.0.0.0', () => {
  console.log('   Captive portal listener: http://192.168.88.2:8080 → guest portal');
});

// ── Port 8443 HTTPS captive portal ────────────────────────────────────────────
// iOS 14+ and Android 10+ probe captive portals via HTTPS (port 443).
// MikroTik NAT redirects port 443 → 8443 on this server.
// We serve guest.html over HTTPS so the OS shows the captive portal popup.
const tlsCreds = ensureTlsCertificate();
if (tlsCreds) {
  const httpsPortalApp = express();
  httpsPortalApp.use(express.json());

  // Inject real client IP
  httpsPortalApp.use((req: any, _res: any, next: any) => {
    const realIp = (req.socket.remoteAddress as string | undefined)?.replace(/^::ffff:/, '') || '';
    if (realIp) req.headers['x-forwarded-for'] = realIp;
    next();
  });

  const serveGuestPortalHttps = (_req: any, res: any) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.sendFile(path.join(process.cwd(), 'client', 'guest.html'));
  };

  // All captive portal detection URLs — iOS, Android, Windows
  httpsPortalApp.get('/hotspot-detect.html',       serveGuestPortalHttps);
  httpsPortalApp.get('/library/test/success.html', serveGuestPortalHttps);
  httpsPortalApp.get('/generate_204',              (_req: any, res: any) => res.status(204).send());
  httpsPortalApp.get('/gen_204',                   (_req: any, res: any) => res.status(204).send());
  httpsPortalApp.get('/generate204',               (_req: any, res: any) => res.status(204).send());
  httpsPortalApp.get('/ncsi.txt',                  serveGuestPortalHttps);
  httpsPortalApp.get('/connecttest.txt',           serveGuestPortalHttps);
  httpsPortalApp.get('/success.txt',               serveGuestPortalHttps);
  httpsPortalApp.get('/bag',                       serveGuestPortalHttps);
  httpsPortalApp.get('/redirect',                  serveGuestPortalHttps);
  httpsPortalApp.get('/captiveportal/login',       serveGuestPortalHttps);
  httpsPortalApp.get('/check.js',                  serveGuestPortalHttps);
  httpsPortalApp.get('/style.css', (_req: any, res: any) => res.sendFile(path.join(process.cwd(), 'client', 'style.css')));
  httpsPortalApp.use('/api', (req: any, res: any, next: any) => { req.url = '/api' + req.url; (app as any)(req, res, next); });
  httpsPortalApp.use(serveGuestPortalHttps);

  createHttpsServer(tlsCreds, httpsPortalApp).listen(8443, '0.0.0.0', () => {
    const ip = getServerIp();
    console.log(`   HTTPS captive portal listener: https://${ip}:8443 → guest portal (iOS 14+ / Android 10+)`);
  });
} else {
  console.warn('[HTTPS] ⚠️  HTTPS captive portal disabled — run setup-captive-portal after generating a certificate');
}
