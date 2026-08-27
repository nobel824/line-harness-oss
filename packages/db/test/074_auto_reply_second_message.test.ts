import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, test } from 'vitest';

const dbs: Database.Database[] = [];
const PKG_ROOT = join(import.meta.dirname, '..');

afterEach(() => {
  while (dbs.length > 0) dbs.pop()?.close();
});

function createDatabase(): Database.Database {
  const db = new Database(':memory:');
  db.exec(readFileSync(join(PKG_ROOT, 'schema.sql'), 'utf8'));
  db.exec(readFileSync(join(PKG_ROOT, 'migrations', '074_auto_reply_second_message.sql'), 'utf8'));
  dbs.push(db);
  return db;
}

describe('074_auto_reply_second_message.sql', () => {
  test('response_type_2 / response_content_2 は NULL 許容の TEXT 列として追加される', () => {
    const db = createDatabase();
    const columns = db
      .prepare(`PRAGMA table_info(auto_replies)`)
      .all() as Array<{ name: string; type: string; notnull: number }>;

    expect(columns.find((row) => row.name === 'response_type_2')).toMatchObject({
      type: 'TEXT',
      notnull: 0,
    });
    expect(columns.find((row) => row.name === 'response_content_2')).toMatchObject({
      type: 'TEXT',
      notnull: 0,
    });
  });

  test('2通目を指定しない既存形式の INSERT は通り、既存行は壊れない', () => {
    const db = createDatabase();
    db.prepare(
      `INSERT INTO auto_replies
         (id, keyword, match_type, response_type, response_content, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('reply-1', '特典', 'exact', 'text', '1通目です', 'created');

    const row = db
      .prepare(
        `SELECT keyword, match_type, response_type, response_content,
                response_type_2, response_content_2, is_active
           FROM auto_replies WHERE id = ?`,
      )
      .get('reply-1') as {
        keyword: string;
        match_type: string;
        response_type: string;
        response_content: string;
        response_type_2: string | null;
        response_content_2: string | null;
        is_active: number;
      };

    expect(row).toMatchObject({
      keyword: '特典',
      match_type: 'exact',
      response_type: 'text',
      response_content: '1通目です',
      response_type_2: null,
      response_content_2: null,
      is_active: 1,
    });
  });
});
