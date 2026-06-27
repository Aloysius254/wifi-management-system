import { Router, Response } from 'express';
import pool from '../db';
import { authenticate, AuthRequest } from '../middleware/auth';
import { logAction } from '../audit';

const router = Router();

// All room routes require authentication
router.use(authenticate);

// GET /api/rooms
router.get('/', async (_req: AuthRequest, res: Response): Promise<void> => {
  try {
    const [rows] = await pool.query('SELECT * FROM rooms ORDER BY floor, CAST(room_number AS UNSIGNED), room_number');
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
    const ssid = `Hotel_Room_${room_number}`;

    const [result] = await pool.query<any>(
      'INSERT INTO rooms (room_number, floor, ssid) VALUES (?, ?, ?)',
      [room_number, floor, ssid]
    );
    const roomId = result.insertId;

    // Auto-create a VAP for this room — VLAN ID always matches room number for switch configuration
    const vlanId = parseInt(room_number);
    if (!vlanId) {
      res.status(400).json({ error: 'room_number must be a valid integer for VLAN assignment' });
      return;
    }
    await pool.query(
      'INSERT INTO vaps (room_id, vlan_id, bandwidth_limit_mbps, throttle_threshold_mbps) VALUES (?, ?, 10, 8)',
      [roomId, vlanId]
    );

    await logAction(req.admin!.username, 'CREATE_ROOM', `Room ${room_number} (Floor ${floor}) — SSID: ${ssid}`, req.ip);
    res.status(201).json({ id: roomId, room_number, floor, ssid, is_active: true });
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
  const updates: string[] = [];
  const values: any[] = [];

  if (room_number !== undefined) { updates.push('room_number = ?'); values.push(room_number); }
  if (floor !== undefined)       { updates.push('floor = ?');       values.push(floor); }
  if (is_active !== undefined)   { updates.push('is_active = ?');   values.push(is_active); }

  if (updates.length === 0) { res.status(400).json({ error: 'No fields to update' }); return; }
  values.push(req.params.id);

  try {
    await pool.query(`UPDATE rooms SET ${updates.join(', ')} WHERE id = ?`, values);
    res.json({ message: 'Room updated' });
  } catch {
    res.status(500).json({ error: 'Failed to update room' });
  }
});

// DELETE /api/rooms/:id
router.delete('/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const [rows] = await pool.query<any[]>('SELECT room_number FROM rooms WHERE id = ?', [req.params.id]);
    await pool.query('DELETE FROM rooms WHERE id = ?', [req.params.id]);
    const name = rows[0]?.room_number ?? req.params.id;
    await logAction(req.admin!.username, 'DELETE_ROOM', `Room ${name} deleted`, req.ip);
    res.json({ message: 'Room deleted' });
  } catch {
    res.status(500).json({ error: 'Failed to delete room' });
  }
});

export default router;
