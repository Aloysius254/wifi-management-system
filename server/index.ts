import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import { createServer } from 'http';
import { Server as SocketServer } from 'socket.io';

import { startExpiryJob } from './expiry';
import { startBandwidthSimulator } from './bandwidth';
import authRoutes from './routes/auth';
import roomRoutes from './routes/rooms';
import voucherRoutes from './routes/vouchers';
import sessionRoutes from './routes/sessions';
import vapRoutes from './routes/vaps';
import analyticsRoutes from './routes/analytics';
import auditRoutes from './routes/audit';
import { errorHandler } from './middleware/errorHandler';

dotenv.config();

const app = express();
const httpServer = createServer(app);

const io = new SocketServer(httpServer, {
  cors: { origin: '*', methods: ['GET', 'POST', 'DELETE', 'PATCH'] },
});

// Middleware
app.use(cors());
app.use(express.json());

// Serve client files statically so phones can access them
app.use(express.static(path.join(process.cwd(), 'client'), {
  etag: false,
  lastModified: false,
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
  }
}));

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/rooms', roomRoutes);
app.use('/api/vouchers', voucherRoutes);
app.use('/api/sessions', sessionRoutes);
app.use('/api/vaps', vapRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/audit', auditRoutes);

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Returns the caller's IP — used by guest portal
app.get('/api/myip', (req, res) => {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '—';
  res.json({ ip });
});

// Guest portal — serve guest.html for any non-API route on mobile
app.get('/guest', (_req, res) => {
  res.sendFile(path.join(process.cwd(), 'client', 'guest.html'));
});

// Error handler
app.use(errorHandler);

// Socket.IO
io.on('connection', (socket) => {
  console.log(`[Socket] Client connected: ${socket.id}`);
  socket.on('disconnect', () => {
    console.log(`[Socket] Client disconnected: ${socket.id}`);
  });
});

export { io };

const PORT = Number(process.env.PORT) || 3000;
httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🏨  Hotel WiFi Manager running`);
  console.log(`   Local:   http://localhost:${PORT}`);
  console.log(`   Network: http://192.168.1.149:${PORT}`);
  console.log(`   Guest portal: http://192.168.1.149:${PORT}/guest\n`);
  startExpiryJob();
  startBandwidthSimulator();
});
