import { describe, expect, it, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { recoverStalledBroadcasts, updateBroadcastStatus } from '../src/broadcasts.js';

class D1Stmt {
  constructor(
    private readonly sqlite: Database.Database,
    private readonly sql: string,
    private readonly params: unknown[] = [],
  ) {}

  bind(...params: unknown[]) {
    return new D1Stmt(this.sqlite, this.sql, params);
  }

  async first<T>() {
    return (this.sqlite.prepare(this.sql).get(...this.params) as T | undefined) ?? null;
  }

  async run() {
    const result = this.sqlite.prepare(this.sql).run(...this.params);
    return { success: true, meta: { changes: result.changes, last_row_id: result.lastInsertRowid } };
  }
}

function asD1(sqlite: Database.Database): D1Database {
  return { prepare: (sql: string) => new D1Stmt(sqlite, sql) } as unknown as D1Database;
}

const schemaPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'schema.sql');

/** DB は JST 壁時計 (オフセット無し) で時刻を保存する。 */
function jstStamp(minutesAgo: number): string {
  return new Date(Date.now() + 9 * 60 * 60_000 - minutesAgo * 60_000)
    .toISOString()
    .slice(0, -1);
}

interface StuckRow {
  id: string;
  scheduledAt?: string | null;
  lockedMinutesAgo?: number | null;
  batchOffset?: number;
  segmentConditions?: string | null;
  accountIds?: string | null;
  lineRequestId?: string | null;
  successCount?: number;
  targetType?: string;
}

describe('recoverStalledBroadcasts — inline 送信経路の停滞', () => {
  let sqlite: Database.Database;
  let db: D1Database;

  function insertSending(row: StuckRow) {
    sqlite
      .prepare(
        `INSERT INTO broadcasts
           (id, title, message_type, message_content, target_type, status,
            scheduled_at, batch_offset, batch_lock_at, segment_conditions,
            account_ids, line_request_id, success_count)
         VALUES (?, ?, 'text', 'hello', ?, 'sending', ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.id,
        row.targetType ?? 'all',
        row.scheduledAt ?? null,
        row.batchOffset ?? 0,
        row.lockedMinutesAgo == null ? null : jstStamp(row.lockedMinutesAgo),
        row.segmentConditions ?? null,
        row.accountIds ?? null,
        row.lineRequestId ?? null,
        row.successCount ?? 0,
      );
  }

  function read(id: string) {
    return sqlite
      .prepare(`SELECT status, batch_lock_at FROM broadcasts WHERE id = ?`)
      .get(id) as { status: string; batch_lock_at: string | null };
  }

  beforeEach(() => {
    sqlite = new Database(':memory:');
    sqlite.exec(readFileSync(schemaPath, 'utf8'));
    db = asD1(sqlite);
  });

  it('予約配信が inline で固着したら scheduled に戻して自動で送り直せるようにする', async () => {
    insertSending({ id: 'stuck-scheduled', scheduledAt: '2026-08-17T20:00:00.000+09:00', lockedMinutesAgo: 20 });

    await recoverStalledBroadcasts(db);

    expect(read('stuck-scheduled')).toEqual({ status: 'scheduled', batch_lock_at: null });
  });

  it('即時送信が固着したら draft に戻すだけで勝手に送り直さない', async () => {
    insertSending({ id: 'stuck-immediate', scheduledAt: null, lockedMinutesAgo: 20 });

    await recoverStalledBroadcasts(db);

    expect(read('stuck-immediate').status).toBe('draft');
  });

  it('送信を開始してまだ間もない row は巻き戻さない（送信中との二重送信を防ぐ）', async () => {
    insertSending({ id: 'in-flight', scheduledAt: '2026-08-17T20:00:00.000+09:00', lockedMinutesAgo: 3 });

    await recoverStalledBroadcasts(db);

    expect(read('in-flight').status).toBe('sending');
  });

  it('line_request_id が入っている row は送信済みなので巻き戻さない', async () => {
    insertSending({ id: 'already-sent', lockedMinutesAgo: 20, lineRequestId: 'req-1' });

    await recoverStalledBroadcasts(db);

    expect(read('already-sent').status).toBe('sending');
  });

  it('success_count > 0 の row は部分送信済みなので巻き戻さない', async () => {
    insertSending({ id: 'partial', lockedMinutesAgo: 20, successCount: 500 });

    await recoverStalledBroadcasts(db);

    expect(read('partial').status).toBe('sending');
  });

  it('batch_lock_at が無い row は経過時間を判定できないので触らない', async () => {
    insertSending({ id: 'no-stamp', lockedMinutesAgo: null });

    await recoverStalledBroadcasts(db);

    expect(read('no-stamp').status).toBe('sending');
  });

  it('segment / account_ids を持つ row はキュー経路の領分なので触らない', async () => {
    insertSending({ id: 'segmented', lockedMinutesAgo: 20, segmentConditions: '{"operator":"AND","rules":[]}' });
    insertSending({ id: 'dedup', lockedMinutesAgo: 20, accountIds: '["a"]' });

    await recoverStalledBroadcasts(db);

    expect(read('segmented').status).toBe('sending');
    expect(read('dedup').status).toBe('sending');
  });

  it('tag 配信は部分送信の判別ができないので触らない（再送で二重配信になるため）', async () => {
    insertSending({ id: 'tag-inline', targetType: 'tag', lockedMinutesAgo: 20 });

    await recoverStalledBroadcasts(db);

    expect(read('tag-inline').status).toBe('sending');
  });

  it('batch_offset = -1 (キューのロック) は既存の復旧系統に任せる', async () => {
    insertSending({ id: 'queue-locked', lockedMinutesAgo: 20, batchOffset: -1 });

    await recoverStalledBroadcasts(db);

    expect(read('queue-locked').status).toBe('sending');
  });
});

describe('updateBroadcastStatus', () => {
  let sqlite: Database.Database;
  let db: D1Database;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    sqlite.exec(readFileSync(schemaPath, 'utf8'));
    db = asD1(sqlite);
    sqlite
      .prepare(
        `INSERT INTO broadcasts (id, title, message_type, message_content, target_type, status)
         VALUES ('b1', 'b1', 'text', 'hello', 'all', 'draft')`,
      )
      .run();
  });

  it("status='sending' に遷移したら batch_lock_at を刻む（復旧判定の起点になる）", async () => {
    await updateBroadcastStatus(db, 'b1', 'sending');

    const row = sqlite
      .prepare(`SELECT status, batch_lock_at FROM broadcasts WHERE id = 'b1'`)
      .get() as { status: string; batch_lock_at: string | null };
    expect(row.status).toBe('sending');
    expect(row.batch_lock_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}$/);
  });

  it("status='sent' で batch_lock_at をクリアする", async () => {
    await updateBroadcastStatus(db, 'b1', 'sending');
    await updateBroadcastStatus(db, 'b1', 'sent', { totalCount: 3, successCount: 3 });

    const row = sqlite
      .prepare(`SELECT status, batch_lock_at FROM broadcasts WHERE id = 'b1'`)
      .get() as { status: string; batch_lock_at: string | null };
    expect(row.status).toBe('sent');
    expect(row.batch_lock_at).toBeNull();
  });
});
