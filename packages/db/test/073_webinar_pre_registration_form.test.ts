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
  db.exec(readFileSync(join(PKG_ROOT, 'migrations', '007_forms.sql'), 'utf8'));
  db.exec(readFileSync(join(PKG_ROOT, 'migrations', '051_webinars.sql'), 'utf8'));
  db.exec(readFileSync(join(PKG_ROOT, 'migrations', '071_webinar_intro_text.sql'), 'utf8'));
  db.exec(readFileSync(join(PKG_ROOT, 'migrations', '072_webinar_intro_image_url.sql'), 'utf8'));
  db.exec(readFileSync(join(PKG_ROOT, 'migrations', '073_webinar_pre_registration_form.sql'), 'utf8'));
  dbs.push(db);
  return db;
}

describe('073_webinar_pre_registration_form.sql', () => {
  test('pre_registration_form_id は NULL 許容の TEXT 列として追加される', () => {
    const db = createDatabase();
    const column = db
      .prepare(`PRAGMA table_info(webinars)`)
      .all()
      .find((row) => (row as { name: string }).name === 'pre_registration_form_id') as {
        type: string;
        notnull: number;
      } | undefined;

    expect(column).toMatchObject({ type: 'TEXT', notnull: 0 });
  });

  test('pre_registration_form_id を指定しない既存形式の INSERT は通り、既存行は壊れない', () => {
    const db = createDatabase();
    db.prepare(
      `INSERT INTO webinars (id, title, slug, intro_text, intro_image_url, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'webinar-1',
      'テストウェビナー',
      'test-webinar',
      '既存の申し込み文言',
      'https://example.com/header.jpg',
      'created',
      'updated',
    );

    const row = db
      .prepare(
        `SELECT title, intro_text, intro_image_url, pre_registration_form_id
         FROM webinars WHERE id = ?`,
      )
      .get('webinar-1') as {
        title: string;
        intro_text: string | null;
        intro_image_url: string | null;
        pre_registration_form_id: string | null;
      };
    expect(row.title).toBe('テストウェビナー');
    expect(row.intro_text).toBe('既存の申し込み文言');
    expect(row.intro_image_url).toBe('https://example.com/header.jpg');
    expect(row.pre_registration_form_id).toBeNull();
  });
});
