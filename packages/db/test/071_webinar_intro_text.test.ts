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
  db.exec(readFileSync(join(PKG_ROOT, 'migrations', '051_webinars.sql'), 'utf8'));
  db.exec(readFileSync(join(PKG_ROOT, 'migrations', '071_webinar_intro_text.sql'), 'utf8'));
  dbs.push(db);
  return db;
}

describe('071_webinar_intro_text.sql', () => {
  test('intro_text は NULL 許容の TEXT 列として追加される', () => {
    const db = createDatabase();
    const column = db
      .prepare(`PRAGMA table_info(webinars)`)
      .all()
      .find((row) => (row as { name: string }).name === 'intro_text') as {
        type: string;
        notnull: number;
      } | undefined;

    expect(column).toMatchObject({ type: 'TEXT', notnull: 0 });
  });

  test('intro_text を指定しない既存形式の INSERT は通り、intro_text は NULL になる', () => {
    const db = createDatabase();
    db.prepare(
      `INSERT INTO webinars (id, title, slug, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run('webinar-1', 'テストウェビナー', 'test-webinar', 'created', 'updated');

    const row = db
      .prepare(`SELECT intro_text FROM webinars WHERE id = ?`)
      .get('webinar-1') as { intro_text: string | null };
    expect(row.intro_text).toBeNull();
  });
});
