# Hotel WiFi Manager

A full-stack hotel WiFi voucher management system built with Node.js, Express, TypeScript, MySQL, and Socket.IO.

## Features

- **Admin authentication** with JWT
- **Room management** — add/remove hotel rooms
- **Voucher generation** — create WiFi codes with configurable duration and device limits
- **Session tracking** — monitor connected devices in real time
- **Admin dashboard** — vanilla JS SPA with live stats

## Project Structure

```
hotel-wifi-manager/
├── client/           # Frontend (HTML + CSS + JS)
│   ├── index.html
│   ├── style.css
│   └── app.js
├── database/
│   ├── schema.sql    # DB schema
│   └── seed.sql      # Default admin + sample rooms
├── server/
│   ├── index.ts      # Entry point
│   ├── db.ts         # MySQL connection pool
│   ├── types.ts      # Shared TypeScript types
│   ├── middleware/
│   │   ├── auth.ts
│   │   └── errorHandler.ts
│   └── routes/
│       ├── auth.ts
│       ├── rooms.ts
│       ├── vouchers.ts
│       └── sessions.ts
├── .env
├── tsconfig.json
└── package.json
```

## Setup

### 1. Database

```bash
# Create the database and tables
npm run db:init

# Seed default admin and sample rooms
npm run db:seed
```

Default admin credentials: `admin` / `admin123` — **change this immediately**.

### 2. Environment

Copy `.env.example` to `.env` and fill in your values:

```bash
cp .env.example .env
```

### 3. Run

```bash
# Development (with hot reload)
npm run dev

# Production build
npm run build
npm start
```

### 4. Open the dashboard

Open `client/index.html` in a browser (or serve it with Live Server on port 5500).

## API Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/auth/login` | — | Admin login |
| GET | `/api/auth/me` | ✓ | Current admin |
| GET | `/api/rooms` | ✓ | List rooms |
| POST | `/api/rooms` | ✓ | Add room |
| DELETE | `/api/rooms/:id` | ✓ | Remove room |
| GET | `/api/vouchers` | ✓ | List vouchers |
| POST | `/api/vouchers` | ✓ | Create voucher(s) |
| GET | `/api/vouchers/check/:code` | ✓ | Check voucher |
| POST | `/api/vouchers/:code/activate` | ✓ | Activate voucher |
| DELETE | `/api/vouchers/:id` | ✓ | Deactivate voucher |
| GET | `/api/sessions` | ✓ | Active sessions |
| GET | `/api/sessions/history` | ✓ | Session history |
| DELETE | `/api/sessions/:id` | ✓ | Disconnect session |
