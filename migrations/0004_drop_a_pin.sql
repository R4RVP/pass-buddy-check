-- M13: Drop a Pin — live location update columns
-- Adds current location fields to checkins.
-- checkin_lat/checkin_lon are the ORIGINAL coords (locked at check-in).
-- current_lat/current_lon/current_w3w are updated by Drop a Pin.

ALTER TABLE checkins ADD COLUMN current_lat          REAL;
ALTER TABLE checkins ADD COLUMN current_lon          REAL;
ALTER TABLE checkins ADD COLUMN current_w3w          TEXT;  -- word.word.word (no /// in storage)
ALTER TABLE checkins ADD COLUMN location_updated_at  TEXT;  -- ISO 8601; NULL = never updated
ALTER TABLE checkins ADD COLUMN location_update_count INTEGER NOT NULL DEFAULT 0;
