// What happens to personal data when an account goes, and the daily cleanup that stops old data piling up.
// Each function returns D1 statements so the caller can run them in one batch (all or nothing).

import { LIMITS, STATUS } from '../public/limits.js';

export const HISTORY_DAYS = 30; // closed sessions older than this are deleted even if fewer than LIMITS.historySize remain
export const STALE_OPEN_HOURS = 24; // an open session nobody touched for this long is closed
export const DELETED_NAME = 'Deleted user';

const DAY = 24 * 60 * 60 * 1000;

// Keeps only the newest LIMITS.historySize closed sessions. Their orders go with them (ON DELETE CASCADE).
export const pruneHistory = (db) =>
  db
    .prepare(
      `DELETE FROM order_sessions
        WHERE status = ?1
          AND id NOT IN (SELECT id FROM order_sessions WHERE status = ?1 ORDER BY closed_at DESC, id DESC LIMIT ?2)`
    )
    .bind(STATUS.closed, LIMITS.historySize);

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
      `UPDATE order_sessions SET status = ?, closed_at = ?
        WHERE status = ?
          AND MAX(created_at, COALESCE((SELECT MAX(updated_at) FROM orders WHERE session_id = order_sessions.id), 0)) <= ?`
    )
    .bind(STATUS.closed, now, STATUS.open, now - STALE_OPEN_HOURS * 60 * 60 * 1000),
  db.prepare('DELETE FROM order_sessions WHERE status = ? AND closed_at <= ?').bind(STATUS.closed, now - HISTORY_DAYS * DAY),
  pruneHistory(db),
];
