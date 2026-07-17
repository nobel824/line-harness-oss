#!/usr/bin/env tsx
/**
 * Migration DATA-safety scan — the gate that keeps unattended upstream syncs
 * from applying irreversible production data operations.
 *
 * This is deliberately NOT part of `check-migrations.ts`. That script enforces
 * the additive-only SCHEMA policy (DROP TABLE, DROP COLUMN, ...). It does not
 * look at DATA, so it passes `048_chats_friend_unique.sql` — a migration that
 * deletes duplicate rows from production `chats` — because `CREATE UNIQUE INDEX`
 * is an allowed construct. Auto-sync needs the complementary check.
 *
 * Kept as a separate file (rather than extending check-migrations.ts) because
 * that file is owned by upstream Shudesu/line-harness-oss: editing it would
 * manufacture a merge conflict on every future sync, which is exactly what this
 * automation exists to avoid.
 *
 * D1 migrations cannot be rolled back (see packages/update-engine/src/phases/
 * rollback.ts), so a finding here means "a human must look", not "this is wrong".
 *
 * CLI:
 *   tsx scripts/check-migration-data-safety.ts <file.sql> [...]
 *   → exit 0 and "OK" when clean; exit 1 and a report when findings exist.
 */

import { readFileSync } from 'node:fs';
import { argv, exit, stderr, stdout } from 'node:process';
import { fileURLToPath } from 'node:url';

export interface Finding {
  /** Which rule matched — used verbatim in the PR body. */
  rule: string;
  /** 1-based line number in the original file. */
  line: number;
  /** The matched SQL text, for context. */
  excerpt: string;
}

export interface FileFinding extends Finding {
  file: string;
}

interface Rule {
  rule: string;
  pattern: RegExp;
}

const RULES: Rule[] = [
  {
    rule: 'DELETE FROM',
    // `ON DELETE CASCADE` / `ON DELETE SET NULL` are FK clauses, not deletions;
    // requiring FROM excludes them.
    pattern: /\bDELETE\s+FROM\b/gi,
  },
  {
    rule: 'DROP',
    pattern: /\bDROP\s+(?:TABLE|INDEX|VIEW|TRIGGER|COLUMN)\b/gi,
  },
  {
    rule: 'TRUNCATE',
    pattern: /\bTRUNCATE\b/gi,
  },
  {
    rule: 'UPDATE ... SET',
    // A mass rewrite of existing rows. The negative lookahead lets
    // `INSERT ... ON CONFLICT DO UPDATE SET` (an upsert) through: there the
    // token right after UPDATE is SET itself, with no table name between them.
    pattern: /\bUPDATE\s+(?!SET\b)\S+\s+SET\b/gi,
  },
];

/**
 * Blank out `--` line comments while preserving every character position, so
 * match indices still map onto the original text for line numbering.
 */
function blankLineComments(sql: string): string {
  return sql
    .split('\n')
    .map((line) => {
      const idx = line.indexOf('--');
      return idx === -1 ? line : line.slice(0, idx) + ' '.repeat(line.length - idx);
    })
    .join('\n');
}

function lineAt(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) {
    if (text[i] === '\n') line++;
  }
  return line;
}

/** Scan one migration's SQL. Returns findings ordered by position in the file. */
export function scanDataSafety(sql: string): Finding[] {
  const stripped = blankLineComments(sql);
  const found: (Finding & { index: number })[] = [];

  for (const { rule, pattern } of RULES) {
    // Fresh regex per scan — /g regexes carry lastIndex between calls.
    const re = new RegExp(pattern.source, pattern.flags);
    let m: RegExpExecArray | null;
    while ((m = re.exec(stripped)) !== null) {
      found.push({
        rule,
        line: lineAt(stripped, m.index),
        excerpt: m[0].replace(/\s+/g, ' ').trim(),
        index: m.index,
      });
    }
  }

  return found
    .sort((a, b) => a.index - b.index)
    .map(({ rule, line, excerpt }) => ({ rule, line, excerpt }));
}

export function scanFile(file: string): FileFinding[] {
  const sql = readFileSync(file, 'utf8');
  return scanDataSafety(sql).map((f) => ({ ...f, file }));
}

/** Render findings as Markdown for a PR body. Empty string when clean. */
export function formatFindings(findings: FileFinding[]): string {
  if (findings.length === 0) return '';
  const lines = ['| migration | line | operation | SQL |', '| --- | --- | --- | --- |'];
  for (const f of findings) {
    lines.push(`| \`${f.file}\` | ${f.line} | **${f.rule}** | \`${f.excerpt}\` |`);
  }
  return lines.join('\n');
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

function main(files: string[]): void {
  if (files.length === 0) {
    stdout.write('OK — no new migrations to scan.\n');
    return;
  }

  const findings = files.flatMap((f) => scanFile(f));

  if (findings.length > 0) {
    stdout.write(formatFindings(findings) + '\n');
    stderr.write(
      `\n${findings.length} destructive data operation(s) found in ${files.length} migration(s). ` +
        `D1 migrations cannot be rolled back — a human must review before this reaches production.\n`,
    );
    exit(1);
  }

  stdout.write(`OK — ${files.length} migration(s) contain no destructive data operations.\n`);
}

const isCliEntry = (() => {
  if (!argv[1]) return false;
  try {
    return fileURLToPath(import.meta.url) === argv[1];
  } catch {
    return false;
  }
})();

if (isCliEntry) {
  try {
    main(argv.slice(2));
  } catch (err) {
    stderr.write(`check-migration-data-safety: ${(err as Error).message}\n`);
    exit(1);
  }
}
