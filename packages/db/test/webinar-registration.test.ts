import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { upsertWebinarRegistration } from '../src/webinars.js';

type TestResult = {
  success: true;
  meta: { changes: number; last_row_id: number };
};

type TestPreparedStatement = {
  runSync: () => TestResult;
};

function asD1(sqlite: Database.Database): D1Database {
  return {
    prepare(sql: string) {
      return {
        bind(...params: unknown[]) {
          const statement = sqlite.prepare(sql);
          const runSync = (): TestResult => {
            const result = statement.run(...params);
            return {
              success: true,
              meta: {
                changes: result.changes,
                last_row_id: Number(result.lastInsertRowid),
              },
            };
          };
          return {
            runSync,
            async run() {
              return runSync();
            },
          };
        },
      };
    },
    async batch(statements: TestPreparedStatement[]) {
      const execute = sqlite.transaction(() => statements.map((statement) => statement.runSync()));
      return execute();
    },
  } as unknown as D1Database;
}

const WEBINAR_ID = 'webinar-1';
const FRIEND_ID = 'friend-1';
const OTHER_FRIEND_ID = 'friend-2';
const NOW = 1_700_000_000;
const PAST_SESSION = NOW - 3600;
const OLD_FUTURE_SESSION = NOW + 3600;
const NEW_FUTURE_SESSION = NOW + 7200;

function insertRegistration(
  sqlite: Database.Database,
  id: string,
  friendId: string,
  sessionStartAt: number,
  notifiedAt: string | null = null,
) {
  sqlite
    .prepare(
      `INSERT INTO webinar_registrations
         (id, webinar_id, friend_id, session_start_at, notified_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(id, WEBINAR_ID, friendId, sessionStartAt, notifiedAt, '2026-08-28T12:00:00.000+09:00');
}

function getRegistrations(sqlite: Database.Database, friendId: string) {
  return sqlite
    .prepare(
      `SELECT id, webinar_id, friend_id, session_start_at, notified_at, created_at
         FROM webinar_registrations
        WHERE webinar_id = ? AND friend_id = ?
        ORDER BY session_start_at ASC`,
    )
    .all(WEBINAR_ID, friendId);
}

describe('upsertWebinarRegistration', () => {
  let sqlite: Database.Database;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    sqlite.exec(`
      CREATE TABLE webinar_registrations (
        id TEXT PRIMARY KEY,
        webinar_id TEXT NOT NULL,
        friend_id TEXT NOT NULL,
        session_start_at INTEGER NOT NULL,
        notified_at TEXT,
        created_at TEXT NOT NULL,
        UNIQUE (webinar_id, friend_id, session_start_at)
      );
    `);
  });

  afterEach(() => sqlite.close());

  it('別の回を予約すると、友だちの未来の予約は新しい回の1件だけになる', async () => {
    insertRegistration(sqlite, 'old-future', FRIEND_ID, OLD_FUTURE_SESSION);

    const created = await upsertWebinarRegistration(
      asD1(sqlite), WEBINAR_ID, FRIEND_ID, NEW_FUTURE_SESSION, NOW,
    );

    expect(created).toBe(true);
    expect(getRegistrations(sqlite, FRIEND_ID)).toEqual([
      expect.objectContaining({ id: expect.any(String), session_start_at: NEW_FUTURE_SESSION }),
    ]);
  });

  it('別の回を予約しても、過去の予約行は消えずに残る', async () => {
    insertRegistration(sqlite, 'past', FRIEND_ID, PAST_SESSION, '2026-08-27T20:00:00.000+09:00');

    const created = await upsertWebinarRegistration(
      asD1(sqlite), WEBINAR_ID, FRIEND_ID, NEW_FUTURE_SESSION, NOW,
    );

    expect(created).toBe(true);
    expect(getRegistrations(sqlite, FRIEND_ID)).toEqual([
      expect.objectContaining({
        id: 'past',
        session_start_at: PAST_SESSION,
        notified_at: '2026-08-27T20:00:00.000+09:00',
      }),
      expect.objectContaining({ session_start_at: NEW_FUTURE_SESSION }),
    ]);
  });

  it('同じ回をもう一度予約すると false を返し、その回の行はそのまま残る', async () => {
    insertRegistration(sqlite, 'target', FRIEND_ID, NEW_FUTURE_SESSION, 'already-notified');
    const before = getRegistrations(sqlite, FRIEND_ID);

    const created = await upsertWebinarRegistration(
      asD1(sqlite), WEBINAR_ID, FRIEND_ID, NEW_FUTURE_SESSION, NOW,
    );

    // false = 受付確認プッシュを再送しない。二重タップで2通飛ばさないための不変条件。
    expect(created).toBe(false);
    expect(getRegistrations(sqlite, FRIEND_ID)).toEqual(before);
  });

  it('既に複数の未来予約を持つ友だちが片方を選び直すと1件に集約される', async () => {
    // 修正前の実装が本番に残した重複 (7人に対し10行) を、選び直しで解消できること。
    insertRegistration(sqlite, 'target', FRIEND_ID, NEW_FUTURE_SESSION, 'already-notified');
    insertRegistration(sqlite, 'other-future', FRIEND_ID, OLD_FUTURE_SESSION);

    const created = await upsertWebinarRegistration(
      asD1(sqlite), WEBINAR_ID, FRIEND_ID, NEW_FUTURE_SESSION, NOW,
    );

    // 行は増えていないので受付確認は送らない。それでも余分な未来予約だけ消える。
    expect(created).toBe(false);
    expect(getRegistrations(sqlite, FRIEND_ID)).toEqual([
      expect.objectContaining({ id: 'target', session_start_at: NEW_FUTURE_SESSION }),
    ]);
  });

  it('別の友だちの予約は消さない', async () => {
    insertRegistration(sqlite, 'other-friend', OTHER_FRIEND_ID, OLD_FUTURE_SESSION);

    const created = await upsertWebinarRegistration(
      asD1(sqlite), WEBINAR_ID, FRIEND_ID, NEW_FUTURE_SESSION, NOW,
    );

    expect(created).toBe(true);
    expect(getRegistrations(sqlite, OTHER_FRIEND_ID)).toEqual([
      expect.objectContaining({
        id: 'other-friend',
        friend_id: OTHER_FRIEND_ID,
        session_start_at: OLD_FUTURE_SESSION,
      }),
    ]);
  });
});
