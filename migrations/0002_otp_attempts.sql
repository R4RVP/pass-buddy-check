-- PASS Buddy Check — Migration 0002
-- OTP attempt tracking: rate limiting + code verification

CREATE TABLE IF NOT EXISTS otp_attempts (
  id         TEXT    NOT NULL PRIMARY KEY,
  phone      TEXT    NOT NULL,
  code       TEXT    NOT NULL,
  created_at TEXT    NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT    NOT NULL,
  used       INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_otp_phone_created
  ON otp_attempts(phone, created_at);

-- Rows are purged by the M11 cron job (7 days post-expiry).
-- used=1 rows are harmless but kept for audit within that window.
