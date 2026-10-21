CREATE TABLE users (
 id TEXT PRIMARY KEY, email_normalized TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
 role TEXT NOT NULL CHECK(role IN ('teacher','admin')), blocked_at TEXT,
 must_change_password INTEGER NOT NULL DEFAULT 1 CHECK(must_change_password IN (0,1)),
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE sessions (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), token_hash BLOB NOT NULL UNIQUE,
 csrf_hash BLOB NOT NULL, expires_at TEXT NOT NULL, revoked_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE songs (
 id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id), title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 160),
 bpm INTEGER NOT NULL CHECK(bpm BETWEEN 20 AND 300), beats_per_bar INTEGER NOT NULL CHECK(beats_per_bar BETWEEN 1 AND 32),
 beat_unit INTEGER NOT NULL CHECK(beat_unit IN (1,2,4,8,16,32)), notes TEXT NOT NULL DEFAULT '' CHECK(length(notes)<=1000),
 publication TEXT NOT NULL DEFAULT 'draft' CHECK(publication IN ('draft','published')), version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT
);
CREATE TABLE tracks (
 id TEXT PRIMARY KEY, song_id TEXT NOT NULL REFERENCES songs(id), position INTEGER NOT NULL CHECK(position BETWEEN 0 AND 31),
 name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 80), gain REAL NOT NULL DEFAULT 1 CHECK(gain>=0),
 active_asset_id TEXT REFERENCES assets(id) DEFERRABLE INITIALLY DEFERRED,
 pending_asset_id TEXT REFERENCES assets(id) DEFERRABLE INITIALLY DEFERRED, UNIQUE(song_id,position)
);
CREATE TABLE assets (
 id TEXT PRIMARY KEY, track_id TEXT NOT NULL REFERENCES tracks(id), source_path TEXT NOT NULL,
 playback_path TEXT, peaks_path TEXT, source_bytes INTEGER NOT NULL CHECK(source_bytes>0), source_sha256 BLOB NOT NULL,
 duration_ms INTEGER, mime TEXT, sample_rate INTEGER, channels INTEGER,
 state TEXT NOT NULL CHECK(state IN ('pending','processing','ready','failed','retired')),
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 CHECK(state!='ready' OR (playback_path IS NOT NULL AND peaks_path IS NOT NULL AND duration_ms>0 AND mime='audio/mp4' AND sample_rate=48000 AND channels=1))
);
CREATE TABLE jobs (
 id TEXT PRIMARY KEY, asset_id TEXT NOT NULL REFERENCES assets(id), state TEXT NOT NULL CHECK(state IN ('queued','processing','succeeded','failed','canceled')),
 attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts>=0), error_code TEXT, lease_until TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX jobs_poll ON jobs(state,lease_until);
CREATE TABLE shares (
 id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('song','list')), owner_id TEXT NOT NULL REFERENCES users(id),
 song_id TEXT REFERENCES songs(id), token_hash BLOB NOT NULL UNIQUE, disabled_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 CHECK((kind='song' AND song_id IS NOT NULL) OR (kind='list' AND song_id IS NULL))
);
CREATE TABLE idempotency_records (
 method TEXT NOT NULL, url TEXT NOT NULL, actor TEXT NOT NULL, key TEXT NOT NULL, request_digest BLOB NOT NULL,
 status INTEGER NOT NULL, headers TEXT NOT NULL, response_ciphertext BLOB NOT NULL, nonce BLOB NOT NULL, key_id TEXT NOT NULL,
 expires_at TEXT NOT NULL, PRIMARY KEY(method,url,actor,key), UNIQUE(key_id,nonce)
);
CREATE TABLE page_snapshots (
 id TEXT PRIMARY KEY, scope_hash BLOB NOT NULL, resource_ids TEXT NOT NULL, expires_at TEXT NOT NULL
);
CREATE TRIGGER shares_owner_insert BEFORE INSERT ON shares
WHEN NEW.kind='song' AND NOT EXISTS(SELECT 1 FROM songs WHERE id=NEW.song_id AND owner_id=NEW.owner_id)
BEGIN SELECT RAISE(ABORT,'share owner mismatch'); END;
CREATE TRIGGER shares_owner_update BEFORE UPDATE OF kind,song_id,owner_id ON shares
WHEN NEW.kind='song' AND NOT EXISTS(SELECT 1 FROM songs WHERE id=NEW.song_id AND owner_id=NEW.owner_id)
BEGIN SELECT RAISE(ABORT,'share owner mismatch'); END;
