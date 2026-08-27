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
  db.exec(readFileSync(join(PKG_ROOT, 'migrations', '070_google_calendar_busy_calendars.sql'), 'utf8'));
  dbs.push(db);
  return db;
}

describe('070_google_calendar_busy_calendars.sql', () => {
  test('busy_calendar_ids は NULL 許容の TEXT 列として追加される', () => {
    const db = createDatabase();
    const column = db
      .prepare(`PRAGMA table_info(google_calendar_connections)`)
      .all()
      .find((row) => (row as { name: string }).name === 'busy_calendar_ids') as {
        type: string;
        notnull: number;
      } | undefined;

    expect(column).toMatchObject({ type: 'TEXT', notnull: 0 });
  });

  test('列を指定しない既存形式の INSERT は通り、busy_calendar_ids は NULL になる', () => {
    const db = createDatabase();
    db.prepare(
      `INSERT INTO google_calendar_connections (id, calendar_id)
       VALUES (?, ?)`,
    ).run('connection-1', 'primary@example.com');

    const row = db
      .prepare(`SELECT busy_calendar_ids FROM google_calendar_connections WHERE id = ?`)
      .get('connection-1') as { busy_calendar_ids: string | null };
    expect(row.busy_calendar_ids).toBeNull();
  });
});
