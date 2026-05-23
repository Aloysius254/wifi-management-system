const API = window.location.origin + '/api';
let token = localStorage.getItem('token') || null;
const events = [];

// ===== Socket.IO real-time =====
const socket = io(window.location.origin);

socket.on('connect', () => addEvent('🟢', 'Server connected', 'Real-time updates active'));
socket.on('disconnect', () => addEvent('🔴', 'Server disconnected', ''));

socket.on('session:new', (data) => {
  addEvent('📱', `New device connected`, `Room ${data.room_number || '—'} — ${data.device_name || data.ip_address || 'Unknown'}`);
  if (activeTab === 'sessions') loadSessions();
  if (activeTab === 'overview') loadOverview();
});

socket.on('session:disconnected', (data) => {
  addEvent('👋', `Device disconnected`, `Session #${data.sessionId}`);
  if (activeTab === 'sessions') loadSessions();
  if (activeTab === 'overview') loadOverview();
});

socket.on('session:throttled', (data) => {
  addEvent('⚡', `Device throttled`, `Session #${data.sessionId} — ${data.usage_mbps} Mbps`);
  if (activeTab === 'sessions') loadSessions();
});

socket.on('session:unthrottled', (data) => {
  addEvent('✅', `Throttle lifted`, `Session #${data.sessionId}`);
  if (activeTab === 'sessions') loadSessions();
});

socket.on('isolation:blocked', (data) => {
  addEvent('🔒', `Isolation blocked`, `Room ${data.source.room} → Room ${data.target.room}`);
  if (activeTab === 'vaps') loadIsolationEvents();
});

socket.on('bandwidth:update', (data) => {
  // Update bandwidth cell live
  const cell = document.getElementById(`bw-${data.sessionId}`);
  if (cell) {
    cell.textContent = `${data.usage_mbps} Mbps`;
    cell.style.color = data.is_throttled ? 'var(--danger)' : 'var(--success)';
  }
});

function addEvent(icon, title, detail) {
  events.unshift({ icon, title, detail, time: new Date() });
  if (events.length > 50) events.pop();
  renderEvents();
}

function renderEvents() {
  const tbody = document.getElementById('events-log');
  if (!tbody) return;
  tbody.innerHTML = events.slice(0, 20).map(e => `
    <tr>
      <td style="white-space:nowrap;color:var(--text-muted);font-size:.8rem">${e.time.toLocaleTimeString()}</td>
      <td>${e.icon} ${e.title}</td>
      <td style="color:var(--text-muted)">${e.detail}</td>
    </tr>
  `).join('') || '<tr><td colspan="3" style="text-align:center;color:var(--text-muted);padding:1.5rem">No events yet</td></tr>';
}

// ===== Auth =====
const authHeaders = () => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${token}` });

async function apiFetch(path, options = {}) {
  const res = await fetch(`${API}${path}`, { headers: authHeaders(), ...options });
  if (res.status === 401) { logout(); return null; }
  return res;
}

function showDashboard() {
  document.getElementById('login-screen').classList.add('hidden');
  document.getElementById('dashboard').classList.remove('hidden');
  // Ensure overview tab is active
  document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('tab-overview').classList.add('active');
  document.querySelector('[data-tab="overview"]').classList.add('active');
  activeTab = 'overview';
  loadOverview();
}

function showLogin() {
  document.getElementById('login-screen').classList.remove('hidden');
  document.getElementById('dashboard').classList.add('hidden');
}

function logout() {
  token = null;
  localStorage.removeItem('token');
  showLogin();
}

document.getElementById('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = document.getElementById('username').value.trim();
  const password = document.getElementById('password').value;
  const errEl = document.getElementById('login-error');
  errEl.classList.add('hidden');
  try {
    const res = await fetch(`${API}/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json();
    if (!res.ok) { errEl.textContent = data.error || 'Login failed'; errEl.classList.remove('hidden'); return; }
    token = data.token;
    localStorage.setItem('token', token);
    showDashboard();
  } catch {
    errEl.textContent = 'Cannot connect to server';
    errEl.classList.remove('hidden');
  }
});

document.getElementById('logout-btn').addEventListener('click', logout);

// ===== Tabs =====
let activeTab = 'overview';
document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
    btn.classList.add('active');
    activeTab = btn.dataset.tab;
    document.getElementById(`tab-${activeTab}`).classList.add('active');
    if (activeTab === 'overview') loadOverview();
    if (activeTab === 'sessions') loadSessions();
    if (activeTab === 'vaps') { loadVaps(); loadIsolationEvents(); }
    if (activeTab === 'vouchers') loadVouchers();
    if (activeTab === 'rooms') loadRooms();
  });
});

// ===== Overview =====
async function loadOverview() {
  const [rooms, vouchers, sessions, vaps, isoEvents] = await Promise.all([
    apiFetch('/rooms').then(r => r?.json()),
    apiFetch('/vouchers').then(r => r?.json()),
    apiFetch('/sessions').then(r => r?.json()),
    apiFetch('/vaps').then(r => r?.json()),
    apiFetch('/sessions/isolation-events').then(r => r?.json()),
  ]);
  if (rooms) document.getElementById('stat-rooms').textContent = rooms.length;
  if (sessions) {
    document.getElementById('stat-sessions').textContent = sessions.length;
    document.getElementById('stat-throttled').textContent = sessions.filter(s => s.is_throttled).length;
  }
  if (vouchers) document.getElementById('stat-vouchers').textContent = vouchers.filter(v => v.is_active && !v.is_used).length;
  if (vaps) document.getElementById('stat-isolated').textContent = vaps.filter(v => v.is_isolated).length;
  if (isoEvents) document.getElementById('stat-blocked').textContent = isoEvents.length;
  renderEvents();
}

// ===== Sessions =====
async function loadSessions() {
  const res = await apiFetch('/sessions');
  if (!res) return;
  const sessions = await res.json();
  const tbody = document.getElementById('sessions-tbody');
  tbody.innerHTML = sessions.length === 0
    ? '<tr><td colspan="8" style="text-align:center;color:var(--text-muted);padding:2rem">No active sessions</td></tr>'
    : sessions.map(s => `
      <tr>
        <td><strong>${s.room_number || '—'}</strong></td>
        <td>${s.vap_id ? `<span class="badge badge-muted">VAP-${s.vap_id} / VLAN-${s.vlan_id || '?'}</span>` : '—'}</td>
        <td>${s.device_name || '—'}</td>
        <td><code>${s.ip_address || '—'}</code></td>
        <td style="font-size:.8rem;color:var(--text-muted)">${new Date(s.connected_at).toLocaleTimeString()}</td>
        <td id="bw-${s.id}" style="color:${s.avg_usage_mbps > 0 ? 'var(--text)' : 'var(--text-muted)'}">
          ${s.avg_usage_mbps > 0 ? s.avg_usage_mbps + ' Mbps' : '—'}
        </td>
        <td>
          ${s.is_throttled
            ? '<span class="badge badge-danger">⚡ Throttled</span>'
            : '<span class="badge badge-success">✅ Normal</span>'}
          ${s.is_isolated ? '<span class="badge badge-muted" style="margin-left:.25rem">🔒 Isolated</span>' : ''}
        </td>
        <td><button class="btn btn-sm btn-danger" onclick="disconnectSession(${s.id})">Disconnect</button></td>
      </tr>
    `).join('');
}

document.getElementById('refresh-sessions-btn').addEventListener('click', loadSessions);

async function disconnectSession(id) {
  if (!confirm('Disconnect this device?')) return;
  await apiFetch(`/sessions/${id}`, { method: 'DELETE' });
  loadSessions();
}

// Simulate bandwidth
document.getElementById('sim-btn').addEventListener('click', async () => {
  const sessionId = document.getElementById('sim-session-id').value;
  const usage = document.getElementById('sim-usage').value;
  const resultEl = document.getElementById('sim-result');
  if (!sessionId || !usage) { resultEl.textContent = 'Enter session ID and usage'; return; }
  const res = await apiFetch(`/sessions/${sessionId}/simulate-usage`, {
    method: 'POST', body: JSON.stringify({ usage_mbps: parseFloat(usage) }),
  });
  if (!res) return;
  const data = await res.json();
  resultEl.textContent = data.is_throttled
    ? `⚡ Session #${sessionId} THROTTLED — ${usage} Mbps exceeds ${data.threshold} Mbps threshold`
    : `✅ Session #${sessionId} normal — ${usage} Mbps (threshold: ${data.threshold} Mbps)`;
  resultEl.style.color = data.is_throttled ? 'var(--danger)' : 'var(--success)';
  loadSessions();
});

// ===== VAPs =====
async function loadVaps() {
  const res = await apiFetch('/vaps');
  if (!res) return;
  const vaps = await res.json();
  const tbody = document.getElementById('vaps-tbody');
  tbody.innerHTML = vaps.map(v => `
    <tr>
      <td><strong>${v.room_number}</strong> <span style="color:var(--text-muted);font-size:.8rem">Floor ${v.floor}</span></td>
      <td><span class="badge badge-muted">VLAN ${v.vlan_id}</span></td>
      <td>${v.bandwidth_limit_mbps} Mbps</td>
      <td>${v.throttle_threshold_mbps} Mbps</td>
      <td>${v.is_isolated
        ? '<span class="badge badge-success">🔒 Isolated</span>'
        : '<span class="badge badge-warning">⚠️ Open</span>'}</td>
      <td>${v.active_devices}</td>
      <td>${v.throttled_devices > 0 ? `<span class="badge badge-danger">${v.throttled_devices}</span>` : '0'}</td>
    </tr>
  `).join('');
}

async function loadIsolationEvents() {
  const res = await apiFetch('/sessions/isolation-events');
  if (!res) return;
  const events = await res.json();
  const tbody = document.getElementById('isolation-tbody');
  tbody.innerHTML = events.length === 0
    ? '<tr><td colspan="5" style="text-align:center;color:var(--text-muted);padding:1.5rem">No isolation events yet</td></tr>'
    : events.map(e => `
      <tr>
        <td style="font-size:.8rem;color:var(--text-muted)">${new Date(e.occurred_at).toLocaleString()}</td>
        <td>Room ${e.source_room || '—'} <code style="font-size:.75rem">${e.source_ip || ''}</code></td>
        <td>Room ${e.target_room || '—'} <code style="font-size:.75rem">${e.target_ip || ''}</code></td>
        <td><span class="badge badge-danger">${e.action}</span></td>
        <td style="font-size:.8rem;color:var(--text-muted)">${e.reason}</td>
      </tr>
    `).join('');
}

// Isolation check
document.getElementById('iso-check-btn').addEventListener('click', async () => {
  const source = parseInt(document.getElementById('iso-source').value);
  const target = parseInt(document.getElementById('iso-target').value);
  const resultEl = document.getElementById('iso-result');
  if (!source || !target) { alert('Enter both session IDs'); return; }
  const res = await apiFetch('/sessions/check-isolation', {
    method: 'POST', body: JSON.stringify({ source_session_id: source, target_session_id: target }),
  });
  if (!res) return;
  const data = await res.json();
  resultEl.style.display = 'block';
  resultEl.style.background = data.blocked ? '#fee2e2' : '#f0fdf4';
  resultEl.style.borderLeft = `4px solid ${data.blocked ? 'var(--danger)' : 'var(--success)'}`;
  resultEl.innerHTML = `
    <strong>${data.blocked ? '🔒 BLOCKED' : '✅ ALLOWED'}</strong><br>
    <span style="color:var(--text-muted)">${data.reason}</span><br>
    <span style="font-size:.8rem;color:var(--text-muted)">Source VAP: ${data.source_vap} | Target VAP: ${data.target_vap}</span>
  `;
  loadIsolationEvents();
});

// ===== Vouchers =====
async function loadVouchers() {
  const res = await apiFetch('/vouchers');
  if (!res) return;
  const vouchers = await res.json();
  const tbody = document.getElementById('vouchers-tbody');
  if (!vouchers.length) {
    tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:var(--text-muted);padding:2rem">No vouchers yet — click + Create Voucher to generate one</td></tr>';
    return;
  }
  tbody.innerHTML = vouchers.map(v => {
    const expired = v.expires_at && new Date(v.expires_at) < new Date();
    const status = !v.is_active ? 'badge-muted' : expired ? 'badge-danger' : v.is_used ? 'badge-warning' : 'badge-success';
    const label = !v.is_active ? 'Inactive' : expired ? 'Expired' : v.is_used ? 'In Use' : 'Available';
    return `
      <tr>
        <td><code>${v.code}</code></td>
        <td>${v.room_number || '—'}</td>
        <td>${v.duration_hours}h</td>
        <td>${v.active_devices ?? 0} / ${v.max_devices}</td>
        <td><span class="badge ${status}">${label}</span></td>
        <td style="font-size:.8rem">${v.expires_at ? new Date(v.expires_at).toLocaleString() : '—'}</td>
        <td>${v.is_active ? `<button class="btn btn-sm btn-danger" onclick="deactivateVoucher(${v.id})">Deactivate</button>` : ''}</td>
      </tr>
    `;
  }).join('');

  // Populate room dropdown
  const roomRes = await apiFetch('/rooms');
  if (!roomRes) return;
  const rooms = await roomRes.json();
  document.getElementById('voucher-room').innerHTML =
    '<option value="">— No room —</option>' + rooms.map(r => `<option value="${r.id}">${r.room_number}</option>`).join('');
}

document.getElementById('create-voucher-btn').addEventListener('click', () => {
  document.getElementById('voucher-form-card').classList.toggle('hidden');
});
document.getElementById('cancel-voucher-btn').addEventListener('click', () => {
  document.getElementById('voucher-form-card').classList.add('hidden');
});
document.getElementById('voucher-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const room_id = document.getElementById('voucher-room').value || null;
  const duration_hours = parseInt(document.getElementById('voucher-duration').value);
  const max_devices = parseInt(document.getElementById('voucher-devices').value);
  const quantity = parseInt(document.getElementById('voucher-quantity').value);
  const res = await apiFetch('/vouchers', { method: 'POST', body: JSON.stringify({ room_id, duration_hours, max_devices, quantity }) });
  if (!res) return;
  if (!res.ok) { const d = await res.json(); alert(d.error); return; }
  document.getElementById('voucher-form').reset();
  document.getElementById('voucher-form-card').classList.add('hidden');
  loadVouchers();
});

async function deactivateVoucher(id) {
  if (!confirm('Deactivate this voucher?')) return;
  await apiFetch(`/vouchers/${id}`, { method: 'DELETE' });
  loadVouchers();
}

// ===== Rooms =====
async function loadRooms() {
  const [roomRes, vapRes] = await Promise.all([apiFetch('/rooms'), apiFetch('/vaps')]);
  if (!roomRes) return;
  const rooms = await roomRes.json();
  const vaps = vapRes ? await vapRes.json() : [];
  const vapMap = {};
  vaps.forEach(v => { vapMap[v.room_id] = v; });

  const tbody = document.getElementById('rooms-tbody');
  if (!rooms.length) {
    tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:var(--text-muted);padding:2rem">No rooms yet — click + Add Room</td></tr>';
    return;
  }
  tbody.innerHTML = rooms.map(r => {
    const vap = vapMap[r.id];
    return `
      <tr>
        <td><strong>${r.room_number}</strong></td>
        <td>${r.floor}</td>
        <td>${vap ? `<span class="badge badge-muted">VAP-${vap.id} / VLAN-${vap.vlan_id}</span>` : '<span class="badge badge-warning">No VAP</span>'}</td>
        <td><span class="badge ${r.is_active ? 'badge-success' : 'badge-muted'}">${r.is_active ? 'Active' : 'Inactive'}</span></td>
        <td><button class="btn btn-sm btn-danger" onclick="deleteRoom(${r.id})">Remove</button></td>
      </tr>
    `;
  }).join('');
}

document.getElementById('create-room-btn').addEventListener('click', () => {
  document.getElementById('room-form-card').classList.toggle('hidden');
});
document.getElementById('cancel-room-btn').addEventListener('click', () => {
  document.getElementById('room-form-card').classList.add('hidden');
});
document.getElementById('room-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const room_number = document.getElementById('room-number').value.trim();
  const floor = parseInt(document.getElementById('room-floor').value);
  const res = await apiFetch('/rooms', { method: 'POST', body: JSON.stringify({ room_number, floor }) });
  if (!res) return;
  if (!res.ok) { const d = await res.json(); alert(d.error); return; }
  document.getElementById('room-form').reset();
  document.getElementById('room-form-card').classList.add('hidden');
  loadRooms();
});

async function deleteRoom(id) {
  if (!confirm('Remove this room?')) return;
  await apiFetch(`/rooms/${id}`, { method: 'DELETE' });
  loadRooms();
}

// ===== Init =====
if (token) { showDashboard(); } else { showLogin(); }
