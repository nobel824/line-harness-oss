# 一斉配信の除外（除外タグ）を管理画面から効かせる — 設計書

- 日付: 2026-07-23
- ステータス: 設計（実装前）
- 対象リポジトリ: line-harness-oss（nobel824 フォーク内のみ改修）

## 背景と目的

一斉配信で「一部（当面は1人）を除外して送りたい」という要望。方式は**除外タグ**に決定
（配信対象から外したい友だちにタグを付け、そのタグが**無い**人だけに送る）。

## いま起きている問題（検証済み）

除外を成立させる部品はバックエンドに揃っているが、**管理画面の送信ボタンがその経路を呼んで
いない**ため、除外は実際には効かず**全員に飛ぶ**。危険なので現状での運用は不可。

| 事実 | 根拠 |
|---|---|
| 詳細画面でセグメント条件 `tag_not_exists`（タグなし）を**保存はできる** | `apps/web/src/components/broadcasts/broadcast-detail.tsx:277`（`SegmentBuilder` → `api.broadcasts.update`） |
| だが送信ボタンは通常送信 `/send` を呼ぶ | `broadcast-detail.tsx:157`（`handleSend` → `api.broadcasts.send`） |
| `/send` は `target_type='all'` だとセグメントを無視して broadcast API で全員送信 | `apps/worker/src/services/broadcast.ts:89-95` |
| 除外を効かせる唯一の経路 `/send-segment` は**UIのどこからも呼ばれていない** | `sendSegment` は `apps/web/src/lib/api.ts:458` に定義のみ、呼び出し無し |
| キュー処理は `segment_conditions` があれば `target_type` 不問で拾い、除外を適用する | `getQueuedBroadcasts`（`packages/db/src/broadcasts.ts:343-`）+ `broadcast.ts:333`（`buildSegmentQuery`） |
| セグメント抽出SQLは友だち状態で絞っていない（ブロック解除者も対象に入りうる） | `apps/worker/src/services/segment-query.ts` の最終SQL `SELECT ... FROM friends f WHERE <clauses>` に `is_following` の既定フィルタが無い |
| 対象人数プレビューはセグメントを考慮しない（`target_type` 分岐のみ） | `preview-count`（`apps/worker/src/routes/broadcasts.ts`）に segment 分岐なし |

## 採用方針（Option A）

**除外タグ経路を送信ボタンに繋ぐ小改修**。除外ユーザー選択UIの新規実装（Option B）は行わない。
バックエンドの `/send-segment` + キュー処理 + `buildSegmentQuery` の `tag_not_exists` を活かす。

確定する運用フロー:
1. タグ「配信除外」を作成し、外したい友だちに付与する（既存のタグ機能）。
2. 配信を作成（対象は「全員」または「タグ」）。
3. 詳細画面で「セグメント条件を編集」→ ルール **タグなし=配信除外** を保存。
4. 「この配信を送信する」を押すと、**除外を適用して**全員（−除外タグの人）に送信される。

## 変更点（ユニット別）

### Worker: `apps/worker/src`

1. **`services/segment-query.ts` / `buildSegmentQuery`**
   - 最終SQLの WHERE 先頭に `f.is_following = 1` を必ず付与する。
     `SELECT f.id, f.line_user_id FROM friends f WHERE f.is_following = 1 AND (<clauses>)`。
     clauses が空なら `WHERE f.is_following = 1`。
   - 目的: 除外送信がブロック/友だち解除済みの人へ飛ばないようにする（全送信経路の健全化にもなる）。
   - 注: 既存の `is_following` ルール型は残すが、`is_following = false` を明示指定すると
     既定フィルタと矛盾して0件になる。この型は現在ビルダーUIに露出しておらず、実害なし。

2. **`routes/broadcasts.ts` / `serializeBroadcast`**
   - 返却フィールドに `segmentConditions: r.segment_conditions ?? null`（生JSON文字列のまま）を追加。
   - 目的: フロントが保存済み条件を読めるようにする（リロード後も維持）。

3. **`routes/broadcasts.ts` / `GET /:id/preview-count`**
   - **最優先の分岐**として、`segment_conditions` が存在する場合は `buildSegmentQuery` で
     `COUNT(*)` を返す（キュー送信と同じく `line_account_id` フィルタも同条件で付与）。
   - 目的: 確認モーダルと送信ボタンの「対象 X人」を、実際の除外後人数に一致させる。

4. **`routes/broadcasts.ts` / `POST /:id/send-segment`**
   - 202 応答前に `ctx.waitUntil(processQueuedBroadcasts(...))` を kick する
     （multi-account-dedup パスと同じ即時処理起動）。失敗しても cron が拾うので二重に安全。
   - 目的: 「送信」押下から最大5分の cron 待ちを避け、即時に送信を始める。

### Web: `apps/web/src`

5. **`lib/api.ts` / `ApiBroadcast`**
   - `segmentConditions?: string | null` を型に追加。

6. **`components/broadcasts/broadcast-detail.tsx` / `handleSend`**
   - `broadcast.segmentConditions` が非nullなら、`JSON.parse` して
     `api.broadcasts.sendSegment(id, conditions)` を呼ぶ。無ければ従来どおり `api.broadcasts.send(id)`。
   - 送信前に「除外条件が設定されています」の小さな表示を出し、誤送信を防ぐ
     （確認モーダルの人数は #3 で除外後になる）。
   - 適用範囲: `target_type` が `all` / `tag` のときのみセグメント経路に振る。
     `multi-account-dedup` は従来の専用経路を優先（送信側の分岐と整合）。

### テスト: `apps/worker`（コロケーション方式、`*.test.ts`）

7. **`services/segment-query.test.ts`（新規）**
   - `buildSegmentQuery` が常に `f.is_following = 1` を含むこと。
   - `tag_not_exists` が `NOT EXISTS (... friend_tags ...)` を生成すること。
   - clauses 空でも `WHERE f.is_following = 1` になること。

8. **ルート/送信の統合テスト（既存テストに追記）**
   - `preview-count`: `segment_conditions` 設定時、除外後人数（is_following=1 かつ タグなし）を返す。
   - `/send-segment` → `processQueuedBroadcasts`: is_following=1 の友だちから除外タグ保持者を
     引いた集合に multicast されること（除外タグ1人が確実に外れる）。

## データフロー（送信時）

```
[詳細画面] handleSend
  ├─ segmentConditions あり → POST /send-segment {conditions}
  │     └─ broadcasts: status='sending', batch_offset=0, segment_conditions=JSON
  │     └─ ctx.waitUntil(processQueuedBroadcasts)   ← 即時起動（cronでも拾える）
  │           └─ getQueuedBroadcasts が拾う（segment_conditions IS NOT NULL）
  │           └─ buildSegmentQuery（is_following=1 AND tag_not_exists）→ 対象リスト
  │           └─ 500件ずつ multicast（customAggregationUnit 付与・ステルス遅延）
  └─ segmentConditions なし → 従来の POST /send（全員=broadcast / タグ=multicast）
```

## スコープ外（YAGNI）

- 除外ユーザーを画面から直接ピックする専用UI（Option B）。
- セグメントビルダーへの `is_following` ルールのUI露出。
- 「全員」と「セグメント」の二重状態の整理（target_type の付け替え）。現状は
  `segment_conditions` の有無で送信経路が決まるため、機能上は問題ない。

## リスクと確認事項

- `buildSegmentQuery` への `is_following=1` 追加は**全セグメント送信経路に影響**する。
  既存のセグメント送信テストが緑のままか確認する。
- `preview-count` の segment 分岐は他分岐（tag/all/dedup）より**前**に置く（優先順位）。
- 送信の即時起動（waitUntil）は test 環境で `executionCtx` 不在のことがある。
  dedup パスと同様に try/catch で cron フォールバックする。

## 受け入れ条件（Acceptance Criteria）

1. 管理者が除外タグを1人に付与し、詳細画面で「タグなし=配信除外」を保存して送信すると、
   **その1人を除く全友だち（is_following=1）にのみ**メッセージが届く。
2. 送信確認モーダルと送信ボタンの「対象 X人」が、**除外後の人数**を表示する。
3. 除外条件を設定していない配信は、従来どおり全員/タグ送信で動作する（回帰なし）。
4. ブロック/友だち解除済みの友だちには、セグメント送信で**送られない**。
5. `apps/worker` の関連テスト（segment-query / 送信 / preview-count）が緑。
