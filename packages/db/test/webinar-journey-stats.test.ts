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
      CREATE TABLE webinar_picker_opens (
        id TEXT PRIMARY KEY, webinar_id TEXT NOT NULL
      );
      CREATE TABLE webinar_registrations (
        id TEXT PRIMARY KEY, webinar_id TEXT NOT NULL
      );
      CREATE TABLE webinar_viewers (
        id TEXT PRIMARY KEY, webinar_id TEXT NOT NULL
      );
      CREATE TABLE webinar_ctas (
        id TEXT PRIMARY KEY, webinar_id TEXT NOT NULL, form_id TEXT
      );
      CREATE TABLE form_submissions (
        id TEXT PRIMARY KEY, form_id TEXT NOT NULL
      );
      CREATE TABLE webinar_followups (
        id TEXT PRIMARY KEY, webinar_id TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL
      );
      CREATE TABLE webinar_journey_followups (
        id TEXT PRIMARY KEY, webinar_id TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL
      );

      INSERT INTO webinar_picker_opens VALUES ('picker-1', 'webinar-1');
      INSERT INTO webinar_picker_opens VALUES ('picker-2', 'webinar-1');
      INSERT INTO webinar_registrations VALUES ('registration-1', 'webinar-1');
      INSERT INTO webinar_registrations VALUES ('registration-2', 'webinar-1');
      INSERT INTO webinar_viewers VALUES ('viewer-1', 'webinar-1');
      INSERT INTO webinar_ctas VALUES ('cta-1', 'webinar-1', 'form-1');
      INSERT INTO webinar_ctas VALUES ('cta-other', 'webinar-other', 'form-other');
      INSERT INTO form_submissions VALUES ('submission-1', 'form-1');
      INSERT INTO form_submissions VALUES ('submission-2', 'form-1');
      INSERT INTO form_submissions VALUES ('submission-other', 'form-other');

      INSERT INTO webinar_followups VALUES ('followup-1', 'webinar-1', 'after_30m', 'sent');
      INSERT INTO webinar_followups VALUES ('followup-2', 'webinar-1', 'after_24h', 'failed');
      INSERT INTO webinar_journey_followups VALUES
        ('journey-1', 'webinar-1', 'picker_no_registration', 'pending');
      INSERT INTO webinar_journey_followups VALUES
        ('journey-2', 'webinar-1', 'submitted_no_booking_24h', 'skipped');
    `);
  });

  afterEach(() => sqlite.close());

  it('各段の件数と、存在しない kind × status の 0 を返す', async () => {
    const stats = await getWebinarJourneyStats(asD1(sqlite), 'webinar-1');

    expect(stats).toEqual({
      picker_opens: 2,
      registrations: 2,
      viewers: 1,
      form_submissions: 2,
      followups: {
        after_30m: { pending: 0, sent: 1, failed: 0 },
        after_24h: { pending: 0, sent: 0, failed: 1 },
      },
      journey_followups: {
        picker_no_registration: { pending: 1, sent: 0, failed: 0, skipped: 0 },
        registered_no_show: { pending: 0, sent: 0, failed: 0, skipped: 0 },
        submitted_no_booking_30m: { pending: 0, sent: 0, failed: 0, skipped: 0 },
        submitted_no_booking_24h: { pending: 0, sent: 0, failed: 0, skipped: 1 },
      },
    });
  });
});
