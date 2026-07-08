import { describe, test, expect, beforeEach } from 'vitest';
import { Hono } from 'hono';
import Database from 'better-sqlite3';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { webhook } from './webhook.js';

// 実 SQLite を D1Database 風に包む最小アダプタ。
// dedup は取り込みループ (webhook.ts) にあり、handleEvent の外側なので、
// 実際のルートを叩いて end-to-end で「2回目の再送が skip される」ことを検証する。
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

// sql が failSubstr を含む run() を「1回だけ」throw させるアダプタ。
// handleEvent の途中失敗 → release → 再送で再処理（AC2）を route レベルで検証するため。
function asD1FailOnce(db: Database.Database, failSubstr: string): D1Database {
  let armed = true;
  class FailingStmt extends D1Stmt {
    bind(...params: unknown[]) {
      const s = new FailingStmt(this.db, this.sql, params);
      return s;
    }
    async run() {
      if (armed && this.sql.includes(failSubstr)) {
        armed = false;
        throw new Error('injected D1 failure');
      }
      return super.run();
    }
  }
  return { prepare: (sql: string) => new FailingStmt(db, sql) } as unknown as D1Database;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = join(__dirname, '../../../../packages/db/schema.sql');
const SECRET = 'test-secret';

function loadDb() {
  const sqlite = new Database(':memory:');
  sqlite.exec(readFileSync(SCHEMA_PATH, 'utf8'));
  sqlite.exec(`ALTER TABLE friends ADD COLUMN line_account_id TEXT`);
  return sqlite;
}

// LINE 署名 = HMAC-SHA256(secret, body) を base64。verifySignature と同一アルゴリズム。
function sign(body: string): string {
  return createHmac('sha256', SECRET).update(body).digest('base64');
}

function textEvent(webhookEventId: string, userId: string) {
  return {
    type: 'message',
    webhookEventId,
    deliveryContext: { isRedelivery: false },
    source: { type: 'user', userId },
    message: { type: 'text', id: 'm1', text: 'こんにちは' },
    replyToken: 'rt-1',
    timestamp: 1,
    mode: 'active',
  };
}

async function postWebhook(app: Hono, sqlite: Database.Database, body: string, d1?: D1Database) {
  const pending: Promise<unknown>[] = [];
  const env = {
    DB: d1 ?? asD1(sqlite),
    LINE_CHANNEL_SECRET: SECRET,
    LINE_CHANNEL_ACCESS_TOKEN: 'tok',
  } as unknown as Record<string, unknown>;
  const ctx = {
    waitUntil: (p: Promise<unknown>) => pending.push(p),
    passThroughOnException: () => {},
    props: {},
  } as unknown as ExecutionContext;

  const res = await app.fetch(
    new Request('http://localhost/webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Line-Signature': sign(body) },
      body,
    }),
    env,
    ctx,
  );
  // 取り込みは waitUntil で非同期に走るので明示的に待つ。
  await Promise.all(pending);
  return res;
}

describe('webhook 冪等性: 同一 webhookEventId の再送を二重処理しない', () => {
  let app: Hono;
  let sqlite: Database.Database;

  beforeEach(() => {
    sqlite = loadDb();
    sqlite
      .prepare(`INSERT INTO friends (id, line_user_id, display_name, is_following) VALUES (?, ?, ?, 1)`)
      .run('f-dup', 'U_dup', 'dup');
    app = new Hono();
    app.route('/', webhook);
  });

  function incomingCount(): number {
    return (
      sqlite
        .prepare(`SELECT COUNT(*) AS c FROM messages_log WHERE friend_id = 'f-dup' AND direction = 'incoming'`)
        .get() as { c: number }
    ).c;
  }

  test('同じイベントを2回 POST しても messages_log は1件だけ', async () => {
    const body = JSON.stringify({ destination: 'x', events: [textEvent('evt-dup', 'U_dup')] });

    const r1 = await postWebhook(app, sqlite, body);
    expect(r1.status).toBe(200);
    expect(incomingCount()).toBe(1);

    // 同一 webhookEventId で再送
    const r2 = await postWebhook(app, sqlite, body);
    expect(r2.status).toBe(200);
    expect(incomingCount()).toBe(1); // 2回目は skip され増えない

    // dedup 記録が残っている
    const dedup = sqlite.prepare(`SELECT COUNT(*) AS c FROM webhook_event_dedup`).get() as { c: number };
    expect(dedup.c).toBe(1);
  });

  test('異なる webhookEventId は別イベントとして両方処理される', async () => {
    await postWebhook(app, sqlite, JSON.stringify({ destination: 'x', events: [textEvent('evt-a', 'U_dup')] }));
    await postWebhook(app, sqlite, JSON.stringify({ destination: 'x', events: [textEvent('evt-b', 'U_dup')] }));
    expect(incomingCount()).toBe(2);
  });

  test('AC2: handleEvent が throw したら claim を release し、再送で再処理される', async () => {
    const body = JSON.stringify({ destination: 'x', events: [textEvent('evt-fail', 'U_dup')] });

    // 受信ログ INSERT を1回だけ失敗させる → handleEvent が throw。
    const failing = asD1FailOnce(sqlite, `'incoming'`);
    await postWebhook(app, sqlite, body, failing);
    // 処理は失敗したので受信ログは無く、claim も release されている。
    expect(incomingCount()).toBe(0);
    const dedupAfterFail = sqlite.prepare(`SELECT COUNT(*) AS c FROM webhook_event_dedup`).get() as { c: number };
    expect(dedupAfterFail.c).toBe(0);

    // LINE 再送（同一 webhookEventId）→ 今度は成功して処理される（取りこぼさない）。
    await postWebhook(app, sqlite, body);
    expect(incomingCount()).toBe(1);
  });

  test('AC3: webhookEventId が無いイベントは dedup せず通常処理する', async () => {
    const evt = textEvent('placeholder', 'U_dup') as Record<string, unknown>;
    delete evt.webhookEventId;
    const body = JSON.stringify({ destination: 'x', events: [evt] });

    await postWebhook(app, sqlite, body);
    expect(incomingCount()).toBe(1);
    // dedup は行われない（記録が残らない）。
    const dedup = sqlite.prepare(`SELECT COUNT(*) AS c FROM webhook_event_dedup`).get() as { c: number };
    expect(dedup.c).toBe(0);
  });
});
