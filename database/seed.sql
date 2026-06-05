USE hotel_wifi;

-- Default admin (password: admin123) — manager role
INSERT IGNORE INTO admins (username, password_hash, role) VALUES
('admin', '$2b$10$xV6GQ/38NqNK8XcsymfyguOGNTDWsk0IGch.7nX/DkZAaPJCbCQ3O', 'manager');

-- Sample rooms
INSERT IGNORE INTO rooms (room_number, floor) VALUES
('101', 1), ('102', 1), ('103', 1),
('201', 2), ('202', 2), ('203', 2),
('301', 3), ('302', 3), ('303', 3);

-- VAPs for each room (auto-created by trigger, but seed manually)
INSERT IGNORE INTO vaps (room_id, vlan_id, bandwidth_limit_mbps, throttle_threshold_mbps)
SELECT id, (100 + id) AS vlan_id, 10, 8 FROM rooms;
