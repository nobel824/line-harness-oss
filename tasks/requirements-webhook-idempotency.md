# requirements: webhook 冪等性（重複配信の二重処理防止）

## 目的・背景
LINE の webhook 再送（redelivery 設定 ON、または worker が 200 を返す前に throw した場合の再送）に対する重複排除が無い。同じ受信イベントが再処理されると、messages_log に二重挿入され、キーワード自動返信が二重送信される（ユーザーに同じ返信が2回届く）。監査 A#4。

## 機能要件 / User Story
- webhook が同一イベント（`webhookEventId` 一致）を2回以上受け取っても、正常処理は1回だけ行う。
- ただし処理が途中で失敗した場合は、LINE の再送で再処理できる（イベントを取りこぼさない）。
- dedup 記録は無限に増えない（定期的に古い行を削除）。

## Acceptance Criteria（主語・動詞・期待結果）
1. webhook 取り込みループが、同じ `webhookEventId` のイベントを2回処理しようとしたとき、2回目は handleEvent を呼ばずに skip する（messages_log の行が1件だけになる）。
2. handleEvent が throw したイベントは、dedup 記録が解放され、同じ `webhookEventId` の再送で再度 handleEvent が呼ばれる（＝取りこぼさない）。
3. `webhookEventId` が空/未設定のイベントは dedup を行わず通常処理する（防御的分岐。LINE は常に付与するが欠損時に全イベントを誤 dedup しないため）。
4. `cleanupWebhookEventDedup(db, olderThanISO)` が、指定時刻より古い dedup 行のみ削除し、新しい行は残す。
5. scheduled ハンドラの 6h cron tick で 24h 超の dedup 行が削除される。

## 非機能要件
- dedup の claim は原子的（同時到達の重複を1つだけ通す）。`INSERT OR IGNORE` の changes 判定で実装。
- 追加 DB 書き込みは初回配信あたり1回（許容）。
- bootstrap.sql は schema.sql + migrations と同期を保つ（bootstrap.test.ts 緑）。
- claim / handleEvent / release は同一 try で囲み、claim（D1書込）が throw しても
  同一 POST 内の後続イベントを取りこぼさない。

## 設計トレードオフ（意図的選択）
release して再処理する設計上、handleEvent が「副作用を一部実行してから」throw すると、
LINE 再送で副作用が二重に走りうる（例: 自動返信送信後の後段で throw → 再送で再返信）。
これは at-least-once を優先した意図的トレードオフ。**本 dedup 導入前は「毎回」二重処理
だった**ため、正常系で重複を防げる本実装はどのケースでも現状より悪化しない。
handleEvent 内の auto-reply 送信は独自 try/catch で握りつぶされるため、実際に throw が
伝播するのは主に DB 操作であり、二重返信は稀。将来さらに強い保証が要るなら
「副作用チェックポイント方式（副作用実行後は release しない）」を検討する。

## 検証手段
- `pnpm -C packages/db test`
  - dedup helper 実 SQLite（AC4含む）: claim新規→true, 同一→false, release後→true, cleanup で古い行のみ削除
  - bootstrap 同期（bootstrap.test.ts）
- `pnpm -C apps/worker test`（webhook-idempotency.test.ts, 実ルート end-to-end・実署名）
  - AC1: 同一 webhookEventId 2回 POST → messages_log 1件 / 異なるID → 2件
  - AC2: handleEvent を1回だけ throw させる → dedup が release され、再送で再処理されて 1件
  - AC3: webhookEventId 欠損イベント → 通常処理され dedup 記録は残らない
- `pnpm -C apps/worker typecheck` / `pnpm -C packages/db typecheck` 緑

### AC5（scheduled cleanup）の検証方針
`scheduled()` は token-refresh / broadcast / 各 expirer 等を一括実行する monolith で、
単体起動にネットワーク/多数の mock が要る。既存の booking-expirer 等も `scheduled()` 自体は
テストせず `runExpirer` 等の**ユニットを直接テストする慣習**。これに合わせ、AC5 は
`cleanupWebhookEventDedup` のユニットテスト（cutoff 境界）で保証し、6h tick 内の呼び出しは
既存 expirer と同形の 3 行配線として扱う（型チェックで整合を担保）。

## 受入条件（DoD）
- 上記 AC 5件すべてにテストが存在し緑。
- migration 046 追加・schema.sql 追記・bootstrap 再生成済みで bootstrap.test.ts 緑。
- 評価分離レビュー（fresh reviewer）で致命/重要ゼロ。

## Out of scope
- LINE console の redelivery 設定変更（インフラ側）。
- postback/follow/message 以外の将来イベント型の個別最適化（webhookEventId ベースなので型非依存で効く）。

## 影響範囲
- 新規: `packages/db/migrations/046_webhook_event_dedup.sql`, `packages/db/src/webhook-dedup.ts`
- 変更: `packages/db/schema.sql`, `packages/db/bootstrap.sql`（再生成）, `packages/db/src/index.ts`（export）, `apps/worker/src/routes/webhook.ts`（取り込みループ）, `apps/worker/src/index.ts`（scheduled cleanup）
