-- Auth-owned migration; songs continues to own its existing tables.
CREATE TABLE login_attempts (
 scope BLOB PRIMARY KEY, failures INTEGER NOT NULL, window_start INTEGER NOT NULL,
 locked_until INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX sessions_user ON sessions(user_id);
