import { describe, test, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  claimWebhookEvent,
  releaseWebhookEvent,
  cleanupWebhookEventDedup,
} from '../src/webhook-dedup.js';

// 実 SQLite を D1Database 風に包む最小アダプタ。
// INSERT OR IGNORE の changes 判定 / DELETE の件数は SQL を実行しないと検証できない。
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

function rowCount(sqlite: Database.Database): number {
  return (sqlite.prepare('SELECT COUNT(*) AS c FROM webhook_event_dedup').get() as { c: number }).c;
}

describe('webhook dedup helpers', () => {
  let sqlite: Database.Database;
  let db: D1Database;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    sqlite.exec(readFileSync(SCHEMA_PATH, 'utf8'));
    db = asD1(sqlite);
  });

  test('claim: 初回は true、同一 event_id の2回目は false', async () => {
    expect(await claimWebhookEvent(db, 'evt-1')).toBe(true);
    expect(await claimWebhookEvent(db, 'evt-1')).toBe(false);
    expect(rowCount(sqlite)).toBe(1);
  });

  test('異なる event_id はそれぞれ claim できる', async () => {
    expect(await claimWebhookEvent(db, 'evt-1')).toBe(true);
    expect(await claimWebhookEvent(db, 'evt-2')).toBe(true);
    expect(rowCount(sqlite)).toBe(2);
  });

  test('release 後は同一 event_id を再度 claim できる（失敗イベントの再処理）', async () => {
    expect(await claimWebhookEvent(db, 'evt-1')).toBe(true);
    await releaseWebhookEvent(db, 'evt-1');
    expect(rowCount(sqlite)).toBe(0);
    expect(await claimWebhookEvent(db, 'evt-1')).toBe(true);
  });

  test('cleanup: cutoff より古い行だけ削除し、新しい行は残す', async () => {
    // 古い行 (25h 前相当) と新しい行 (現在) を直接投入。
    sqlite
      .prepare(`INSERT INTO webhook_event_dedup (event_id, created_at) VALUES (?, ?)`)
      .run('old', '2026-07-07T00:00:00.000');
    sqlite
      .prepare(`INSERT INTO webhook_event_dedup (event_id, created_at) VALUES (?, ?)`)
      .run('new', '2026-07-08T23:59:59.000');

    const purged = await cleanupWebhookEventDedup(db, '2026-07-08T00:00:00.000');
    expect(purged).toBe(1);
    expect(rowCount(sqlite)).toBe(1);
    const remaining = sqlite.prepare('SELECT event_id FROM webhook_event_dedup').get() as { event_id: string };
    expect(remaining.event_id).toBe('new');
  });
});
