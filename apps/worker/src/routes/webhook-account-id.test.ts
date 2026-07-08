import { describe, test, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LineClient } from '@line-crm/line-sdk';
import { handleEvent } from './webhook.js';

// 実 SQLite を D1Database 風に包む最小アダプタ。
// messages_log への INSERT 列 (line_account_id) が実際に書かれるかは
// SQL を実行しないと検証できないため stub では不十分。
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
const SCHEMA_PATH = join(__dirname, '../../../../packages/db/schema.sql');

// auto_reply / automation を一切登録しないので、テキスト受信パスは
// 受信ログ INSERT → upsertChatOnMessage → fireEvent(no-op) のみで、
// LINE API を呼ばない。よって LineClient は使われない。
const noopLineClient = {} as unknown as LineClient;

function loadDb() {
  const sqlite = new Database(':memory:');
  sqlite.exec(readFileSync(SCHEMA_PATH, 'utf8'));
  // friends.line_account_id は migration で足される列 (schema.sql 本体には無い)。
  sqlite.exec(`ALTER TABLE friends ADD COLUMN line_account_id TEXT`);
  return sqlite;
}

function seedFriend(sqlite, friendId, lineUserId) {
  sqlite
    .prepare(`INSERT INTO friends (id, line_user_id, display_name, is_following) VALUES (?, ?, ?, 1)`)
    .run(friendId, lineUserId, friendId);
}

describe('webhook は messages_log に line_account_id をスタンプする', () => {
  let sqlite;
  let db;

  beforeEach(() => {
    sqlite = loadDb();
    db = asD1(sqlite);
  });

  test('テキスト受信ログにハンドラの lineAccountId が入る', async () => {
    seedFriend(sqlite, 'f1', 'U_alice');

    await handleEvent(
      db,
      noopLineClient,
      {
        type: 'message',
        source: { type: 'user', userId: 'U_alice' },
        message: { type: 'text', text: 'こんにちは' },
        replyToken: 'rt-1',
      },
      'access-token',
      'acc-123', // lineAccountId
    );

    const row = sqlite
      .prepare(`SELECT direction, source, line_account_id FROM messages_log WHERE friend_id = 'f1'`)
      .get();
    expect(row).toBeTruthy();
    expect(row.direction).toBe('incoming');
    expect(row.line_account_id).toBe('acc-123');
  });

  test('lineAccountId が null なら null で記録される (単一アカ / env 経路)', async () => {
    seedFriend(sqlite, 'f2', 'U_bob');

    await handleEvent(
      db,
      noopLineClient,
      {
        type: 'message',
        source: { type: 'user', userId: 'U_bob' },
        message: { type: 'text', text: 'hello' },
        replyToken: 'rt-2',
      },
      'access-token',
      null,
    );

    const row = sqlite
      .prepare(`SELECT line_account_id FROM messages_log WHERE friend_id = 'f2'`)
      .get();
    expect(row.line_account_id).toBeNull();
  });
});
