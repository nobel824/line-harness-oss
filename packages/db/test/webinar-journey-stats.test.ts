import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { getWebinarJourneyStats } from '../src/webinars.js';

function asD1(sqlite: Database.Database): D1Database {
  return {
    prepare(sql: string) {
      return {
        bind(...params: unknown[]) {
          const statement = sqlite.prepare(sql);
          return {
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

describe('getWebinarJourneyStats', () => {
  let sqlite: Database.Database;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    sqlite.exec(`
      CREATE TABLE webinars (
        id TEXT PRIMARY KEY,
        account_id TEXT,
        funnel_entry_tag_id TEXT,
        funnel_invite_tag_id TEXT
      );
      CREATE TABLE friends (
        id TEXT PRIMARY KEY,
        line_account_id TEXT,
        is_internal INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE friend_tags (friend_id TEXT NOT NULL, tag_id TEXT NOT NULL);
      CREATE TABLE webinar_picker_opens (
        id TEXT PRIMARY KEY, webinar_id TEXT NOT NULL, friend_id TEXT NOT NULL
      );
      CREATE TABLE webinar_registrations (
        id TEXT PRIMARY KEY, webinar_id TEXT NOT NULL, friend_id TEXT NOT NULL
      );
      CREATE TABLE webinar_viewers (
        id TEXT PRIMARY KEY, webinar_id TEXT NOT NULL, friend_id TEXT NOT NULL
      );
      CREATE TABLE webinar_ctas (
        id TEXT PRIMARY KEY, webinar_id TEXT NOT NULL, form_id TEXT
      );
      CREATE TABLE form_submissions (
        id TEXT PRIMARY KEY, form_id TEXT NOT NULL, friend_id TEXT
      );
      CREATE TABLE webinar_followups (
        id TEXT PRIMARY KEY,
        webinar_id TEXT NOT NULL,
        friend_id TEXT,
        kind TEXT NOT NULL,
        status TEXT NOT NULL
      );
      CREATE TABLE webinar_journey_followups (
        id TEXT PRIMARY KEY,
        webinar_id TEXT NOT NULL,
        friend_id TEXT,
        kind TEXT NOT NULL,
        status TEXT NOT NULL
      );

      INSERT INTO webinars VALUES ('webinar-1', NULL, NULL, NULL);
      INSERT INTO friends (id, line_account_id) VALUES ('friend-1', 'account-1');
      INSERT INTO friends (id, line_account_id) VALUES ('friend-2', 'account-1');
      INSERT INTO webinar_picker_opens VALUES ('picker-1', 'webinar-1', 'friend-1');
      INSERT INTO webinar_picker_opens VALUES ('picker-2', 'webinar-1', 'friend-2');
      INSERT INTO webinar_registrations VALUES ('registration-1', 'webinar-1', 'friend-1');
      INSERT INTO webinar_registrations VALUES ('registration-2', 'webinar-1', 'friend-1');
      INSERT INTO webinar_viewers VALUES ('viewer-1', 'webinar-1', 'friend-1');
      INSERT INTO webinar_ctas VALUES ('cta-1', 'webinar-1', 'form-1');
      INSERT INTO webinar_ctas VALUES ('cta-other', 'webinar-other', 'form-other');
      INSERT INTO form_submissions VALUES ('submission-1', 'form-1', 'friend-1');
      INSERT INTO form_submissions VALUES ('submission-2', 'form-1', 'friend-1');
      INSERT INTO form_submissions VALUES ('submission-null', 'form-1', NULL);
      INSERT INTO form_submissions VALUES ('submission-other', 'form-other', 'friend-2');

      INSERT INTO webinar_followups (id, webinar_id, kind, status)
        VALUES ('followup-1', 'webinar-1', 'after_30m', 'sent');
      INSERT INTO webinar_followups (id, webinar_id, kind, status)
        VALUES ('followup-2', 'webinar-1', 'after_24h', 'failed');
      INSERT INTO webinar_journey_followups (id, webinar_id, kind, status) VALUES
        ('journey-1', 'webinar-1', 'picker_no_registration', 'pending');
      INSERT INTO webinar_journey_followups (id, webinar_id, kind, status) VALUES
        ('journey-2', 'webinar-1', 'submitted_no_booking_24h', 'skipped');
      INSERT INTO webinar_journey_followups (id, webinar_id, kind, status) VALUES
        ('journey-3', 'webinar-1', 'archive_closing', 'sent');
    `);
  });

  afterEach(() => sqlite.close());

  it('各段の件数と、存在しない kind × status の 0 を返す', async () => {
    const stats = await getWebinarJourneyStats(asD1(sqlite), 'webinar-1');

    expect(stats).toEqual({
      picker_opens: 2,
      picker_opens_from_invite: null,
      registrations: 1,
      viewers: 1,
      form_submissions: 1,
      entry_tag_friends: null,
      invite_tag_friends: null,
      followups: {
        after_30m: { pending: 0, sent: 1, failed: 0 },
        after_24h: { pending: 0, sent: 0, failed: 1 },
      },
      journey_followups: {
        picker_no_registration: { pending: 1, sent: 0, failed: 0, skipped: 0 },
        registered_no_show: { pending: 0, sent: 0, failed: 0, skipped: 0 },
        submitted_no_booking_30m: { pending: 0, sent: 0, failed: 0, skipped: 0 },
        submitted_no_booking_24h: { pending: 0, sent: 0, failed: 0, skipped: 1 },
        archive_closing: { pending: 0, sent: 1, failed: 0, skipped: 0 },
      },
    });
  });

  it('ピッカー表示のうち案内タグを持つ人を内数として DISTINCT で数える', async () => {
    sqlite
      .prepare(
        `UPDATE webinars
            SET account_id = ?, funnel_invite_tag_id = ?
          WHERE id = ?`,
      )
      .run('account-1', 'tag-invite', 'webinar-1');
    sqlite.prepare('INSERT INTO friend_tags VALUES (?, ?)').run('friend-1', 'tag-invite');

    const stats = await getWebinarJourneyStats(asD1(sqlite), 'webinar-1');

    expect(stats.picker_opens).toBe(2);
    expect(stats.picker_opens_from_invite).toBe(1);
  });

  it('案内タグ未設定のウェビナーではピッカー表示の案内経由内数を null で返す', async () => {
    const stats = await getWebinarJourneyStats(asD1(sqlite), 'webinar-1');

    expect(stats.picker_opens_from_invite).toBeNull();
  });

  it('excludeInternal=true はピッカー表示総数と案内経由内数から内部アカウントを除外する', async () => {
    sqlite
      .prepare(
        `UPDATE webinars
            SET account_id = ?, funnel_invite_tag_id = ?
          WHERE id = ?`,
      )
      .run('account-1', 'tag-invite', 'webinar-1');
    sqlite.prepare('UPDATE friends SET is_internal = 1 WHERE id = ?').run('friend-2');
    sqlite.prepare('INSERT INTO friend_tags VALUES (?, ?)').run('friend-1', 'tag-invite');
    sqlite.prepare('INSERT INTO friend_tags VALUES (?, ?)').run('friend-2', 'tag-invite');

    const stats = await getWebinarJourneyStats(asD1(sqlite), 'webinar-1', true);

    expect(stats.picker_opens).toBe(1);
    expect(stats.picker_opens_from_invite).toBe(1);
  });

  it('設定したタグは同じ account_id の friend だけを DISTINCT で数える', async () => {
    sqlite
      .prepare(
        `UPDATE webinars
            SET account_id = ?, funnel_entry_tag_id = ?, funnel_invite_tag_id = ?
          WHERE id = ?`,
      )
      .run('account-1', 'tag-entry', 'tag-invite', 'webinar-1');
    sqlite
      .prepare('INSERT INTO friends (id, line_account_id) VALUES (?, ?)')
      .run('friend-other-account', 'account-2');
    sqlite.prepare('INSERT INTO friend_tags VALUES (?, ?)').run('friend-1', 'tag-entry');
    sqlite.prepare('INSERT INTO friend_tags VALUES (?, ?)').run('friend-other-account', 'tag-entry');
    sqlite.prepare('INSERT INTO friend_tags VALUES (?, ?)').run('friend-2', 'tag-invite');
    sqlite.prepare('INSERT INTO friend_tags VALUES (?, ?)').run('friend-other-account', 'tag-invite');

    const stats = await getWebinarJourneyStats(asD1(sqlite), 'webinar-1');

    expect(stats.entry_tag_friends).toBe(1);
    expect(stats.invite_tag_friends).toBe(1);
  });
});
