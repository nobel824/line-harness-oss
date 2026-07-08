import { describe, test, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getFriendCount } from '../src/friends.js';

// 実 SQLite を D1Database 風に包む最小アダプタ。
// is_following フィルタの有無は SQL を実行しないと検証できないため stub では不十分。
class D1Stmt {
  db: Database.Database;
  sql: string;
  params: unknown[];
  constructor(db: Database.Database, sql: string, params?: unknown[]) {
    this.db = db;
    this.sql = sql;
    this.params = params ?? [];
  }
  bind(...params: unknown[]) {
    return new D1Stmt(this.db, this.sql, params);
  }
  async first() {
    return this.db.prepare(this.sql).get(...this.params) ?? null;
  }
  async all() {
    return { results: this.db.prepare(this.sql).all(...this.params), success: true, meta: {} };
  }
  async run() {
    const info = this.db.prepare(this.sql).run(...this.params);
    return { success: true, meta: { changes: info.changes, last_row_id: info.lastInsertRowid } };
  }
}
function asD1(db: Database.Database): D1Database {
  return { prepare: (sql: string) => new D1Stmt(db, sql) } as unknown as D1Database;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = join(__dirname, '..', 'schema.sql');

function seedFriend(sqlite: Database.Database, id: string, isFollowing: number) {
  sqlite
    .prepare(`INSERT INTO friends (id, line_user_id, display_name, is_following) VALUES (?, ?, ?, ?)`)
    .run(id, `U_${id}`, id, isFollowing);
}

describe('getFriendCount は is_following = 1 のみ数える', () => {
  let sqlite: Database.Database;
  let db: D1Database;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    sqlite.exec(readFileSync(SCHEMA_PATH, 'utf8'));
    db = asD1(sqlite);
  });

  test('ブロック済み (is_following = 0) を除外する', async () => {
    seedFriend(sqlite, 'f1', 1);
    seedFriend(sqlite, 'f2', 1);
    seedFriend(sqlite, 'f3', 0); // ブロック済み → 数えない
    expect(await getFriendCount(db)).toBe(2);
  });

  test('全員フォロー中なら全件', async () => {
    seedFriend(sqlite, 'f1', 1);
    seedFriend(sqlite, 'f2', 1);
    expect(await getFriendCount(db)).toBe(2);
  });

  test('友だち 0 件なら 0', async () => {
    expect(await getFriendCount(db)).toBe(0);
  });
});
