ALTER TABLE assets ADD COLUMN source_codec TEXT;
ALTER TABLE assets ADD COLUMN source_container TEXT;
CREATE UNIQUE INDEX jobs_one_asset ON jobs(asset_id);
