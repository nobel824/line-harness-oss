import { describe, expect, it, test, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBroadcast, getBroadcastById, updateBroadcast } from '../src/broadcasts.js';

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
  return {
    prepare: (sql: string) => new D1Stmt(sqlite, sql),
  } as unknown as D1Database;
}

const schemaPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'schema.sql');

// schema.sql is the historical base schema; these production migrations
// add the columns createBroadcast writes atomically today.
function loadSchema(sqlite: Database.Database) {
  sqlite.exec(readFileSync(schemaPath, 'utf8'));
  sqlite.exec('ALTER TABLE broadcasts ADD COLUMN line_account_id TEXT');
  sqlite.exec('ALTER TABLE broadcasts ADD COLUMN alt_text TEXT');
}

const initialConditions = JSON.stringify({
  operator: 'AND',
  rules: [{ type: 'tag_not_exists', value: 'exclude-tag' }],
});

describe('updateBroadcast segment_conditions', () => {
  let sqlite: Database.Database;
  let db: D1Database;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    loadSchema(sqlite);
    sqlite.prepare(`
      INSERT INTO broadcasts
        (id, title, message_type, message_content, target_type, status, segment_conditions)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('broadcast-1', 'Test broadcast', 'text', 'Hello', 'all', 'draft', initialConditions);
    db = asD1(sqlite);
  });

  it('persists segment_conditions when supplied', async () => {
    const conditions = JSON.stringify({
      operator: 'OR',
      rules: [{ type: 'tag_exists', value: 'vip-tag' }],
    });

    const updated = await updateBroadcast(db, 'broadcast-1', {
      segment_conditions: conditions,
    });

    expect(updated?.segment_conditions).toBe(conditions);
    expect((await getBroadcastById(db, 'broadcast-1'))?.segment_conditions).toBe(conditions);
  });

  it('keeps the existing value when segment_conditions is omitted', async () => {
    const updated = await updateBroadcast(db, 'broadcast-1', { title: 'Renamed' });

    expect(updated?.title).toBe('Renamed');
    expect(updated?.segment_conditions).toBe(initialConditions);
  });
});

describe('createBroadcast', () => {
  let sqlite: Database.Database;
  let db: D1Database;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    loadSchema(sqlite);
    db = asD1(sqlite);
  });

  test('persists a caller-supplied stable id and account fields atomically', async () => {
    const id = '11111111-2222-4333-8444-555555555555';
    const result = await createBroadcast(db, {
      id,
      title: 'Personalized notice',
      messageType: 'text',
      messageContent: '{{name}}さんへ',
      targetType: 'all',
      scheduledAt: '2026-08-12T09:00:00.000+09:00',
      lineAccountId: 'account-1',
      altText: '通知',
    });

    expect(result.id).toBe(id);
    expect(result.status).toBe('scheduled');
    expect(result.line_account_id).toBe('account-1');
    expect(result.alt_text).toBe('通知');
  });

  test('the same stable id cannot create a second row', async () => {
    const input = {
      id: '11111111-2222-4333-8444-555555555555',
      title: 'Notice',
      messageType: 'text' as const,
      messageContent: 'hello',
      targetType: 'all' as const,
    };

    await createBroadcast(db, input);
    await expect(createBroadcast(db, input)).rejects.toThrow(/UNIQUE constraint failed/);
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM broadcasts').get()).toEqual({ count: 1 });
  });
});
