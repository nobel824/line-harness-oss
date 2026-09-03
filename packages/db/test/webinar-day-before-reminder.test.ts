import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import {
  getDueDayBeforeWebinarRegistrations,
  markWebinarRegistrationDayBeforeReminded,
} from '../src/webinars.js';

type TestResult = {
  success: true;
  meta: { changes: number; last_row_id: number };
};

function asD1(sqlite: Database.Database): D1Database {
  return {
    prepare(sql: string) {
      return {
        bind(...params: unknown[]) {
          const statement = sqlite.prepare(sql);
          return {
            async all<T>() {
              return { success: true, results: statement.all(...params) as T[], meta: {} };
            },
            async run(): Promise<TestResult> {
              const result = statement.run(...params);
              return {
                success: true,
                meta: { changes: result.changes, last_row_id: Number(result.lastInsertRowid) },
              };
            },
          };
        },
      };
    },
  } as unknown as D1Database;
}

const NOW = 1_800_000_000;
const LOOKAHEAD = 32 * 60 * 60;

function createSqlite(): Database.Database {
  const sqlite = new Database(':memory:');
  sqlite.exec(`
    CREATE TABLE webinars (
      id TEXT PRIMARY KEY,
      slug TEXT NOT NULL,
      title TEXT NOT NULL,
      account_id TEXT,
      status TEXT NOT NULL,
      duration_seconds INTEGER NOT NULL
    );
    CREATE TABLE webinar_registrations (
      id TEXT PRIMARY KEY,
      webinar_id TEXT NOT NULL,
      friend_id TEXT NOT NULL,
      session_start_at INTEGER NOT NULL,
      notified_at TEXT,
      reminded_day_before_at TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX idx_webinar_regs_day_before_due
      ON webinar_registrations (reminded_day_before_at, session_start_at);
  `);
  sqlite.prepare(
    `INSERT INTO webinars (id, slug, title, account_id, status, duration_seconds)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run('active-webinar', 'active', 'Active webinar', null, 'active', 3449);
  sqlite.prepare(
    `INSERT INTO webinars (id, slug, title, account_id, status, duration_seconds)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run('draft-webinar', 'draft', 'Draft webinar', null, 'draft', 3449);
  return sqlite;
}

function insertRegistration(
  sqlite: Database.Database,
  values: {
    id: string;
    webinarId?: string;
    sessionStartAt: number;
    remindedDayBeforeAt?: string | null;
  },
) {
  sqlite.prepare(
    `INSERT INTO webinar_registrations (
       id, webinar_id, friend_id, session_start_at, notified_at, reminded_day_before_at, created_at
     ) VALUES (?, ?, ?, ?, NULL, ?, ?)`,
  ).run(
    values.id,
    values.webinarId ?? 'active-webinar',
    `friend-${values.id}`,
    values.sessionStartAt,
    values.remindedDayBeforeAt ?? null,
    '2026-09-04T12:00:00.000+09:00',
  );
}

describe('day-before webinar registration queries', () => {
  let sqlite: Database.Database;

  beforeEach(() => {
    sqlite = createSqlite();
  });

  afterEach(() => sqlite.close());

  it('粗い未来範囲から未リマインドかつactiveの予約を返す', async () => {
    insertRegistration(sqlite, { id: 'due', sessionStartAt: NOW + 24 * 60 * 60 });
    insertRegistration(sqlite, {
      id: 'already-reminded',
      sessionStartAt: NOW + 24 * 60 * 60,
      remindedDayBeforeAt: '2026-09-04T20:00:00.000+09:00',
    });
    insertRegistration(sqlite, { id: 'past', sessionStartAt: NOW });
    insertRegistration(sqlite, { id: 'too-far', sessionStartAt: NOW + LOOKAHEAD + 1 });
    insertRegistration(sqlite, {
      id: 'draft', webinarId: 'draft-webinar', sessionStartAt: NOW + 24 * 60 * 60,
    });

    const rows = await getDueDayBeforeWebinarRegistrations(asD1(sqlite), NOW);

    expect(rows).toEqual([
      expect.objectContaining({
        id: 'due',
        slug: 'active',
        title: 'Active webinar',
        account_id: null,
        duration_seconds: 3449,
        reminded_day_before_at: null,
      }),
    ]);
  });

  it('前日リマインド済みマークは原子的で、2回目のクレームを拒否する', async () => {
    insertRegistration(sqlite, { id: 'claimable', sessionStartAt: NOW + 24 * 60 * 60 });
    const db = asD1(sqlite);

    await expect(markWebinarRegistrationDayBeforeReminded(db, 'claimable')).resolves.toBe(true);
    await expect(markWebinarRegistrationDayBeforeReminded(db, 'claimable')).resolves.toBe(false);

    const row = sqlite
      .prepare('SELECT reminded_day_before_at FROM webinar_registrations WHERE id = ?')
      .get('claimable') as { reminded_day_before_at: string | null };
    expect(row.reminded_day_before_at).not.toBeNull();
  });
});
