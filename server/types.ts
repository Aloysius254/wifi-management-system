export interface Admin {
  id: number;
  username: string;
  password_hash: string;
  created_at: Date;
}

export interface Room {
  id: number;
  room_number: string;
  floor: number;
  is_active: boolean;
  created_at: Date;
}

export interface VAP {
  id: number;
  room_id: number;
  vlan_id: number;
  bandwidth_limit_mbps: number;
  throttle_threshold_mbps: number;
  is_isolated: boolean;
  created_at: Date;
}

export interface Voucher {
  id: number;
  code: string;
  room_id: number | null;
  duration_hours: number;
  max_devices: number;
  is_used: boolean;
  is_active: boolean;
  created_at: Date;
  activated_at: Date | null;
  expires_at: Date | null;
}

export interface Session {
  id: number;
  voucher_id: number;
  device_mac: string | null;
  device_name: string | null;
  ip_address: string | null;
  user_agent: string | null;
  vap_id: number | null;
  is_throttled: boolean;
  is_active: boolean;
  connected_at: Date;
  disconnected_at: Date | null;
}

export interface BandwidthLog {
  id: number;
  session_id: number;
  usage_mbps: number;
  logged_at: Date;
}

export interface JwtPayload {
  adminId: number;
  username: string;
}
