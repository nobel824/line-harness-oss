# 一斉配信の除外（除外タグ）を管理画面から効かせる — 設計書

- 日付: 2026-07-23
- ステータス: 設計（実装前・Grok レビュー反映済み v2）
- 対象リポジトリ: line-harness-oss（nobel824 フォーク内のみ改修）

## 背景と目的

一斉配信で「一部（当面は1人）を除外して送りたい」という要望。方式は**除外タグ**に決定
（配信対象から外したい友だちにタグを付け、そのタグが**無い**人だけに送る）。当面のスコープは
**「全員（target_type='all'）から除外タグの人を引く」**に限定する。

## いま起きている問題（検証済み）

除外を成立させる部品はバックエンドに揃っているが、**送信経路がその部品を使っていない**ため、
除外は実際には効かず**全員に飛ぶ**。危険なので現状での運用は不可。

| 事実 | 根拠 |
|---|---|
| 詳細画面でセグメント条件 `tag_not_exists`（タグなし）を保存はできる | `apps/web/src/components/broadcasts/broadcast-detail.tsx:277`（`SegmentBuilder`→`api.broadcasts.update`） |
| 手動送信は `/send`→`processBroadcastSend` を呼び、`target_type='all'` は broadcast API で全員送信（segmentを無視） | `apps/worker/src/services/broadcast.ts:89-95` |
| **予約送信も** `processScheduledBroadcasts`→`processBroadcastSend` で同じく全員送信 | `apps/worker/src/services/broadcast.ts:197`（`processScheduledBroadcasts`）|
| 除外を効かせる `/send-segment` は UI から呼ばれていない | `sendSegment` は `apps/web/src/lib/api.ts:458` に定義のみ |
| キュー処理は `segment_conditions` があれば `target_type` 不問で拾い、除外を適用する | `getQueuedBroadcasts`（`packages/db/src/broadcasts.ts:343`、WHERE=`status='sending' AND batch_offset>=0 AND sent_at IS NULL AND (segment_conditions IS NOT NULL OR account_ids IS NOT NULL)`）+ `broadcast.ts:333`（`buildSegmentQuery`）|
| セグメント抽出SQLは友だち状態で絞っていない（ブロック解除者も対象に入りうる） | `apps/worker/src/services/segment-query.ts:88`（最終SQL に `is_following` 既定フィルタ無し）|
| 対象人数プレビューはセグメントを考慮しない | `preview-count`（`apps/worker/src/routes/broadcasts.ts`）に segment 分岐なし |

## 採用方針（Option A / サーバー側で塞ぐ・v2）

除外の適用判断を**送信サービスの一点（`processBroadcastSend` 冒頭のゲート）**に集約する。
これにより手動送信・予約送信・API直叩きの**どの入口から来ても**除外が効く。UI 側の送信ボタンの
振り分けや条件パースは不要にし、UI 変更は最小（除外表示のみ）。除外ユーザー選択UI（Option B）は行わない。

確定する運用フロー:
1. タグ「配信除外」を作成し、外したい友だちに付与する（既存のタグ機能）。
2. 配信を作成（**対象は「全員」**）。
3. 詳細画面で「セグメント条件を編集」→ ルール **タグなし=配信除外** を保存。
4. 送信すると、その1人を除く全友だち（is_following=1）にだけ届く（手動・予約とも）。

## 変更点（ユニット別）

### Worker: `apps/worker/src`

1. **`services/broadcast.ts` / `processBroadcastSend`（中核・新ゲート）**
   - `multi-account-dedup` 分岐の直後に**セグメント・ゲート**を追加:
     `target_type === 'all'` かつ `segment_conditions` が非nullなら、**inline 送信せず早期 return**する
     （status は既に 'sending'、`batch_offset` は 0 のまま → `getQueuedBroadcasts` が拾う）。
   - 効果: 手動送信も予約送信も、この一点で「全員−除外」をキュー経由の multicast に回す。
   - **`target_type='tag'` にはゲートを効かせない**（tag+segment は queued 側で segment 置換になり
     対象がタグ外へ拡大するため。当面 tag×除外は非対応＝下記スコープ外）。

2. **`routes/broadcasts.ts` / `POST /:id/send`（即時起動 kick）**
   - inline 送信ブロックで `processBroadcastSend` が上記ゲートにより即 return した場合に備え、
     `target_type='all'` かつ `segment_conditions` 非nullのときは
     `ctx.waitUntil(processQueuedBroadcasts(...))` を kick して即時にキュー処理を起動する
     （multi-account-dedup パスと同じ手法・try/catch で cron フォールバック）。
   - 予約送信は次の cron が `getQueuedBroadcasts` で拾うため kick 不要。

3. **`services/segment-query.ts` / `buildSegmentQuery`**
   - 最終SQLを `SELECT f.id, f.line_user_id FROM friends f WHERE f.is_following = 1 AND (<clauses>)` にする
     （clauses が空なら `WHERE f.is_following = 1`）。
   - 効果: 除外送信がブロック/友だち解除済みへ飛ばない。全セグメント送信経路の健全化。
   - 既存 `is_following` ルール型は残す（UI非露出）。`is_following=false` 明示時は既定フィルタと
     矛盾し0件になるが実害なし。**既存のセグメント送信テストが緑のままか回帰確認する**。

4. **`routes/broadcasts.ts` / `GET /:id/preview-count`**
   - 分岐順序: `multi-account-dedup`（既存・最優先のまま）→ **`target_type='all'` かつ
     `segment_conditions` 非null → `buildSegmentQuery` で `COUNT(*)`** → 既存の tag / all …。
   - アカウントフィルタは queued 送信（`broadcast.ts:334-344`）と**同一の付与方法**にして人数ドリフトを防ぐ
     （可能なら共通ヘルパに切り出す）。
   - 効果: 確認モーダルと送信ボタンの「対象 X人」を除外後の人数に一致させる。

### Web: `apps/web/src`

5. **`routes/broadcasts.ts` / `serializeBroadcast`（worker）+ `lib/api.ts` / `ApiBroadcast`（web）**
   - serialize に `segmentConditions: r.segment_conditions ?? null`（生JSON文字列のまま）を追加。
   - `ApiBroadcast` 型に `segmentConditions?: string | null` を追加。

6. **`components/broadcasts/broadcast-detail.tsx`（表示のみ・送信分岐は変更しない）**
   - `broadcast.segmentConditions` が非nullなら「**除外条件が設定されています**」を送信前に明示表示
     （誤送信防止。確認モーダルの人数は #4 で除外後になる）。
   - `handleSend` は従来どおり `api.broadcasts.send(id)` のまま（サーバー側ゲートで塞ぐため振り分け不要）。
   - **SegmentBuilder（「セグメント条件を編集」）は `target_type='all'` のときだけ表示**する
     （tag×除外の誤設定を防ぐ）。生JSON文字列を `initialConditions` に渡さない（編集は新規に開く）。

### テスト: `apps/worker`（コロケーション方式 `*.test.ts`）

7. **`services/segment-query.test.ts`（新規）**
   - `buildSegmentQuery` が常に `f.is_following = 1` を含む／clauses 空でも同様／`tag_not_exists` が
     `NOT EXISTS (... friend_tags ...)` を生成すること。

8. **送信の統合テスト（既存に追記）**
   - `target_type='all'` + `segment_conditions`(tag_not_exists) の手動 `/send`:
     `processBroadcastSend` が inline せず、`processQueuedBroadcasts` が
     **is_following=1 の友だちから除外タグ保持者を引いた集合**にのみ multicast すること（除外1人が確実に外れる）。
   - **予約送信**（`processScheduledBroadcasts`）でも同様に除外が効くこと。
   - `preview-count`: `all`+segment のとき除外後人数を返すこと。
   - 回帰: 除外未設定の `all`（broadcast API）/ `tag` / `multi-account-dedup` が従来どおり。

## データフロー（送信時）

```
[手動] /send → 既存の inline claim(status=sending)
   └ processBroadcastSend 冒頭ゲート: target_type='all' && segment_conditions あり → return（queued のまま）
   └ /send が ctx.waitUntil(processQueuedBroadcasts) を kick（即時／cron フォールバック）
[予約] cron → processScheduledBroadcasts → claim → processBroadcastSend
   └ 同じ冒頭ゲートで return → 次の cron の getQueuedBroadcasts が拾う
[共通] getQueuedBroadcasts（segment_conditions IS NOT NULL で拾う）
   └ buildSegmentQuery（is_following=1 AND tag_not_exists）→ 対象リスト
   └ 500件ずつ multicast（customAggregationUnit 付与・ステルス遅延）
```

## スコープ外（YAGNI）

- **tag（target_type='tag'）× 除外の併用**。queued 側が segment を tag より優先し「置換」になるため、
  当面は「全員 × 除外」のみ対応。tag×除外を将来やるなら queued 側で
  `tag_exists(対象タグ) AND tag_not_exists(除外タグ)` の**交差条件**を組む改修が別途必要。
- 除外ユーザーを画面から直接ピックする専用UI（Option B）。
- セグメントビルダーへの `is_following` ルールのUI露出。
- 一覧UIで target_type='all' 表示のまま実送信が segment になる認知齟齬の解消（詳細画面の #6 表示で緩和）。

## 観測性・挙動の変化（想定内）

- 「全員×除外」は broadcast API ではなく **multicast**（`customAggregationUnit=bcast_<id>`）で送るため、
  `total_count` が 0 → 実人数になり、insight は aggregation unit 経由で集計される（broadcast API の
  requestId 集計とは別系統）。除外なしの「全員」は従来どおり broadcast API のまま。

## リスクと確認事項

- `buildSegmentQuery` の `is_following=1` 追加は全セグメント消費者に影響。回帰テストで担保する。
- `waitUntil(processQueuedBroadcasts)` はキュー全体を駆動する（既存 dedup と同じ副作用・許容）。
- 大量友だちの「全員×除外」は multicast バッチ数が増える。`processQueuedBroadcasts` の yield/再開と
  `recoverStalledBroadcasts` で既存同様に担保されるが、統合テストで最低限の分割動作を確認する。
- `segment_conditions` が空 rules だと `WHERE is_following=1 AND (1=1)` = 全フォロワーへ multicast
  （broadcast API へは落ちない＝過送信ではない）。SegmentBuilder は保存時に rules ≥1 を要求する。

## 受け入れ条件（Acceptance Criteria）

1. 管理者が除外タグを1人に付与し、対象「全員」で「タグなし=配信除外」を保存して**手動送信**すると、
   その1人を除く全友だち（is_following=1）にのみメッセージが届く。
2. 同じ配信を**予約送信**しても、除外が同様に効く。
3. 送信確認モーダルと送信ボタンの「対象 X人」が、除外後の人数を表示する。
4. ブロック/友だち解除済みの友だちには、除外送信で送られない。
5. 除外条件を設定していない配信（全員/タグ/複数アカ重複除外）は従来どおり動作する（回帰なし）。
6. `apps/worker` の関連テスト（segment-query / 送信 / preview-count）が緑。
