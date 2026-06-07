-- PASS Buddy Check — Migration 0003
-- Extend member_roster: names, work phone, uncertain-device flag

-- Rename member_id → chapter_ref
-- Populated as "{chapter}-{seq#}" e.g. "NE3-10"; human-readable, admin-facing only.
-- Velarium does not expose a global member ID in standard exports.
ALTER TABLE member_roster RENAME COLUMN member_id TO chapter_ref;

-- Member name from Velarium import.
-- Admin-facing only — never surfaced to the member themselves.
-- members.name (entered at registration) is always the authoritative display name.
ALTER TABLE member_roster ADD COLUMN name TEXT;

-- Work/desk phone (organizing report col 11).
-- Reference only — never used for OTP delivery. Stored so admin can
-- identify members who may only have a government device on file.
ALTER TABLE member_roster ADD COLUMN phone_work TEXT;

-- 1 = cell and work phone are identical, OR no distinct cell was on file.
-- When set, registration flow shows enhanced government-device disclosure:
-- "We only have one number on file for you — if it's a government device, here's what that means."
ALTER TABLE member_roster ADD COLUMN phone_uncertain INTEGER NOT NULL DEFAULT 0;
