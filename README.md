# Hotel WiFi Manager

A full-stack hotel WiFi management system built with Node.js, Express, TypeScript, MySQL, and Socket.IO — with deep MikroTik RouterOS 7 integration for real bandwidth monitoring, per-room SSID isolation via dedicated bridges, and captive portal support.

## Features

- **Admin authentication** with JWT
- **Room management** — add/remove hotel rooms with per-room SSID and VLAN isolation
- **Voucher generation** — create WiFi codes with configurable duration and device limits
- **Session tracking** — monitor connected devices in real time via Socket.IO
- **Bandwidth monitoring** — real MikroTik interface counter readings with automatic throttling
- **MikroTik integration** — firewall rules, NAT redirects, simple queues, per-room bridge isolation
- **Captive portal** — HTTP (port 8080) + HTTPS (port 8443) for iOS 14+ and Android 10+ support
- **Fast reconnect** — stale conntrack entries flushed on reconnect, internet restored in seconds
- **Device bypass** — grant Smart TVs and devices direct access without voucher
- **Audit logs** — track all admin actions
- **Auto-expiry** — sessions and vouchers expire automatically

## Project Structure

```
hotel-wifi-manager/
├── client/
│   ├── index.html        # Admin dashboard (vanilla JS SPA)
│   ├── guest.html        # Captive portal / guest login page
│   └── style.css
├── database/
│   ├── schema.sql        # DB schema
│   └── seed.sql          # Default admin
├── server/
│   ├── index.ts          # Entry point, HTTP/HTTPS listeners, MikroTik endpoints
│   ├── db.ts             # MySQL connection pool
│   ├── bandwidth.ts      # Real-time bandwidth monitoring + throttle queues
│   ├── mikrotik.ts       # MikroTik REST API helpers (firewall, bridge, conntrack)
│   ├── expiry.ts         # Auto-expiry job for sessions and vouchers
│   ├── audit.ts          # Audit log helpers
│   ├── sms.ts            # SMS notifications (Africa's Talking)
│   ├── rateLimit.ts      # API rate limiting
│   ├── types.ts          # Shared TypeScript types
│   ├── ssl/              # Auto-generated self-signed TLS certificate (port 8443)
│   ├── middleware/
│   │   ├── auth.ts
│   │   └── errorHandler.ts
│   └── routes/
│       ├── auth.ts
│       ├── rooms.ts
│       ├── vouchers.ts
│       ├── sessions.ts
│       ├── vaps.ts
│       ├── analytics.ts
│       └── audit.ts
├── .env                  # Your real config (never commit this)
├── .env.example          # Template — copy to .env and fill in values
├── tsconfig.json
└── package.json
```

## Setup

### 1. Database

```bash
# Create the database and tables
mysql -u root -p < database/schema.sql

# Seed default admin
mysql -u root -p hotel_wifi < database/seed.sql
```

Default admin credentials: `admin` / `admin123` — **change this immediately**.

### 2. Environment

Copy `.env.example` to `.env` and fill in your values:

```bash
cp .env.example .env   # Linux/Mac
copy .env.example .env # Windows
```

Key variables:

| Variable | Description | Example |
|---|---|---|
| `PORT` | Server port | `3001` |
| `DB_HOST` | MySQL host | `localhost` |
| `DB_USER` | MySQL user | `root` |
| `DB_PASSWORD` | MySQL password | `yourpassword` |
| `DB_NAME` | Database name | `hotel_wifi` |
| `JWT_SECRET` | Auth secret — change this | `random_string` |
| `MIKROTIK_HOST` | MikroTik router IP | `192.168.88.1` |
| `MIKROTIK_USER` | MikroTik API user | `admin` |
| `MIKROTIK_PASS` | MikroTik API password | `yourpassword` |
| `MIKROTIK_BRIDGE` | Main bridge interface name | `bridge` |
| `MIKROTIK_SERVER_IP` | This server's IP on MikroTik network | `192.168.88.2` |
| `ROOM_N_PORT` | Wireless interface for room N | `ROOM_1_PORT=wlan1` |

### 3. Run

```bash
# Install dependencies
pnpm install

# Development (with hot reload)
pnpm dev

# Production
pnpm build
pnpm start
```

### 4. MikroTik Setup

The following must be configured directly on the MikroTik router before the system works. This is a one-time setup.

#### 4.1 Per-Room Bridges and SSIDs

Each room gets its own bridge and SSID. Example for 2 rooms on an RB951Ui:

```
# Create room bridges
/interface bridge add name=bridge-room1 comment="Room1 bridge"
/interface bridge add name=bridge-room2 comment="Room2 bridge"

# Assign wlan interfaces to room bridges
/interface bridge port add interface=wlan1 bridge=bridge-room1
/interface bridge port add interface=wlan2 bridge=bridge-room2

# Set SSIDs (open network — voucher is the auth mechanism)
/interface wireless set wlan1 ssid="Hotel-Room1" vlan-mode=no-tag
/interface wireless add name=wlan2 master-interface=wlan1 ssid="Hotel-Room2" vlan-mode=no-tag disabled=no
/interface wireless security-profiles set default mode=none

# Assign IPs to room bridges
/ip address add address=192.168.10.1/24 interface=bridge-room1
/ip address add address=192.168.20.1/24 interface=bridge-room2

# DHCP pools and servers
/ip pool add name=pool-room1 ranges=192.168.10.10-192.168.10.100
/ip pool add name=pool-room2 ranges=192.168.20.10-192.168.20.100
/ip dhcp-server add name=dhcp-room1 interface=bridge-room1 address-pool=pool-room1 lease-time=12h disabled=no
/ip dhcp-server add name=dhcp-room2 interface=bridge-room2 address-pool=pool-room2 lease-time=12h disabled=no
/ip dhcp-server network add address=192.168.10.0/24 gateway=192.168.10.1 dns-server=8.8.8.8
/ip dhcp-server network add address=192.168.20.0/24 gateway=192.168.20.1 dns-server=8.8.8.8
```

#### 4.2 Interface List for Unified Firewall Rules

```
/interface list add name=GuestNetworks
/interface list member add list=GuestNetworks interface=bridge
/interface list member add list=GuestNetworks interface=bridge-room1
/interface list member add list=GuestNetworks interface=bridge-room2
```

#### 4.3 Firewall Rules

```
# Forward chain
/ip firewall filter add chain=forward action=accept src-address=192.168.88.2 comment="server-pc-always-allowed"
/ip firewall filter add chain=forward action=accept src-address-list=allowed_guests comment="portal-allow-internet"
/ip firewall filter add chain=forward action=accept protocol=udp in-interface-list=GuestNetworks dst-port=53 comment="Hotel WiFi - allow DNS forward udp"
/ip firewall filter add chain=forward action=accept protocol=tcp in-interface-list=GuestNetworks dst-port=53 comment="Hotel WiFi - allow DNS forward tcp"
/ip firewall filter add chain=forward action=accept protocol=tcp dst-address=192.168.88.2 in-interface-list=GuestNetworks dst-port=8080,8443 comment="Hotel WiFi - allow all guests to reach portal server"
/ip firewall filter add chain=forward action=drop src-address-list=!allowed_guests in-interface-list=GuestNetworks comment="Hotel WiFi block unauthenticated guests"

# Input chain
/ip firewall filter add chain=input action=accept src-address=192.168.88.2 comment="server-pc-always-allowed-input"
/ip firewall filter add chain=input action=accept protocol=udp in-interface-list=GuestNetworks dst-port=53 comment="Hotel WiFi - allow DNS input udp"
/ip firewall filter add chain=input action=accept protocol=tcp in-interface-list=GuestNetworks dst-port=53 comment="Hotel WiFi - allow DNS input tcp"
/ip firewall filter add chain=input action=drop src-address-list=!allowed_guests in-interface-list=GuestNetworks comment="Hotel WiFi block unauthenticated access to router"
```

#### 4.4 NAT Rules

```
# Masquerade for internet access
/ip firewall nat add chain=srcnat action=masquerade out-interface-list=WAN ipsec-policy=out,none comment="defconf: masquerade"
/ip firewall nat add chain=srcnat action=masquerade src-address=192.168.88.0/24 dst-address=192.168.88.2 comment="hairpin NAT for captive portal"

# NAT for room subnets
/ip firewall nat add chain=srcnat action=masquerade out-interface=ether1 src-address=192.168.10.0/24 comment="NAT Room1 guests"
/ip firewall nat add chain=srcnat action=masquerade out-interface=ether1 src-address=192.168.20.0/24 comment="NAT Room2 guests"

# Captive portal redirect (HTTP port 80 → portal on 8080)
/ip firewall nat add chain=dstnat action=dst-nat to-addresses=192.168.88.2 to-ports=8080 protocol=tcp src-address=!192.168.88.2 src-address-list=!allowed_guests in-interface-list=GuestNetworks dst-port=80 comment="captive-portal: redirect HTTP"
```

#### 4.5 Permanent Server Entry

```
/ip firewall address-list add list=allowed_guests address=192.168.88.2 comment="server-pc-permanent"
/ip dhcp-server lease make-static [find address=192.168.88.2]
```

#### 4.6 Server PC Static Routes (run on server PC as Administrator)

```
route add 192.168.10.0 mask 255.255.255.0 192.168.88.1 -p
route add 192.168.20.0 mask 255.255.255.0 192.168.88.1 -p
```

### 5. Open the dashboard

Navigate to `https://YOUR_SERVER_IP:3443` in your browser (HTTPS recommended).

## How It Works

### Ports

| Port | Purpose |
|---|---|
| `3001` | Admin dashboard + API (HTTP) |
| `3443` | Admin dashboard + API (HTTPS) |
| `8080` | HTTP captive portal (MikroTik redirects port 80 here) |
| `8443` | HTTPS captive portal (MikroTik redirects port 443 here) |

### Network Flow

```
Guest device connects to room SSID (Hotel-Room1 or Hotel-Room2)
    → Gets IP from room DHCP pool (192.168.10.x or 192.168.20.x)
    → MikroTik checks: is IP in allowed_guests?
    → If not: NAT redirects HTTP port 80 → portal on port 8080
    → OS detects captive portal, shows popup within ~7 seconds
    → Guest enters voucher code
    → Server adds IP to MikroTik allowed_guests with session timeout
    → Guest has internet access
    → Bandwidth job monitors usage every 15s
    → If usage exceeds threshold: MikroTik simple queue throttles speed
    → On reconnect: stale conntrack entries flushed, internet restored instantly
    → On session expiry: IP removed from allowed_guests, connections flushed
```

### Room Isolation

Each room SSID is on a dedicated bridge (`bridge-room1`, `bridge-room2`) with its own subnet and DHCP pool. Guest traffic never crosses between rooms. The main management bridge (`bridge`) is reserved for the server PC and admin devices on `ether2`.

| Network | Interface | Subnet | Purpose |
|---|---|---|---|
| Management | `bridge` / `ether2` | `192.168.88.x` | Server PC, admin laptop |
| Room 1 | `bridge-room1` / `wlan1` | `192.168.10.x` | Hotel-Room1 guests |
| Room 2 | `bridge-room2` / `wlan2` | `192.168.20.x` | Hotel-Room2 guests |

### Captive Portal Detection

The `src-address=!192.168.88.2` exclusion on the NAT redirect rule prevents the server's own outbound API calls to the MikroTik router (`192.168.88.1:80/rest`) from being redirected back to the portal — which would otherwise cause a NAT loop and break all MikroTik REST API communication.

### Bandwidth Monitoring

The bandwidth job reads real traffic from MikroTik in this priority order:
1. Per-session simple queue (throttled sessions)
2. `hotel-monitor` umbrella queue
3. Bridge interface counter diff (`rx-byte`/`tx-byte`)
4. Simulation fallback (when MikroTik is unreachable)

## API Reference

### Auth
| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/api/auth/login` | — | Admin login |
| GET | `/api/auth/me` | ✓ | Current admin info |

### Rooms & VAPs
| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/api/rooms` | ✓ | List all rooms |
| POST | `/api/rooms` | ✓ | Add a room |
| DELETE | `/api/rooms/:id` | ✓ | Remove a room |
| GET | `/api/vaps` | ✓ | List VAPs with bandwidth settings |
| PATCH | `/api/vaps/:id` | ✓ | Update bandwidth limits |

### Vouchers
| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/api/vouchers` | ✓ | List vouchers |
| POST | `/api/vouchers` | ✓ | Create voucher(s) |
| GET | `/api/vouchers/check/:code` | — | Check voucher status (guest) |
| POST | `/api/vouchers/:code/activate` | — | Activate voucher (guest) |
| PATCH | `/api/vouchers/:id/extend` | ✓ | Extend voucher duration |
| DELETE | `/api/vouchers/:id` | ✓ | Deactivate voucher |
| DELETE | `/api/vouchers/:id/delete` | ✓ | Hard delete inactive voucher |

### Sessions
| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/api/sessions` | ✓ | Active sessions |
| GET | `/api/sessions/history` | ✓ | Session history |
| DELETE | `/api/sessions/:id` | — | Disconnect session (guest or admin) |
| POST | `/api/sessions/:id/throttle` | ✓ | Manually throttle/unthrottle |

### MikroTik
| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/api/mikrotik/test` | — | Connection + capability test |
| GET | `/api/mikrotik/firewall-status` | — | Current firewall rule status |
| POST | `/api/mikrotik/setup-firewall` | — | Create firewall rules |
| POST | `/api/mikrotik/bypass-device` | ✓ | Grant device access (Smart TVs) |
| GET | `/api/mikrotik/queues` | — | List active throttle queues |
| GET | `/api/mikrotik/remove` | — | Remove IP + flush conntrack (debug) |

### Other
| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/api/analytics` | ✓ | Usage stats |
| GET | `/api/audit` | ✓ | Admin audit log |
| GET | `/api/logs` | — | Recent server logs |
| GET | `/api/myip` | — | Returns caller's real IP |
| GET | `/api/socket-config` | — | Socket.IO URL for guest portal |
| GET | `/health` | — | Server health check |
