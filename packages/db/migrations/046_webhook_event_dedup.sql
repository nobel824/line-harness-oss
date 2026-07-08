-- 046_webhook_event_dedup.sql
-- LINE webhook の再送（redelivery）による同一イベントの二重処理を防ぐための
-- dedup 記録。event_id = LINE の webhookEventId（イベント毎に一意）。
-- 正常処理できたイベントの id をここに残し、再送時は skip する。処理が失敗した
-- 場合は行を削除して再送で再処理できるようにする（webhook.ts 側の claim/release）。
-- 古い行は scheduled(6h) の cleanup で削除するため PK 以外の索引は不要。

CREATE TABLE IF NOT EXISTS webhook_event_dedup (
  event_id   TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);
