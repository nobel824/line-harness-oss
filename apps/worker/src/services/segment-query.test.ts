import { describe, expect, it } from 'vitest';
import { buildSegmentQuery } from './segment-query.js';

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
