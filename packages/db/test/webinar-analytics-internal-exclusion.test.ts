import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { updateFriendInternalStatus } from '../src/friends.js';
import {
  getWebinarAnalyticsSummary,
  getWebinarDailyStats,
  getWebinarDropoff,
  getWebinarFormFunnelStats,
  getWebinarJourneyStats,
  getWebinarParticipantStats,
  getWebinarSessionStats,
} from '../src/webinars.js';

const testDir = dirname(fileURLToPath(import.meta.url));

function asD1(sqlite: Database.Database): D1Database {
  return {
    prepare(sql: string) {
      const statement = sqlite.prepare(sql);
      return {
        bind(...params: unknown[]) {
          return {
            async run() {
              const result = statement.run(...params);
              return { success: true, meta: { changes: result.changes } };
            },
            async first<T>() {
              return (statement.get(...params) as T) ?? null;
            },
            async all<T>() {
              return { success: true, results: statement.all(...params) as T[], meta: {} };
            },
          };
        },
      };
    },
  } as unknown as D1Database;
}

function seedAnalyticsDb(): Database.Database {
  const sqlite = new Database(':memory:');
  sqlite.exec(`
    CREATE TABLE webinars (
      id TEXT PRIMARY KEY,
      account_id TEXT,
      duration_seconds INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      funnel_entry_tag_id TEXT,
      funnel_invite_tag_id TEXT
    );
    CREATE TABLE friends (
      id TEXT PRIMARY KEY,
      line_account_id TEXT,
      display_name TEXT,
      picture_url TEXT,
      is_internal INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE friend_tags (friend_id TEXT NOT NULL, tag_id TEXT NOT NULL);
    CREATE TABLE webinar_followup_configs (webinar_id TEXT NOT NULL, enabled_at TEXT NOT NULL);
    CREATE TABLE webinar_ctas (
      id TEXT PRIMARY KEY,
      webinar_id TEXT NOT NULL,
      at_seconds INTEGER NOT NULL,
      form_id TEXT
    );
    CREATE TABLE webinar_viewers (
      id TEXT PRIMARY KEY,
      webinar_id TEXT NOT NULL,
      friend_id TEXT NOT NULL,
      session_start_at INTEGER NOT NULL,
      joined_at TEXT NOT NULL,
      last_position_seconds INTEGER NOT NULL,
      cta_clicked_at TEXT
    );
    CREATE TABLE webinar_registrations (
      id TEXT PRIMARY KEY,
      webinar_id TEXT NOT NULL,
      friend_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE webinar_picker_opens (
      id TEXT PRIMARY KEY,
      webinar_id TEXT NOT NULL,
      friend_id TEXT NOT NULL,
      opened_at TEXT NOT NULL
    );
    CREATE TABLE webinar_funnel_events (
      id TEXT PRIMARY KEY,
      webinar_id TEXT NOT NULL,
      friend_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      field_name TEXT NOT NULL
    );
    CREATE TABLE form_opens (
      id TEXT PRIMARY KEY,
      form_id TEXT NOT NULL,
      friend_id TEXT,
      opened_at TEXT NOT NULL
    );
    CREATE TABLE form_submissions (
      id TEXT PRIMARY KEY,
      form_id TEXT NOT NULL,
      friend_id TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE webinar_followups (
      id TEXT PRIMARY KEY,
      webinar_id TEXT NOT NULL,
      friend_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      status TEXT NOT NULL
    );
    CREATE TABLE webinar_journey_followups (
      id TEXT PRIMARY KEY,
      webinar_id TEXT NOT NULL,
      friend_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      status TEXT NOT NULL
    );

    INSERT INTO webinars VALUES
      ('w1', 'a1', 1200, '2026-08-01T00:00:00+09:00', 'tag-entry', 'tag-invite');
    INSERT INTO friends VALUES
      ('external', 'a1', '外部アカウント', NULL, 0),
      ('internal', 'a1', '内部アカウント', NULL, 1);
    INSERT INTO friend_tags VALUES
      ('external', 'tag-entry'), ('external', 'tag-invite'),
      ('internal', 'tag-entry'), ('internal', 'tag-invite');
    INSERT INTO webinar_followup_configs VALUES
      ('w1', '2026-08-01T00:00:00+09:00');
    INSERT INTO webinar_ctas VALUES ('cta-1', 'w1', 300, 'form-1');

    INSERT INTO webinar_picker_opens VALUES
      ('picker-external', 'w1', 'external', '2026-08-01T10:00:00+09:00'),
      ('picker-internal', 'w1', 'internal', '2026-08-01T10:00:00+09:00');
    INSERT INTO webinar_registrations VALUES
      ('registration-external', 'w1', 'external', '2026-08-01T10:01:00+09:00'),
      ('registration-internal', 'w1', 'internal', '2026-08-01T10:01:00+09:00');
    INSERT INTO webinar_viewers VALUES
      ('viewer-external', 'w1', 'external', 1000, '2026-08-01T10:02:00+09:00', 600, '2026-08-01T10:12:00+09:00'),
      ('viewer-internal', 'w1', 'internal', 1000, '2026-08-01T10:02:00+09:00', 1200, '2026-08-01T10:22:00+09:00');
    INSERT INTO webinar_funnel_events VALUES
      ('start-external', 'w1', 'external', 'form_start', ''),
      ('attempt-external', 'w1', 'external', 'submit_attempt', ''),
      ('field-external', 'w1', 'external', 'field_complete', 'name'),
      ('start-internal', 'w1', 'internal', 'form_start', ''),
      ('attempt-internal', 'w1', 'internal', 'submit_attempt', ''),
      ('field-internal', 'w1', 'internal', 'field_complete', 'name');
    INSERT INTO form_opens VALUES
      ('open-external', 'form-1', 'external', '2026-08-01T10:13:00+09:00'),
      ('open-internal', 'form-1', 'internal', '2026-08-01T10:23:00+09:00');
    INSERT INTO form_submissions VALUES
      ('submission-external', 'form-1', 'external', '2026-08-01T10:14:00+09:00'),
      ('submission-internal', 'form-1', 'internal', '2026-08-01T10:24:00+09:00');
    INSERT INTO webinar_followups VALUES
      ('followup-external', 'w1', 'external', 'after_30m', 'sent'),
      ('followup-internal', 'w1', 'internal', 'after_30m', 'sent');
    INSERT INTO webinar_journey_followups VALUES
      ('journey-external', 'w1', 'external', 'picker_no_registration', 'pending'),
      ('journey-internal', 'w1', 'internal', 'picker_no_registration', 'pending');
  `);
  return sqlite;
}

async function collectStats(db: D1Database, excludeInternal?: boolean) {
  const [sessions, dropoff, participants, summary, daily, formFunnel, journey] = await Promise.all([
    getWebinarSessionStats(db, 'w1', excludeInternal),
    getWebinarDropoff(db, 'w1', excludeInternal),
    getWebinarParticipantStats(db, 'w1', 200, excludeInternal),
    getWebinarAnalyticsSummary(db, 'w1', 1080, excludeInternal),
    getWebinarDailyStats(db, 'w1', excludeInternal),
    getWebinarFormFunnelStats(db, 'w1', excludeInternal),
    getWebinarJourneyStats(db, 'w1', excludeInternal),
  ]);
  return { sessions, dropoff, participants, summary, daily, formFunnel, journey };
}

describe('webinar analytics internal exclusion', () => {
  let sqlite: Database.Database;
  let db: D1Database;

  beforeEach(() => {
    sqlite = seedAnalyticsDb();
    db = asD1(sqlite);
  });

  afterEach(() => sqlite.close());

  it('excludeInternal=true は7つの分析ブロックから内部アカウントを除外する', async () => {
    const stats = await collectStats(db, true);

    expect(stats.sessions).toEqual([{
      session_start_at: 1000,
      viewers: 1,
      avg_watched_seconds: 600,
      cta_clicks: 1,
    }]);
    expect(stats.dropoff).toEqual([{ bucket_start: 600, viewers: 1 }]);
    expect(stats.participants).toHaveLength(1);
    expect(stats.participants[0].friend_id).toBe('external');
    expect(stats.summary).toEqual({
      reservations: 1,
      viewers: 1,
      registered_and_joined: 1,
      watched_5m: 1,
      watched_15m: 0,
      completed: 0,
      avg_watched_seconds: 600,
      cta_clicks: 1,
      form_submissions: 1,
    });
    expect(stats.daily).toEqual([{
      stat_date: '2026-08-01',
      reservations: 1,
      viewers: 1,
      cta_clicks: 1,
      form_submissions: 1,
    }]);
    expect(stats.formFunnel).toEqual({
      cta_impressions: 1,
      cta_clicks: 1,
      form_opens: 1,
      form_starts: 1,
      submit_attempts: 1,
      submit_successes: 1,
      submit_errors: 0,
      field_completions: [{ field_name: 'name', users: 1 }],
    });
    expect(stats.journey).toMatchObject({
      picker_opens: 1,
      registrations: 1,
      viewers: 1,
      form_submissions: 1,
      entry_tag_friends: 1,
      invite_tag_friends: 1,
      followups: {
        after_30m: { pending: 0, sent: 1, failed: 0 },
      },
      journey_followups: {
        picker_no_registration: { pending: 1, sent: 0, failed: 0, skipped: 0 },
      },
    });
  });

  it('指定なしは従来どおり内部アカウントを含める', async () => {
    const stats = await collectStats(db);

    expect(stats.sessions).toEqual([{
      session_start_at: 1000,
      viewers: 2,
      avg_watched_seconds: 900,
      cta_clicks: 2,
    }]);
    expect(stats.dropoff).toEqual([
      { bucket_start: 600, viewers: 1 },
      { bucket_start: 1200, viewers: 1 },
    ]);
    expect(stats.participants.map((participant) => participant.friend_id).sort()).toEqual(['external', 'internal']);
    expect(stats.summary).toEqual({
      reservations: 2,
      viewers: 2,
      registered_and_joined: 2,
      watched_5m: 2,
      watched_15m: 1,
      completed: 1,
      avg_watched_seconds: 900,
      cta_clicks: 2,
      form_submissions: 2,
    });
    expect(stats.daily).toEqual([{
      stat_date: '2026-08-01',
      reservations: 2,
      viewers: 2,
      cta_clicks: 2,
      form_submissions: 2,
    }]);
    expect(stats.formFunnel).toEqual({
      cta_impressions: 2,
      cta_clicks: 2,
      form_opens: 2,
      form_starts: 2,
      submit_attempts: 2,
      submit_successes: 2,
      submit_errors: 0,
      field_completions: [{ field_name: 'name', users: 2 }],
    });
    expect(stats.journey).toMatchObject({
      picker_opens: 2,
      registrations: 2,
      viewers: 2,
      form_submissions: 2,
      entry_tag_friends: 2,
      invite_tag_friends: 2,
      followups: {
        after_30m: { pending: 0, sent: 2, failed: 0 },
      },
      journey_followups: {
        picker_no_registration: { pending: 2, sent: 0, failed: 0, skipped: 0 },
      },
    });
  });
});

describe('078_friend_internal.sql', () => {
  it('friends.is_internal をデフォルト0で追加する', () => {
    const sqlite = new Database(':memory:');
    sqlite.exec('CREATE TABLE friends (id TEXT PRIMARY KEY, updated_at TEXT)');
    sqlite.exec(readFileSync(join(testDir, '..', 'migrations', '078_friend_internal.sql'), 'utf8'));
    sqlite.prepare('INSERT INTO friends (id) VALUES (?)').run('friend-1');

    expect(sqlite.prepare('SELECT is_internal FROM friends WHERE id = ?').get('friend-1')).toEqual({ is_internal: 0 });
    sqlite.close();
  });

  it('友だち更新APIのDBヘルパーで0/1を切り替えられる', async () => {
    const sqlite = new Database(':memory:');
    sqlite.exec('CREATE TABLE friends (id TEXT PRIMARY KEY, updated_at TEXT)');
    sqlite.exec(readFileSync(join(testDir, '..', 'migrations', '078_friend_internal.sql'), 'utf8'));
    sqlite.prepare('INSERT INTO friends (id) VALUES (?)').run('friend-1');

    const db = asD1(sqlite);
    expect((await updateFriendInternalStatus(db, 'friend-1', true))?.is_internal).toBe(1);
    expect((await updateFriendInternalStatus(db, 'friend-1', false))?.is_internal).toBe(0);
    sqlite.close();
  });
});
