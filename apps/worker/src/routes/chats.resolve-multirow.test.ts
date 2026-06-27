import { describe, test, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { updateChat } from '@line-crm/db';
import { resolveOrCreateChat } from './chats.js';
import { countUnanswered } from '../services/unanswered-inbox.js';

// ---------------------------------------------------------------------------
// 実 SQLite を D1Database 風に包む最小アダプタ。
// バグ (resolve が「最古行」、カウントが「最新行」を読む非対称) は SQL の行選択に
// 起因するため、SQL を本当に実行しないと再現できない (stubDB では捕まらない)。
// ---------------------------------------------------------------------------
class D1Stmt {
  constructor(db, sql, params) {
    this.db = db;
    this.sql = sql;
    this.params = params ?? [];
  }
  bind(...params) {
    return new D1Stmt(this.db, this.sql, params);
  }
  async first() {
    const row = this.db.prepare(this.sql).get(...this.params);
    return row ?? null;
  }
  async all() {
    const results = this.db.prepare(this.sql).all(...this.params);
    return { results, success: true, meta: {} };
  }
  async run() {
    const info = this.db.prepare(this.sql).run(...this.params);
    return { success: true, meta: { changes: info.changes, last_row_id: info.lastInsertRowid } };
  }
}

function asD1(db) {
  return {
    prepare(sql) {
      return new D1Stmt(db, sql);
    },
  };
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = join(__dirname, '../../../../packages/db/schema.sql');

function loadDb() {
  const sqlite = new Database(':memory:');
  sqlite.exec(readFileSync(SCHEMA_PATH, 'utf8'));
  // friends.line_account_id は migration 008 で追加される列 (schema.sql 本体には無い)。
  // CANDIDATES_SQL が f.line_account_id を参照するため最小限ここで足す。
  sqlite.exec(`ALTER TABLE friends ADD COLUMN line_account_id TEXT`);
  return sqlite;
}

/** friend + incoming 1 件を入れて「未対応候補」状態を作る (手動返信なし)。 */
function seedUnansweredFriend(sqlite, friendId) {
  sqlite
    .prepare(
      `INSERT INTO friends (id, line_user_id, display_name, is_following) VALUES (?, ?, ?, 1)`,
    )
    .run(friendId, `U_${friendId}`, friendId);
  sqlite
    .prepare(
      `INSERT INTO messages_log (id, friend_id, direction, message_type, content, created_at)
       VALUES (?, ?, 'incoming', 'text', 'こんにちは', ?)`,
    )
    .run(`m_${friendId}`, friendId, '2024-01-01T10:00:00.000');
}

function insertChat(sqlite, id, friendId, status, createdAt) {
  sqlite
    .prepare(
      `INSERT INTO chats (id, friend_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
    )
    .run(id, friendId, status, createdAt, createdAt);
}

describe('resolve は friend の複数 chat 行があっても未対応カウントから外す', () => {
  let sqlite;
  let db;

  beforeEach(() => {
    sqlite = loadDb();
    db = asD1(sqlite);
  });

  test('chat 行が 1 つ: 解決済にすると未対応から外れる (回帰防止)', async () => {
    seedUnansweredFriend(sqlite, 'f_single');
    insertChat(sqlite, 'c_single', 'f_single', 'unread', '2024-01-01T09:00:00.000');

    expect((await countUnanswered(db)).total).toBe(1);

    // 管理画面の「解決済にする」= PUT /api/chats/:id (id は friend_id) の中身
    const resolved = await resolveOrCreateChat(db, 'f_single');
    await updateChat(db, resolved.id, { status: 'resolved' });

    expect((await countUnanswered(db)).total).toBe(0);
  });

  test('chat 行が複数: 解決済にすると最新行が resolved になり未対応から外れる', async () => {
    seedUnansweredFriend(sqlite, 'f_multi');
    // 古い行と新しい行。相手から来た incoming で最新行 (B) が unread のまま未対応に出る。
    insertChat(sqlite, 'c_old', 'f_multi', 'unread', '2024-01-01T09:00:00.000');
    insertChat(sqlite, 'c_new', 'f_multi', 'unread', '2024-06-01T09:00:00.000');

    expect((await countUnanswered(db)).total).toBe(1);

    // 「解決済にする」を押す。resolve と count が同じ行 (最新) を指していないと外れない。
    const resolved = await resolveOrCreateChat(db, 'f_multi');
    await updateChat(db, resolved.id, { status: 'resolved' });

    // 最新行 c_new が resolved になっているべき (count は最新行を読む)。
    const newRow = sqlite.prepare(`SELECT status FROM chats WHERE id = 'c_new'`).get();
    expect(newRow.status).toBe('resolved');
    expect((await countUnanswered(db)).total).toBe(0);
  });
});
