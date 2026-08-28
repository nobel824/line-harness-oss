import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import Database from 'better-sqlite3';

const MIGRATION = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'migrations',
  '075_webinar_journey_archive_closing.sql',
);

function createPreMigrationDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE webinars (id TEXT PRIMARY KEY);
    CREATE TABLE friends (id TEXT PRIMARY KEY);
    INSERT INTO webinars (id) VALUES ('webinar-1');
    INSERT INTO friends (id) VALUES ('friend-1');
    CREATE TABLE webinar_journey_followups (
      id          TEXT PRIMARY KEY,
      webinar_id  TEXT NOT NULL REFERENCES webinars(id) ON DELETE CASCADE,
      friend_id   TEXT NOT NULL REFERENCES friends(id) ON DELETE CASCADE,
      kind        TEXT NOT NULL CHECK (kind IN (
        'picker_no_registration',
        'registered_no_show',
        'submitted_no_booking_30m',
        'submitted_no_booking_24h'
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
    CREATE INDEX idx_webinar_journey_followups_status
      ON webinar_journey_followups (status, updated_at);
    INSERT INTO webinar_journey_followups
      (id, webinar_id, friend_id, kind, retry_key, status, sent_at, last_error, created_at, updated_at)
    VALUES
      ('old-1', 'webinar-1', 'friend-1', 'registered_no_show', 'retry-1', 'sent',
       '2026-08-28T10:00:00+09:00', NULL, '2026-08-27T10:00:00+09:00', '2026-08-28T10:00:00+09:00');
  `);
  return db;
}

describe('075_webinar_journey_archive_closing', () => {
  test('既存行を引き継ぎ、archive_closing を許可する', () => {
    const db = createPreMigrationDb();
    try {
      db.exec(readFileSync(MIGRATION, 'utf8'));

      expect(db.prepare('SELECT * FROM webinar_journey_followups').get()).toEqual({
        id: 'old-1',
        webinar_id: 'webinar-1',
        friend_id: 'friend-1',
        kind: 'registered_no_show',
        retry_key: 'retry-1',
        status: 'sent',
        sent_at: '2026-08-28T10:00:00+09:00',
        last_error: null,
        created_at: '2026-08-27T10:00:00+09:00',
        updated_at: '2026-08-28T10:00:00+09:00',
      });

      db.prepare(
        `INSERT INTO webinar_journey_followups
          (id, webinar_id, friend_id, kind, retry_key, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        'archive-1', 'webinar-1', 'friend-1', 'archive_closing', 'retry-a',
        'pending', '2026-08-28T12:00:00+09:00', '2026-08-28T12:00:00+09:00',
      );
      expect(() => db.prepare(
        `INSERT INTO webinar_journey_followups
          (id, webinar_id, friend_id, kind, retry_key, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        'archive-duplicate', 'webinar-1', 'friend-1', 'archive_closing', 'retry-b',
        'pending', '2026-08-28T12:00:00+09:00', '2026-08-28T12:00:00+09:00',
      )).toThrow(/UNIQUE constraint failed/);
      expect(() => db.prepare(
        `INSERT INTO webinar_journey_followups
          (id, webinar_id, friend_id, kind, retry_key, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        'invalid-1', 'webinar-1', 'friend-1', 'unknown_kind', 'retry-x',
        'pending', '2026-08-28T12:00:00+09:00', '2026-08-28T12:00:00+09:00',
      )).toThrow(/CHECK constraint failed/);
    } finally {
      db.close();
    }
  });
});
