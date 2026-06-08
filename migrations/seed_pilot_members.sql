-- Seed pilot members into members table
-- Run once against remote DB: wrangler d1 execute buddy-check-db --remote --file migrations/seed_pilot_members.sql

INSERT INTO members (id, phone, name, org_level, status, roster_matched, gov_device_disclosed, activated_at)
VALUES
  ('a243b3be-88bf-46af-aa4e-54a5a084b175', '+19175939143', 'Benjamin Struck',          'flight_standards', 'active', 1, 0, datetime('now')),
  ('15be44bb-6153-4174-9958-ec446dbd55c2', '+19712262454', 'Christopher Mazurkiewicz', 'flight_standards', 'active', 1, 0, datetime('now')),
  ('55bc35b9-6e67-42cf-9fd9-0578fa17283b', '+17168601472', 'Cherrie Monnier',          'flight_standards', 'active', 1, 0, datetime('now')),
  ('68d98311-f774-4c75-a131-7c3b3741f492', '+13034826581', 'Brent Weckwerth',          'flight_standards', 'active', 1, 0, datetime('now')),
  ('0685f564-2cb4-467a-8306-6525ec5a860f', '+14052276981', 'Ezra Atkins',              'flight_standards', 'active', 1, 0, datetime('now'))
ON CONFLICT(phone) DO NOTHING;
