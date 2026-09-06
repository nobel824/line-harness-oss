import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { getWebinarDropoff } from '../src/webinars.js';

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

describe('getWebinarDropoff', () => {
  let sqlite: Database.Database;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    sqlite.exec(`
      CREATE TABLE friends (
        id TEXT PRIMARY KEY,
        is_internal INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE webinar_viewers (
        webinar_id TEXT NOT NULL,
        friend_id TEXT NOT NULL,
        last_position_seconds INTEGER NOT NULL
      );

      INSERT INTO friends VALUES ('friend-1', 0);
      INSERT INTO webinar_viewers VALUES
        ('webinar-1', 'friend-1', 601),
        ('webinar-1', 'friend-1', 1201);
    `);
  });

  afterEach(() => sqlite.close());

  it('同じ人が複数セッションに参加しても MAX のバケットだけを1人として数える', async () => {
    const dropoff = await getWebinarDropoff(asD1(sqlite), 'webinar-1');

    expect(dropoff).toEqual([{ bucket_start: 1200, viewers: 1 }]);
  });
});
