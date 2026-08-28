import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import Database from 'better-sqlite3';

import { hasFriendSubmittedForm } from '../src/forms.js';

function asD1(sqlite: Database.Database): D1Database {
  return {
    prepare(query: string) {
      return {
        bind(...params: unknown[]) {
          const statement = sqlite.prepare(query);
          return {
            async first<T>() {
              return (statement.get(...params) as T) ?? null;
            },
          };
        },
      };
    },
  } as unknown as D1Database;
}

describe('hasFriendSubmittedForm', () => {
  let sqlite: Database.Database;
  let db: D1Database;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    sqlite.exec(`
      CREATE TABLE form_submissions (
        id TEXT PRIMARY KEY,
        form_id TEXT NOT NULL,
        friend_id TEXT,
        data TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    `);
    db = asD1(sqlite);
  });

  afterEach(() => sqlite.close());

  test('returns true only when the friend has submitted the requested form', async () => {
    sqlite
      .prepare(
        `INSERT INTO form_submissions (id, form_id, friend_id, data, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run('submission-1', 'form-1', 'friend-1', '{}', '2026-08-28T10:00:00+09:00');

    await expect(hasFriendSubmittedForm(db, 'form-1', 'friend-1')).resolves.toBe(true);
    await expect(hasFriendSubmittedForm(db, 'form-1', 'friend-2')).resolves.toBe(false);
    await expect(hasFriendSubmittedForm(db, 'form-2', 'friend-1')).resolves.toBe(false);
  });
});
