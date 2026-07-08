/**
 * 配信の開封率 / クリック率 = unique / delivered。
 *
 * null を返すのは「値が本当に不明」なときだけ:
 *   - delivered が null / 0 以下（分母が無い / まだ送達していない）
 *   - unique が null（insight 未取得）
 *
 * delivered > 0 で unique が 0 のケースは「本当に 0%」という有効な実測値であり、
 * null（未取得）に落としてはいけない。以前の `(delivered && unique) ? ... : null`
 * は unique=0 を falsy と扱い、開封 0 の配信を「まだ取得できていない」と誤表示していた。
 */
export function computeEngagementRate(
  delivered: number | null,
  unique: number | null,
): number | null {
  if (delivered == null || delivered <= 0) return null;
  if (unique == null) return null;
  return unique / delivered;
}
