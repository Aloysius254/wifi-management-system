import { Router, Response } from 'express';
import pool from '../db';
import { authenticate, AuthRequest } from '../middleware/auth';

const router = Router();

// All room routes require authentication
router.use(authenticate);

// GET /api/rooms
router.get('/', async (_req: AuthRequest, res: Response): Promise<void> => {
  try {
    const [rows] = await pool.query('SELECT * FROM rooms ORDER BY floor, room_number');
    res.json(rows);
  } catch {
    res.status(500).json({ error: 'Failed to fetch rooms' });
  }
});

// GET /api/rooms/:id
router.get('/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const [rows] = await pool.query<any[]>('SELECT * FROM rooms WHERE id = ?', [req.params.id]);
    if (!rows[0]) {
      res.status(404).json({ error: 'Room not found' });
      return;
    }
    res.json(rows[0]);
  } catch {
    res.status(500).json({ error: 'Failed to fetch room' });
  }
});

// POST /api/rooms
router.post('/', async (req: AuthRequest, res: Response): Promise<void> => {
  const { room_number, floor } = req.body;

  if (!room_number || floor === undefined) {
    res.status(400).json({ error: 'room_number and floor are required' });
    return;
  }

  try {
    const [result] = await pool.query<any>(
      'INSERT INTO rooms (room_number, floor) VALUES (?, ?)',
      [room_number, floor]
    );
    const roomId = result.insertId;

    // Auto-create a VAP for this room
    const vlanId = 100 + roomId;
    await pool.query(
      'INSERT INTO vaps (room_id, vlan_id, bandwidth_limit_mbps, throttle_threshold_mbps) VALUES (?, ?, 10, 8)',
      [roomId, vlanId]
    );

    res.status(201).json({ id: roomId, room_number, floor, is_active: true });
  } catch (err: any) {
    if (err.code === 'ER_DUP_ENTRY') {
      res.status(409).json({ error: 'Room number already exists' });
      return;
    }
    res.status(500).json({ error: 'Failed to create room' });
  }
});

// PATCH /api/rooms/:id
router.patch('/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  const { room_number, floor, is_active } = req.body;

  try {
    await pool.query(
      'UPDATE rooms SET room_number = COALESCE(?, room_number), floor = COALESCE(?, floor), is_active = COALESCE(?, is_active) WHERE id = ?',
      [room_number ?? null, floor ?? null, is_active ?? null, req.params.id]
    );
    res.json({ message: 'Room updated' });
  } catch {
    res.status(500).json({ error: 'Failed to update room' });
  }
});

// DELETE /api/rooms/:id
router.delete('/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    await pool.query('DELETE FROM rooms WHERE id = ?', [req.params.id]);
    res.json({ message: 'Room deleted' });
  } catch {
    res.status(500).json({ error: 'Failed to delete room' });
  }
});

export default router;
