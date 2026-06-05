-- Hotel WiFi Manager Database Schema
CREATE DATABASE IF NOT EXISTS hotel_wifi;
USE hotel_wifi;

-- Admin users
CREATE TABLE IF NOT EXISTS admins (
  id INT AUTO_INCREMENT PRIMARY KEY,
  username VARCHAR(50) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  role ENUM('manager', 'staff') NOT NULL DEFAULT 'staff',
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Rooms
CREATE TABLE IF NOT EXISTS rooms (
  id INT AUTO_INCREMENT PRIMARY KEY,
  room_number VARCHAR(10) NOT NULL UNIQUE,
  floor INT NOT NULL,
  ssid VARCHAR(50),
  wifi_password VARCHAR(20),
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Virtual Access Points (one per room)
CREATE TABLE IF NOT EXISTS vaps (
  id INT AUTO_INCREMENT PRIMARY KEY,
  room_id INT NOT NULL UNIQUE,
  vlan_id INT NOT NULL UNIQUE,
  bandwidth_limit_mbps INT NOT NULL DEFAULT 10,
  throttle_threshold_mbps INT NOT NULL DEFAULT 8,
  is_isolated BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE
);

-- WiFi vouchers
CREATE TABLE IF NOT EXISTS vouchers (
  id INT AUTO_INCREMENT PRIMARY KEY,
  code VARCHAR(20) NOT NULL UNIQUE,
  room_id INT,
  duration_hours INT NOT NULL DEFAULT 24,
  max_devices INT NOT NULL DEFAULT 2,
  is_used BOOLEAN DEFAULT FALSE,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  activated_at TIMESTAMP NULL,
  expires_at TIMESTAMP NULL,
  FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE SET NULL
);

-- Active sessions
CREATE TABLE IF NOT EXISTS sessions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  voucher_id INT NOT NULL,
  device_mac VARCHAR(17),
  device_name VARCHAR(100),
  ip_address VARCHAR(45),
  user_agent TEXT,
  vap_id INT,
  is_throttled BOOLEAN DEFAULT FALSE,
  is_active BOOLEAN DEFAULT TRUE,
  connected_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  disconnected_at TIMESTAMP NULL,
  FOREIGN KEY (voucher_id) REFERENCES vouchers(id) ON DELETE CASCADE,
  FOREIGN KEY (vap_id) REFERENCES vaps(id) ON DELETE SET NULL
);

-- Bandwidth usage logs (simulated usage tracking)
CREATE TABLE IF NOT EXISTS bandwidth_logs (
  id INT AUTO_INCREMENT PRIMARY KEY,
  session_id INT NOT NULL,
  usage_mbps DECIMAL(6,2) NOT NULL DEFAULT 0,
  logged_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

-- Isolation events log
CREATE TABLE IF NOT EXISTS isolation_events (
  id INT AUTO_INCREMENT PRIMARY KEY,
  source_session_id INT NOT NULL,
  target_session_id INT NOT NULL,
  action VARCHAR(50) DEFAULT 'BLOCKED',
  reason VARCHAR(255),
  occurred_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Admin audit log
CREATE TABLE IF NOT EXISTS audit_logs (
  id INT AUTO_INCREMENT PRIMARY KEY,
  admin_username VARCHAR(50) NOT NULL,
  action VARCHAR(100) NOT NULL,
  details VARCHAR(255),
  ip_address VARCHAR(45),
  occurred_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Indexes
CREATE INDEX idx_vouchers_code ON vouchers(code);
CREATE INDEX idx_sessions_active ON sessions(is_active);
CREATE INDEX idx_sessions_vap ON sessions(vap_id);
CREATE INDEX idx_bandwidth_session ON bandwidth_logs(session_id);
