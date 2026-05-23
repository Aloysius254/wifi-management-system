// In-memory rate limiter for voucher activation (prevents brute-force code guessing)
const map = new Map<string, { count: number; since: number }>();
const WINDOW_MS  = 15 * 60 * 1000; // 15 minutes
const MAX_TRIES  = 5;

export function checkRate(ip: string): true | number {
  const now  = Date.now();
  const prev = map.get(ip);
  if (!prev || now - prev.since > WINDOW_MS) {
    map.set(ip, { count: 1, since: now });
    return true;
  }
  if (prev.count >= MAX_TRIES) {
    return Math.ceil((prev.since + WINDOW_MS - now) / 60_000); // minutes remaining
  }
  prev.count++;
  return true;
}

export function clearRate(ip: string) {
  map.delete(ip);
}
