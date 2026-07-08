// LINE webhook の再送（redelivery）による同一イベントの二重処理を防ぐ dedup ヘルパー。
// event_id = LINE の webhookEventId（イベント毎に一意）。
//
// 使い方（webhook 取り込みループ）:
//   const claimed = await claimWebhookEvent(db, event.webhookEventId);
//   if (!claimed) continue;              // 既に処理済み → skip
//   try { await handleEvent(...); }
//   catch (e) { await releaseWebhookEvent(db, event.webhookEventId); throw e; }
//
// claim を「先に」書き、処理成功で残す / 失敗で release することで:
//   - 正常処理は1回だけ（重複再送は skip）
//   - 途中失敗したイベントは release され、再送で再処理できる（取りこぼさない）

/**
 * イベントを原子的に claim する。
 * @returns true = このプロセスが初めて claim した（処理してよい） /
 *          false = 既に claim 済み（＝重複、skip すべき）
 *
 * INSERT OR IGNORE の changes で判定するため、同時到達でも1つだけ true になる。
 */
export async function claimWebhookEvent(db: D1Database, eventId: string): Promise<boolean> {
  const result = await db
    .prepare(`INSERT OR IGNORE INTO webhook_event_dedup (event_id) VALUES (?)`)
    .bind(eventId)
    .run();
  // D1 は meta.changes に挿入行数を返す（IGNORE で衝突したら 0）。
  return (result.meta?.changes ?? 0) > 0;
}

/**
 * claim を取り消す（処理が失敗したとき）。再送で再処理できるようにする。
 */
export async function releaseWebhookEvent(db: D1Database, eventId: string): Promise<void> {
  await db.prepare(`DELETE FROM webhook_event_dedup WHERE event_id = ?`).bind(eventId).run();
}

/**
 * 指定 ISO 時刻より古い dedup 行を削除する（無限増加防止）。
 * scheduled(6h) から 24h 超を渡して呼ぶ。
 * @returns 削除した行数
 */
export async function cleanupWebhookEventDedup(
  db: D1Database,
  olderThanIso: string,
): Promise<number> {
  const result = await db
    .prepare(`DELETE FROM webhook_event_dedup WHERE created_at < ?`)
    .bind(olderThanIso)
    .run();
  return result.meta?.changes ?? 0;
}
