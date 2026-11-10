// What happens to personal data when an account goes, and the daily cleanup that stops old data piling up.
// Each function returns D1 statements so the caller can run them in one batch (all or nothing).

export const HISTORY_SIZE = 5; // closed sessions kept; older ones are deleted
export const HISTORY_DAYS = 30; // closed sessions older than this are deleted even if fewer than HISTORY_SIZE remain
export const STALE_OPEN_HOURS = 24; // an open session nobody touched for this long is closed
export const DELETED_NAME = 'Deleted user';

const DAY = 24 * 60 * 60 * 1000;

// Keeps only the newest HISTORY_SIZE closed sessions. Their orders go with them (ON DELETE CASCADE).
export const pruneHistory = (db) =>
  db
    .prepare(
      `DELETE FROM order_sessions
        WHERE status = 'closed'
          AND id NOT IN (SELECT id FROM order_sessions WHERE status = 'closed' ORDER BY closed_at DESC, id DESC LIMIT ?)`
    )
    .bind(HISTORY_SIZE);

// Removes every trace of a person: their drinks in every session, their name on sessions they bought for,
// their logins and the account itself (which holds their saved drink).
export const deleteAccount = (db, userId) => [
  db.prepare('DELETE FROM orders WHERE user_id = ?').bind(userId),
  db.prepare('UPDATE order_sessions SET purchaser_name = ? WHERE purchaser_id = ?').bind(DELETED_NAME, userId),
  db.prepare('DELETE FROM auth_tokens WHERE user_id = ?').bind(userId),
  db.prepare('DELETE FROM users WHERE id = ?').bind(userId),
];

// Run by the daily Cron Trigger: expired logins, abandoned open sessions and old history.
export const purge = (db, now = Date.now()) => [
  db.prepare('DELETE FROM auth_tokens WHERE expires_at <= ?').bind(now),
  db
    .prepare(
      `UPDATE order_sessions SET status = 'closed', closed_at = ?
        WHERE status = 'open'
          AND MAX(created_at, COALESCE((SELECT MAX(updated_at) FROM orders WHERE session_id = order_sessions.id), 0)) <= ?`
    )
    .bind(now, now - STALE_OPEN_HOURS * 60 * 60 * 1000),
  db.prepare("DELETE FROM order_sessions WHERE status = 'closed' AND closed_at <= ?").bind(now - HISTORY_DAYS * DAY),
  pruneHistory(db),
];
