USE hotel_wifi;

-- Default admin (password: admin123) — manager role
INSERT IGNORE INTO admins (username, password_hash, role) VALUES
('admin', '$2b$10$xV6GQ/38NqNK8XcsymfyguOGNTDWsk0IGch.7nX/DkZAaPJCbCQ3O', 'manager');

-- No default rooms — add rooms via the admin dashboard
