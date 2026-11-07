-- Existing bearer grants remain valid and are never silently promoted or revoked.
ALTER TABLE shares ADD COLUMN permanent INTEGER NOT NULL DEFAULT 0 CHECK(permanent IN (0,1));
ALTER TABLE shares ADD COLUMN version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0);
ALTER TABLE shares ADD COLUMN token_ciphertext BLOB;
ALTER TABLE shares ADD COLUMN token_nonce BLOB;
CREATE UNIQUE INDEX shares_permanent_list ON shares(owner_id) WHERE permanent=1 AND kind='list';
CREATE UNIQUE INDEX shares_permanent_song ON shares(song_id) WHERE permanent=1 AND kind='song';
