CREATE TABLE users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT    NOT NULL,
  username_key  TEXT    NOT NULL UNIQUE, -- lowercased, so "Ali" and "ali" are the same account
  password_hash TEXT    NOT NULL,
  is_admin      INTEGER NOT NULL DEFAULT 0,
  last_drink    TEXT,                    -- JSON of their most recent order, used to pre-fill the form
  created_at    INTEGER NOT NULL
);

CREATE TABLE auth_tokens (
  token_hash TEXT    PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);

CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Bumped on every change to sessions or orders, so polling clients can ask "anything new?" cheaply.
INSERT INTO settings (key, value) VALUES ('version', '1');

CREATE TABLE order_sessions (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  title          TEXT    NOT NULL DEFAULT '',
  purchaser_id   INTEGER REFERENCES users (id) ON DELETE SET NULL,
  purchaser_name TEXT    NOT NULL,
  status         TEXT    NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  created_at     INTEGER NOT NULL,
  closed_at      INTEGER
);

-- Only one session can be open at a time.
CREATE UNIQUE INDEX one_open_session ON order_sessions (status) WHERE status = 'open';

CREATE TABLE orders (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES order_sessions (id) ON DELETE CASCADE,
  user_id    INTEGER REFERENCES users (id) ON DELETE SET NULL,
  user_name  TEXT    NOT NULL,           -- kept so history still reads right after an account is deleted
  drink      TEXT    NOT NULL,           -- JSON of the chosen options
  drink_name TEXT    NOT NULL,           -- e.g. "Kopi O Kosong Peng"
  note       TEXT    NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL,
  UNIQUE (session_id, user_id)           -- one drink per person per session
);
