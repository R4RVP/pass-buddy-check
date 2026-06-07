-- ─────────────────────────────────────────────────────────────────────────────
-- PASS Buddy Check — Initial Schema
-- Migration: 0001_initial
-- ─────────────────────────────────────────────────────────────────────────────

-- member_roster: Velarium CSV import — phone number allowlist
-- Self-registration auto-approves if phone is found here.
CREATE TABLE IF NOT EXISTS member_roster (
  id          TEXT    NOT NULL PRIMARY KEY,
  phone       TEXT    NOT NULL UNIQUE,   -- E.164 (+1XXXXXXXXXX)
  member_id   TEXT,                      -- Velarium member ID
  local_num   TEXT,                      -- PASS local/chapter number
  imported_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- users: admin, FR, safety contacts — authenticated via Cloudflare Access
CREATE TABLE IF NOT EXISTS users (
  id         TEXT NOT NULL PRIMARY KEY,
  email      TEXT NOT NULL UNIQUE,       -- must match Cloudflare Access identity
  name       TEXT NOT NULL,
  role       TEXT NOT NULL CHECK (role IN ('fr', 'rvp', 'admin', 'safety_contact')),
  unit_code  TEXT,                       -- FRs scoped to their unit; NULL = all units
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- members: registered PASS members who can use Buddy Check
CREATE TABLE IF NOT EXISTS members (
  id                   TEXT    NOT NULL PRIMARY KEY,
  phone                TEXT    NOT NULL UNIQUE,   -- E.164
  email                TEXT,
  name                 TEXT    NOT NULL,
  org_level            TEXT    CHECK (org_level IN ('flight_standards', 'aircraft_cert', 'other')),
  unit_code            TEXT,
  fr_id                TEXT    REFERENCES users(id),
  status               TEXT    NOT NULL DEFAULT 'pending'
                               CHECK (status IN ('pending', 'active', 'suspended')),
  push_sub             TEXT,                      -- JSON: Web Push subscription object
  gov_device_disclosed INTEGER NOT NULL DEFAULT 0,  -- 1 = disclosed and acknowledged
  roster_matched       INTEGER NOT NULL DEFAULT 0,  -- 1 = matched Velarium on registration
  created_at           TEXT    NOT NULL DEFAULT (datetime('now')),
  activated_at         TEXT
);

-- pending_requests: self-registrations that didn't match the roster
-- Requires manual FR/admin review.
CREATE TABLE IF NOT EXISTS pending_requests (
  id           TEXT NOT NULL PRIMARY KEY,
  phone        TEXT NOT NULL,
  name         TEXT NOT NULL,
  org_level    TEXT,
  unit_code    TEXT,
  email        TEXT,
  note         TEXT,
  submitted_at TEXT NOT NULL DEFAULT (datetime('now')),
  reviewed_by  TEXT REFERENCES users(id),
  reviewed_at  TEXT,
  decision     TEXT CHECK (decision IN ('approved', 'denied'))
);

-- checkins: active and recent check-in records
-- Purged 7 days after close; analytics event written before purge.
CREATE TABLE IF NOT EXISTS checkins (
  id                    TEXT    NOT NULL PRIMARY KEY,
  member_id             TEXT    NOT NULL REFERENCES members(id),
  buddy_name            TEXT    NOT NULL,
  buddy_phone           TEXT    NOT NULL,           -- E.164
  buddy_email           TEXT,
  location_id           TEXT,                       -- FK to location library (optional)
  location_label        TEXT    NOT NULL,            -- display name; always populated
  w3w_address           TEXT,                       -- ///word.word.word; primary location ref
  facility_code         TEXT,
  location_type         TEXT    CHECK (location_type IN
                                  ('fire', 'bomb_threat', 'tornado', 'field', 'other')),
  activity              TEXT,
  expected_out_at       TEXT    NOT NULL,            -- ISO 8601; updated on ETA changes
  original_expected_out TEXT    NOT NULL,            -- locked at check-in; used for analytics
  grace_minutes         INTEGER NOT NULL DEFAULT 30,
  status                TEXT    NOT NULL DEFAULT 'active'
                                CHECK (status IN ('active', 'checked_out', 'overdue', 'cancelled')),
  checkin_at            TEXT    NOT NULL DEFAULT (datetime('now')),
  checkout_at           TEXT,
  overdue_alerted_at    TEXT,
  reminder_sent_at      TEXT,
  eta_updated_count     INTEGER NOT NULL DEFAULT 0,
  -- Internal only: used for w3w grid-square proximity calculation; never displayed to users
  checkin_lat           REAL,
  checkin_lon           REAL
);

-- analytics_events: anonymized usage log — permanent, no PII
-- One row per closed check-in. Written before the checkins row is purged.
CREATE TABLE IF NOT EXISTS analytics_events (
  id              TEXT NOT NULL PRIMARY KEY,
  event_date      TEXT NOT NULL,             -- YYYY-MM-DD only (no time, no member ID)
  facility_code   TEXT NOT NULL,
  location_type   TEXT,
  duration_bucket TEXT CHECK (duration_bucket IN ('<1h', '1-4h', '4-8h', '8h+', 'incomplete')),
  eta_extended    INTEGER NOT NULL DEFAULT 0, -- 1 if member updated ETA at least once
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- notification_log: debugging only — purged with parent check-in (CASCADE)
CREATE TABLE IF NOT EXISTS notification_log (
  id              TEXT NOT NULL PRIMARY KEY,
  checkin_id      TEXT NOT NULL REFERENCES checkins(id) ON DELETE CASCADE,
  recipient_type  TEXT CHECK (recipient_type IN ('member', 'buddy', 'safety_contact')),
  channel         TEXT CHECK (channel IN ('sms', 'push', 'email')),
  event           TEXT CHECK (event IN
                    ('checkin_confirm', 'reminder', 'overdue', 'checkout', 'eta_update')),
  status          TEXT CHECK (status IN ('sent', 'failed', 'stubbed')),
  payload         TEXT,  -- JSON of message content; populated when SMS_ENABLED=false
  sent_at         TEXT
);

-- ─────────────────────────────────────────────────────────────────────────────
-- Indexes
-- ─────────────────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_members_phone
  ON members(phone);

CREATE INDEX IF NOT EXISTS idx_members_status
  ON members(status);

CREATE INDEX IF NOT EXISTS idx_roster_phone
  ON member_roster(phone);

CREATE INDEX IF NOT EXISTS idx_checkins_member
  ON checkins(member_id);

CREATE INDEX IF NOT EXISTS idx_checkins_status
  ON checkins(status);

CREATE INDEX IF NOT EXISTS idx_checkins_expected_out
  ON checkins(expected_out_at);

CREATE INDEX IF NOT EXISTS idx_analytics_facility_date
  ON analytics_events(facility_code, event_date);

CREATE INDEX IF NOT EXISTS idx_notification_checkin
  ON notification_log(checkin_id);
