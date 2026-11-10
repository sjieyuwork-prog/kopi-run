// Fixed-window attempt counters stored in D1, used to slow down password and code guessing.

export const WINDOW_MS = 15 * 60 * 1000;

// Per window. A shared office Wi-Fi is one IP, so the IP limits are looser than the per-account one.
export const LIMITS = {
  'login-ip': 20, // failed logins from one IP
  'login-user': 10, // failed logins for one username, from anywhere
  'signup-ip': 10, // sign-up attempts from one IP, successful or not
};

// True when `key` has used up its attempts in the current window.
export async function isLimited(db, kind, id, now = Date.now()) {
  const count = await db
    .prepare('SELECT count FROM rate_limits WHERE key = ? AND window_start > ?')
    .bind(`${kind}:${id}`, now - WINDOW_MS)
    .first('count');
  return (count ?? 0) >= LIMITS[kind];
}

// The statements below are returned unrun, so callers can batch them.

// Counts one attempt, starting a new window if the old one has passed.
export function recordAttempt(db, kind, id, now = Date.now()) {
  return db
    .prepare(
      `INSERT INTO rate_limits (key, count, window_start) VALUES (?1, 1, ?2)
       ON CONFLICT (key) DO UPDATE SET
         count        = CASE WHEN window_start <= ?3 THEN 1  ELSE count + 1  END,
         window_start = CASE WHEN window_start <= ?3 THEN ?2 ELSE window_start END`
    )
    .bind(`${kind}:${id}`, now, now - WINDOW_MS);
}

export function clearAttempts(db, kind, id) {
  return db.prepare('DELETE FROM rate_limits WHERE key = ?').bind(`${kind}:${id}`);
}

// Old rows are harmless but would pile up; drop them now and then.
export function pruneAttempts(db, now = Date.now()) {
  return db.prepare('DELETE FROM rate_limits WHERE window_start <= ?').bind(now - WINDOW_MS);
}

// Cloudflare sets this header; local `wrangler dev` does too. Fall back to one shared bucket.
export const clientIp = (c) => c.req.header('CF-Connecting-IP') || 'unknown';
