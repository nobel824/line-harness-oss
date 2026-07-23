import { describe, expect, it } from 'vitest';
import { buildSegmentQuery, toSegmentCountSql } from './segment-query.js';

describe('buildSegmentQuery', () => {
  it('always restricts results to following friends', () => {
    const { sql } = buildSegmentQuery({
      operator: 'AND',
      rules: [{ type: 'tag_exists', value: 'tag-1' }],
    });

    expect(sql).toContain('WHERE f.is_following = 1');
    expect(sql).toContain('EXISTS (SELECT 1 FROM friend_tags');
  });

  it('keeps the following-friend restriction when clauses are empty', () => {
    const { sql, bindings } = buildSegmentQuery({ operator: 'AND', rules: [] });

    expect(sql).toBe('SELECT f.id, f.line_user_id FROM friends f WHERE f.is_following = 1');
    expect(bindings).toEqual([]);
  });

  it('builds tag_not_exists as a NOT EXISTS clause', () => {
    const { sql, bindings } = buildSegmentQuery({
      operator: 'AND',
      rules: [{ type: 'tag_not_exists', value: 'exclude-tag' }],
    });

    expect(sql).toContain(
      'NOT EXISTS (SELECT 1 FROM friend_tags ft WHERE ft.friend_id = f.id AND ft.tag_id = ?)',
    );
    expect(bindings).toEqual(['exclude-tag']);
  });
});

describe('toSegmentCountSql', () => {
  it('counts friends, not the subquery table, for tag_not_exists (greedy-regex regression)', () => {
    const { sql } = buildSegmentQuery({
      operator: 'AND',
      rules: [{ type: 'tag_not_exists', value: 'exclude-tag' }],
    });
    const countSql = toSegmentCountSql(sql);

    // 貪欲マッチだと `FROM friend_tags` を数えてしまう。正しくは friends を数える。
    expect(countSql).toMatch(/^SELECT COUNT\(\*\) as count FROM friends f WHERE/);
    expect(countSql).not.toContain('COUNT(*) as count FROM friend_tags');
    // サブクエリ側の FROM friend_tags は保持されること。
    expect(countSql).toContain('NOT EXISTS (SELECT 1 FROM friend_tags ft');
  });

  it('counts friends for tag_exists as well', () => {
    const { sql } = buildSegmentQuery({
      operator: 'AND',
      rules: [{ type: 'tag_exists', value: 'inc-tag' }],
    });
    const countSql = toSegmentCountSql(sql);

    expect(countSql).toMatch(/^SELECT COUNT\(\*\) as count FROM friends f WHERE/);
    expect(countSql).not.toContain('COUNT(*) as count FROM friend_tags');
  });

  it('handles the account-filtered SELECT prefix', () => {
    const { sql } = buildSegmentQuery({
      operator: 'AND',
      rules: [{ type: 'tag_not_exists', value: 'exclude-tag' }],
    });
    // /api/segments/count が付与するアカウントフィルタ後も先頭アンカーが効くこと。
    const accountSql = sql.replace('WHERE', 'WHERE f.line_account_id = ? AND');
    const countSql = toSegmentCountSql(accountSql);

    expect(countSql).toMatch(/^SELECT COUNT\(\*\) as count FROM friends f WHERE f\.line_account_id = \? AND/);
    expect(countSql).not.toContain('COUNT(*) as count FROM friend_tags');
  });
});
