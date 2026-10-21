-- Rebuild the tracks/assets cycle without disabling FK checks. Renaming first
-- keeps the old graph valid until the replacement graph is fully populated.
ALTER TABLE tracks RENAME TO tracks_old;
ALTER TABLE assets RENAME TO assets_old;
CREATE TABLE tracks (
 id TEXT PRIMARY KEY, song_id TEXT NOT NULL REFERENCES songs(id), position INTEGER NOT NULL CHECK(position BETWEEN 0 AND 31),
 name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 80), gain REAL NOT NULL DEFAULT 1 CHECK(gain BETWEEN 0 AND 1),
 active_asset_id TEXT REFERENCES assets(id) DEFERRABLE INITIALLY DEFERRED,
 pending_asset_id TEXT REFERENCES assets(id) DEFERRABLE INITIALLY DEFERRED,
 deleted_at TEXT
);
CREATE TABLE assets (
 id TEXT PRIMARY KEY, track_id TEXT NOT NULL REFERENCES tracks(id), source_path TEXT NOT NULL,
 playback_path TEXT, peaks_path TEXT, source_bytes INTEGER NOT NULL CHECK(source_bytes>0), source_sha256 BLOB NOT NULL,
 duration_ms INTEGER, mime TEXT, sample_rate INTEGER, channels INTEGER,
 state TEXT NOT NULL CHECK(state IN ('pending','processing','ready','failed','retired')),
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 CHECK(state!='ready' OR (playback_path IS NOT NULL AND peaks_path IS NOT NULL AND duration_ms IS NOT NULL AND duration_ms>0 AND mime IS NOT NULL AND mime='audio/mp4' AND sample_rate IS NOT NULL AND sample_rate=48000 AND channels IS NOT NULL AND channels=1))
);

INSERT INTO tracks(id,song_id,position,name,gain)
 SELECT id,song_id,position,name,gain FROM tracks_old;
INSERT INTO assets SELECT * FROM assets_old;
UPDATE tracks SET
 active_asset_id=(SELECT active_asset_id FROM tracks_old WHERE tracks_old.id=tracks.id),
 pending_asset_id=(SELECT pending_asset_id FROM tracks_old WHERE tracks_old.id=tracks.id);
CREATE TABLE jobs_new (
 id TEXT PRIMARY KEY, asset_id TEXT NOT NULL REFERENCES assets(id), state TEXT NOT NULL CHECK(state IN ('queued','processing','succeeded','failed','canceled')),
 attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts>=0), error_code TEXT, lease_until TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);


INSERT INTO jobs_new SELECT * FROM jobs;
DROP TABLE jobs;
ALTER TABLE jobs_new RENAME TO jobs;
CREATE INDEX jobs_poll ON jobs(state,lease_until);
-- Break old cyclic references before dropping their targets.
UPDATE tracks_old SET active_asset_id=NULL,pending_asset_id=NULL;
DROP TABLE assets_old;
DROP TABLE tracks_old;
CREATE UNIQUE INDEX tracks_live_position ON tracks(song_id,position) WHERE deleted_at IS NULL;
