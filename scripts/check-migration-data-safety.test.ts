import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { formatFindings, scanDataSafety } from './check-migration-data-safety';

describe('scanDataSafety — 破壊的なデータ操作を検知する', () => {
  it('flags DELETE FROM', () => {
    const findings = scanDataSafety(`DELETE FROM chats WHERE id = 1;`);
    expect(findings.map((f) => f.rule)).toEqual(['DELETE FROM']);
    expect(findings[0].line).toBe(1);
  });

  it('flags DROP TABLE / DROP INDEX', () => {
    expect(scanDataSafety(`DROP TABLE foo;`).map((f) => f.rule)).toEqual(['DROP']);
    expect(scanDataSafety(`DROP INDEX IF EXISTS idx_foo;`).map((f) => f.rule)).toEqual(['DROP']);
  });

  it('flags TRUNCATE', () => {
    expect(scanDataSafety(`TRUNCATE TABLE foo;`).map((f) => f.rule)).toContain('TRUNCATE');
  });

  it('flags UPDATE ... SET (mass data rewrite)', () => {
    const findings = scanDataSafety(`UPDATE chats SET status = 'open';`);
    expect(findings.map((f) => f.rule)).toEqual(['UPDATE']);
  });

  // SQLite は `UPDATE OR IGNORE|REPLACE|ROLLBACK|ABORT|FAIL <table> SET` を許す。
  // `UPDATE <table> SET` だけを見る実装はこれを素通りさせ、本番データの書き換えが
  // 無人でデプロイされる。
  it.each(['IGNORE', 'REPLACE', 'ROLLBACK', 'ABORT', 'FAIL'])(
    'flags UPDATE OR %s ... SET (SQLite の正規構文・見逃すと致命)',
    (variant) => {
      const sql = `UPDATE OR ${variant} chats SET status = 'x' WHERE id = 1;`;
      expect(scanDataSafety(sql).map((f) => f.rule)).toEqual(['UPDATE']);
    },
  );

  it('flags a qualified table name (UPDATE main.chats SET)', () => {
    expect(scanDataSafety(`UPDATE main.chats SET a = 1;`).map((f) => f.rule)).toEqual(['UPDATE']);
  });

  it('flags REPLACE INTO (delete + insert disguised as an insert)', () => {
    expect(scanDataSafety(`REPLACE INTO chats (id) VALUES ('a');`).map((f) => f.rule)).toEqual([
      'REPLACE INTO',
    ]);
  });

  it('flags INSERT OR REPLACE INTO', () => {
    expect(
      scanDataSafety(`INSERT OR REPLACE INTO chats (id) VALUES ('a');`).map((f) => f.rule),
    ).toEqual(['REPLACE INTO']);
  });

  it('reports the correct 1-based line number', () => {
    const sql = ['CREATE TABLE a (id TEXT);', '', 'DELETE FROM a;'].join('\n');
    expect(scanDataSafety(sql)[0].line).toBe(3);
  });
});

describe('scanDataSafety — 安全な migration を誤検知しない', () => {
  it('passes a purely additive migration', () => {
    const sql = `
      ALTER TABLE tracked_links ADD COLUMN short_code TEXT;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_x ON tracked_links (short_code) WHERE short_code IS NOT NULL;
    `;
    expect(scanDataSafety(sql)).toEqual([]);
  });

  it('does not flag ON DELETE CASCADE (foreign-key clause, not a deletion)', () => {
    const sql = `CREATE TABLE b (
      id TEXT PRIMARY KEY,
      a_id TEXT REFERENCES a(id) ON DELETE CASCADE,
      c_id TEXT REFERENCES c(id) ON DELETE SET NULL
    );`;
    expect(scanDataSafety(sql)).toEqual([]);
  });

  it('does not flag INSERT ... ON CONFLICT DO UPDATE SET (upsert, not a mass rewrite)', () => {
    const sql = `INSERT INTO a (id, n) VALUES ('x', 1)
                 ON CONFLICT (id) DO UPDATE SET n = excluded.n;`;
    expect(scanDataSafety(sql)).toEqual([]);
  });

  it('ignores destructive keywords inside -- comments', () => {
    const sql = `-- DELETE FROM chats を過去に行った経緯がある。DROP TABLE も検討した。
      CREATE TABLE ok (id TEXT);`;
    expect(scanDataSafety(sql)).toEqual([]);
  });

  it('ignores destructive keywords inside /* */ block comments', () => {
    const sql = `/* 経緯:
       UPDATE chats SET status = 'x'; を検討したが DELETE FROM chats は避けた。
    */
    CREATE TABLE ok (id TEXT);`;
    expect(scanDataSafety(sql)).toEqual([]);
  });

  it('keeps line numbers correct after a multi-line block comment', () => {
    const sql = ['/* a', 'b', '*/', 'DELETE FROM x;'].join('\n');
    expect(scanDataSafety(sql)[0].line).toBe(4);
  });

  it('does not flag identifiers that merely start with a keyword', () => {
    const sql = `CREATE TABLE updates (id TEXT, updated_at TEXT, deleted_at TEXT);`;
    expect(scanDataSafety(sql)).toEqual([]);
  });

  // トリガー定義は書き込みではない。updated_at の自動更新はごくありふれた安全な
  // migration で、これを毎回止めると「危険なものだけ人間に回す」設計が形骸化する。
  it('does not flag CREATE TRIGGER ... AFTER UPDATE ON (trigger definition, not a write)', () => {
    const sql = `CREATE TRIGGER touch_updated_at AFTER UPDATE ON chats
                 BEGIN UPDATE chats SET updated_at = datetime('now') WHERE id = NEW.id; END;`;
    // 本体の UPDATE ... SET は拾うが、"AFTER UPDATE ON" 自体は拾わない
    expect(scanDataSafety(sql).map((f) => f.excerpt)).toEqual(['UPDATE chats']);
  });

  it('does not flag BEFORE UPDATE OF <col> ON <table>', () => {
    const sql = `CREATE TRIGGER t BEFORE UPDATE OF status ON chats BEGIN SELECT 1; END;`;
    expect(scanDataSafety(sql)).toEqual([]);
  });

  it('does not flag INSTEAD OF UPDATE ON <view>', () => {
    const sql = `CREATE TRIGGER t INSTEAD OF UPDATE ON v BEGIN SELECT 1; END;`;
    expect(scanDataSafety(sql)).toEqual([]);
  });

  it('still flags real SQL that follows a comment on the same line', () => {
    const sql = `DELETE FROM a; -- DROP TABLE b;`;
    expect(scanDataSafety(sql).map((f) => f.rule)).toEqual(['DELETE FROM']);
  });
});

describe('実物の migration に対する挙動', () => {
  it('flags 048_chats_friend_unique.sql — 本番の chats 行を DELETE する実例', () => {
    const sql = readFileSync('packages/db/migrations/048_chats_friend_unique.sql', 'utf8');
    const rules = scanDataSafety(sql).map((f) => f.rule);
    expect(rules).toContain('DELETE FROM');
    expect(rules).toContain('UPDATE');
    expect(rules).toContain('DROP');
  });

  // 本体 upstream の 049。まだフォークに存在しない（同期で入ってくる）ため、
  // ファイル読み込みではなく実物の SQL を写して固定する。
  it('passes 049_tracked_links_short_code.sql — 本体の新規 migration・純粋な追加のみ', () => {
    const sql = `-- 049: Short codes for tracked links
ALTER TABLE tracked_links ADD COLUMN short_code TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_tracked_links_short_code
  ON tracked_links (short_code) WHERE short_code IS NOT NULL;`;
    expect(scanDataSafety(sql)).toEqual([]);
  });

  it('passes 049_webhook_event_dedup.sql — フォーク独自・純粋な追加のみ', () => {
    const sql = readFileSync('packages/db/migrations/049_webhook_event_dedup.sql', 'utf8');
    expect(scanDataSafety(sql)).toEqual([]);
  });
});

describe('formatFindings', () => {
  it('renders file, line and rule for the PR body', () => {
    const out = formatFindings([
      { file: 'packages/db/migrations/048_x.sql', rule: 'DELETE FROM', line: 42, excerpt: 'DELETE FROM chats' },
    ]);
    expect(out).toContain('048_x.sql');
    expect(out).toContain('42');
    expect(out).toContain('DELETE FROM chats');
  });

  it('returns an empty string when there are no findings', () => {
    expect(formatFindings([])).toBe('');
  });
});
