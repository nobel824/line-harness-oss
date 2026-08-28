-- 075: archive_closing を journey follow-up の kind CHECK に追加する。
-- SQLite は既存の CHECK 制約を ALTER TABLE できないため、既存行を
-- 引き継いだ新テーブルへ作り替える。

CREATE TABLE webinar_journey_followups_new (
  id          TEXT PRIMARY KEY,
  webinar_id  TEXT NOT NULL REFERENCES webinars(id) ON DELETE CASCADE,
  friend_id   TEXT NOT NULL REFERENCES friends(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN (
    'picker_no_registration',
    'registered_no_show',
    'submitted_no_booking_30m',
    'submitted_no_booking_24h',
    'archive_closing'
  )),
  retry_key   TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending', 'sent', 'failed', 'skipped')),
  sent_at     TEXT,
  last_error  TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  UNIQUE (webinar_id, friend_id, kind)
);

INSERT INTO webinar_journey_followups_new (
  id, webinar_id, friend_id, kind, retry_key, status, sent_at, last_error,
  created_at, updated_at
)
SELECT
  id, webinar_id, friend_id, kind, retry_key, status, sent_at, last_error,
  created_at, updated_at
FROM webinar_journey_followups;

DROP TABLE webinar_journey_followups;
ALTER TABLE webinar_journey_followups_new RENAME TO webinar_journey_followups;

CREATE INDEX IF NOT EXISTS idx_webinar_journey_followups_status
  ON webinar_journey_followups (status, updated_at);
