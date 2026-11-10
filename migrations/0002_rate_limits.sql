-- Counts recent login and sign-up attempts, so guessing passwords or the verification code is slow.
-- `key` is e.g. "login-ip:1.2.3.4" or "login-user:ali"; the count starts again once the window has passed.
CREATE TABLE rate_limits (
  key          TEXT    PRIMARY KEY,
  count        INTEGER NOT NULL,
  window_start INTEGER NOT NULL
);
