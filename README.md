# Hotel WiFi Manager

A full-stack hotel WiFi management system built with Node.js, Express, TypeScript, MySQL, and Socket.IO — with deep MikroTik RouterOS 7 integration for real bandwidth monitoring, VLAN-based room isolation, and captive portal support.

## Features

- **Admin authentication** with JWT
- **Room management** — add/remove hotel rooms with VLAN isolation
- **Voucher generation** — create WiFi codes with configurable duration and device limits
- **Session tracking** — monitor connected devices in real time via Socket.IO
- **Bandwidth monitoring** — real MikroTik interface counter readings with automatic throttling
- **MikroTik integration** — firewall rules, NAT redirects, simple queues, bridge VLAN filtering
- **Captive portal** — HTTP (port 8080) + HTTPS (port 8443) for iOS 14+ and Android 10+ support
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
│   └── seed.sql          # Default admin + sample rooms
├── server/
│   ├── index.ts          # Entry point, HTTP/HTTPS listeners, MikroTik endpoints
│   ├── db.ts             # MySQL connection pool
│   ├── bandwidth.ts      # Real-time bandwidth monitoring + throttle queues
│   ├── mikrotik.ts       # MikroTik REST API helpers (firewall, VLAN, bridge)
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

# Seed default admin and sample rooms
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
| `MIKROTIK_BRIDGE` | Bridge interface name | `bridge` |
| `MIKROTIK_SERVER_IP` | This server's IP on MikroTik network | `192.168.88.2` |
| `ROOM_N_PORT` | Switch port for room N | `ROOM_1_PORT=ether2` |

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

After starting the server, go to the admin dashboard → MikroTik section and run:

1. **Setup Firewall** — creates `allowed_guests` firewall rules
2. **Setup Captive Portal** — creates NAT redirect rules (port 80 → 8080, port 443 → 8443)

This only needs to be done once. The SSL certificate for HTTPS captive portal is auto-generated on first start.

### 5. Open the dashboard

Navigate to `http://YOUR_SERVER_IP:3001` in your browser.

## How It Works

### Ports

| Port | Purpose |
|---|---|
| `3001` | Admin dashboard + API |
| `8080` | HTTP captive portal (MikroTik redirects port 80 here) |
| `8443` | HTTPS captive portal (MikroTik redirects port 443 here) |

### Network Flow

```
Guest device connects to WiFi
    → MikroTik checks if IP is in allowed_guests
    → If not: NAT redirects HTTP (80→8080) and HTTPS (443→8443) to this server
    → Guest sees captive portal, enters voucher code
    → Server adds IP to MikroTik allowed_guests with timeout
    → Guest has internet access
    → Bandwidth job monitors usage every 15s
    → If usage exceeds threshold: MikroTik simple queue throttles speed
    → On session expiry: IP removed from allowed_guests, connections flushed
```

### VLAN / Room Isolation

Each room maps to a VLAN (Room 1 = VLAN 1). When a guest connects, the switch port (`ROOM_N_PORT`) is assigned to that room's VLAN via MikroTik bridge VLAN filtering. Guests on different rooms cannot communicate with each other.

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
| POST | `/api/vouchers/:code/activate` | — | Activate voucher (guest) |
| DELETE | `/api/vouchers/:id` | ✓ | Deactivate voucher |

### Sessions
| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/api/sessions` | ✓ | Active sessions |
| GET | `/api/sessions/history` | ✓ | Session history |
| DELETE | `/api/sessions/:id` | ✓ | Disconnect session |
| POST | `/api/sessions/:id/throttle` | ✓ | Manually throttle/unthrottle |

### MikroTik
| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/api/mikrotik/test` | — | Connection + port status |
| POST | `/api/mikrotik/setup-firewall` | — | Create firewall rules |
| POST | `/api/mikrotik/setup-captive-portal` | — | Create NAT redirect rules |
| POST | `/api/mikrotik/bypass-device` | ✓ | Grant device access (Smart TVs) |
| POST | `/api/mikrotik/add-bridge-port` | — | Add interface to bridge |
| GET | `/api/mikrotik/queues` | — | List active throttle queues |

### Other
| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/api/analytics` | ✓ | Usage stats |
| GET | `/api/audit` | ✓ | Admin audit log |
| GET | `/api/logs` | — | Recent server logs |
| GET | `/health` | — | Server health check |
