ALTER TABLE webinar_registrations ADD COLUMN reminded_day_before_at TEXT;

CREATE INDEX IF NOT EXISTS idx_webinar_regs_day_before_due
  ON webinar_registrations (reminded_day_before_at, session_start_at);
