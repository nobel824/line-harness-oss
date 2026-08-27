import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { getMyWebinarSessionComments } from '../src/webinars.js';

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
          };
        },
      };
    },
  } as unknown as D1Database;
}

describe('getMyWebinarSessionComments', () => {
  let sqlite: Database.Database;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    sqlite.exec(`
      CREATE TABLE webinar_user_comments (
        id TEXT PRIMARY KEY,
        webinar_id TEXT NOT NULL,
        friend_id TEXT NOT NULL,
        session_start_at INTEGER NOT NULL,
        at_seconds INTEGER NOT NULL,
        body TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      INSERT INTO webinar_user_comments VALUES
        ('c-mine-early', 'webinar-1', 'friend-me', 1000, 10, '自分の発言1', '2026-08-27T20:00:10+09:00'),
        ('c-other', 'webinar-1', 'friend-other', 1000, 12, '他人の発言', '2026-08-27T20:00:12+09:00'),
        ('c-mine-late', 'webinar-1', 'friend-me', 1000, 40, '自分の発言2', '2026-08-27T20:00:40+09:00'),
        ('c-other-session', 'webinar-1', 'friend-me', 2000, 5, '別セッションの自分の発言', '2026-08-27T21:00:05+09:00');
    `);
  });

  afterEach(() => sqlite.close());

  it('その friend とその回のコメントだけを at_seconds 順で返し、他人は含めない', async () => {
    const comments = await getMyWebinarSessionComments(
      asD1(sqlite),
      'webinar-1',
      'friend-me',
      1000,
    );

    expect(comments).toEqual([
      { id: 'c-mine-early', at_seconds: 10, body: '自分の発言1' },
      { id: 'c-mine-late', at_seconds: 40, body: '自分の発言2' },
    ]);
    expect(comments.map((row) => row.body)).not.toContain('他人の発言');
    expect(comments.map((row) => row.body)).not.toContain('別セッションの自分の発言');
  });
});
