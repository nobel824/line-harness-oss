export interface SegmentRule {
  type: 'tag_exists' | 'tag_not_exists' | 'metadata_equals' | 'metadata_not_equals' | 'ref_code' | 'is_following'
  value: string | boolean | { key: string; value: string }
}

export interface SegmentCondition {
  operator: 'AND' | 'OR'
  rules: SegmentRule[]
}

export function buildSegmentQuery(condition: SegmentCondition): { sql: string; bindings: unknown[] } {
  const bindings: unknown[] = []
  const clauses: string[] = []

  for (const rule of condition.rules) {
    switch (rule.type) {
      case 'tag_exists': {
        if (typeof rule.value !== 'string') {
          throw new Error('tag_exists rule requires a string tag ID value')
        }
        clauses.push(
          `EXISTS (SELECT 1 FROM friend_tags ft WHERE ft.friend_id = f.id AND ft.tag_id = ?)`,
        )
        bindings.push(rule.value)
        break
      }

      case 'tag_not_exists': {
        if (typeof rule.value !== 'string') {
          throw new Error('tag_not_exists rule requires a string tag ID value')
        }
        clauses.push(
          `NOT EXISTS (SELECT 1 FROM friend_tags ft WHERE ft.friend_id = f.id AND ft.tag_id = ?)`,
        )
        bindings.push(rule.value)
        break
      }

      case 'metadata_equals': {
        if (
          typeof rule.value !== 'object' ||
          rule.value === null ||
          typeof (rule.value as { key: string; value: string }).key !== 'string' ||
          typeof (rule.value as { key: string; value: string }).value !== 'string'
        ) {
          throw new Error('metadata_equals rule requires { key: string; value: string }')
        }
        const mv = rule.value as { key: string; value: string }
        clauses.push(`json_extract(f.metadata, ?) = ?`)
        bindings.push(`$.${mv.key}`, mv.value)
        break
      }

      case 'metadata_not_equals': {
        if (
          typeof rule.value !== 'object' ||
          rule.value === null ||
          typeof (rule.value as { key: string; value: string }).key !== 'string' ||
          typeof (rule.value as { key: string; value: string }).value !== 'string'
        ) {
          throw new Error('metadata_not_equals rule requires { key: string; value: string }')
        }
        const mv = rule.value as { key: string; value: string }
        clauses.push(`(json_extract(f.metadata, ?) IS NULL OR json_extract(f.metadata, ?) != ?)`)
        bindings.push(`$.${mv.key}`, `$.${mv.key}`, mv.value)
        break
      }

      case 'ref_code': {
        if (typeof rule.value !== 'string') {
          throw new Error('ref_code rule requires a string value')
        }
        clauses.push(`f.ref_code = ?`)
        bindings.push(rule.value)
        break
      }

      case 'is_following': {
        if (typeof rule.value !== 'boolean') {
          throw new Error('is_following rule requires a boolean value')
        }
        clauses.push(`f.is_following = ?`)
        bindings.push(rule.value ? 1 : 0)
        break
      }

      default: {
        const exhaustive: never = rule.type
        throw new Error(`Unknown segment rule type: ${exhaustive}`)
      }
    }
  }

  const separator = condition.operator === 'AND' ? ' AND ' : ' OR '
  const sql = clauses.length > 0
    ? `SELECT f.id, f.line_user_id FROM friends f WHERE f.is_following = 1 AND (${clauses.join(separator)})`
    : 'SELECT f.id, f.line_user_id FROM friends f WHERE f.is_following = 1'

  return { sql, bindings }
}

/**
 * buildSegmentQuery が返す SELECT を COUNT(*) クエリに変換する。
 * 先頭の既知プレフィックスにアンカーして置換する。`SELECT .+ FROM` の
 * 貪欲マッチだと tag_exists/tag_not_exists のサブクエリ側 `FROM friend_tags`
 * まで飲み込み SQL が壊れるため（そのバグをこのヘルパで防ぐ）。
 */
export function toSegmentCountSql(selectSql: string): string {
  return selectSql.replace(/^SELECT f\.id, f\.line_user_id FROM/, 'SELECT COUNT(*) as count FROM')
}
