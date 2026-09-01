# 要件 — automation の add_tag が tag_added シナリオを起動しない（F7）

作成: 2026-08-29 / 起票: 本番観測（`5202064a` の enrolledTotal = 0）

## 背景 — 何が起きているか

`automations` の `add_tag` アクションは `event-bus.ts:241` で `addTagToFriend()`（`packages/db/src/tags.ts:77`）を
呼ぶ。これは `friend_tags` への素の `INSERT OR IGNORE` と mileage イベントの enqueue だけで、
**`tag_added` トリガーのシナリオを enroll しない**。

enroll を発火するのは `services/friend-tag-attach.ts` の `attachTagAndFireSideEffects()` だけで、
tracked-link / LIFF / フォーム / 予約 / ウェビナーはそちらを通っている。**automation だけが素通りしている。**

### 本番で死んでいる導線（2026-08-29 12:10 実測）

| automation | 付与タグ | 起動するはずのシナリオ | 実績 |
|---|---|---|---|
| `b3c926e8` 特典｜キーワード「特典」 | `cf7c7a78` 特典請求 | `5202064a` ウェビナー案内 翌日19時 | **enrolled 0** |
| `96c82bb0` クラファン｜キーワード「資料」 | `84e2581f` 資料請求 | `7ce4009e` クラファン7日ステップ | **enrolled 0** |

対照群として `friend_add` トリガーの `913b65d8` は enrolled **1196**。stats API は壊れていない。
`b3c926e8` の実行ログは 2026-08-29 10:30 に `add_tag success` を記録しており、タグ付与自体は成功している。
automation `b3c926e8` の description には「このタグが翌日フォローのシナリオを起動する」と書かれている＝**意図どおり動いていない**。

**沈黙故障**: 落ちない・エラーも出ない・ログにも残らない。シナリオ画面は active のまま 0 を表示する。

## スコープ（ユーザー裁定済み・2026-08-29）

- **`event-bus.ts` の `add_tag` ケースだけを直す。** `stripe.ts` / `step-delivery.ts` の `on_reach_tag_id` /
  `duplicate-detect.ts` / `immediate-first-step.ts` の `addTagToFriend` 呼び出しは**触らない**
- **既存の 36 人（特典請求済み・案内未クリック）のバックフィルはしない。** 今後の特典請求から効かせる。
  `INSERT OR IGNORE` で `added=false` になるため、既存タグ保持者が再 enroll されることは無い

## 事前に確認済みの副作用

1. **循環 import**: `friend-tag-attach.ts` は `event-bus.js` から `fireEvent` を import している。
   `event-bus.ts` から static import すると循環する。**動的 import（`await import('./friend-tag-attach.js')`）を使う**。
   同ファイル内に `await import('@line-crm/db')` の前例がある（`send_message` ケース）
2. **`tag_change` イベントが新たに発火する**。`attachTagAndFireSideEffects` は末尾で `fireEvent(db, 'tag_change', …)` を呼ぶ。
   本番の automation は3本とも `eventType = message_received` で **`tag_change` の購読者はゼロ**。
   outgoing webhook / 通知ルール / スコアリングルールも **すべて 0 件**（2026-08-29 12:30 実測）なので実害は無い。
   **今回は塞がない。この要件に記録だけ残す。** 将来 `tag_change` 起動の automation を作るときは
   以下を必ず確認すること（Grok レビュー指摘）:
   - `start_scenario` / 別タグの `add_tag` は **token 不要で実行される**。cron 経由で本文が乗る
   - **`remove_tag` のあと同一タグを `add_tag` すると、タグ行が消えて再 INSERT できるため
     `fireEvent('tag_change')` が深さ制限なしで再入する**。同一タグの連続 `add_tag` は
     `changes=0` で1周で止まるが、この組み合わせは止まらない
   - `send_message` / リッチメニュー系は `lineAccessToken` 不在で無音スキップされる
     （`friend-tag-attach.ts` の `fireEvent` は token を渡していない）
3. **push は渡さない**。`attachTagAndFireSideEffects` の第4引数 `push` を省略し、配信は cron に任せる。
   （`5202064a` step1 は `absolute_time` / `offsetDays:1` / `19:00` なので `pushImmediateFirstStep` は
   `computeNextDeliveryAt` の判定で即時対象にならないが、**渡さないことで判定に依存しない**）
4. **戻り値の型が違う**。`addTagToFriend` は `Promise<boolean>`、`attachTagAndFireSideEffects` は
   `Promise<{added:boolean}>`。`event-bus.ts:241` は戻り値を使っていないので影響なし

## Acceptance Criteria

- **AC-1**: `add_tag` アクションが新規タグを付与したとき、そのタグを `trigger_tag_id` に持つ
  `trigger_type='tag_added'` かつ `is_active=1` のシナリオに、その friend が enroll される
- **AC-2**: 同じ friend に同じタグを再度 `add_tag` しても（`INSERT OR IGNORE` で changes=0）、
  enroll は発火せず、`friend_scenarios` に行は増えない
- **AC-3**: 既に同じシナリオに enroll 済みの friend は、重複 enroll されない
- **AC-4**: `is_active=0` のシナリオには enroll されない
- **AC-5**: `add_tag` の enroll 経路は `pushImmediateFirstStep` を呼ばない（即時 push しない）
- **AC-5b**: `fireEvent` が `lineAccessToken` を伴っていても `pushImmediateFirstStep` を呼ばない。
  **AC-5 だけでは「token が無いから push しなかった」と区別がつかない**。他経路
  （tracked-link / LIFF）は token があるときだけ `push` を渡すので、同じ形に寄せる回帰は
  token 無しのテストを素通りする（Grok レビュー指摘）
- **AC-6**: `trigger_tag_id` が違うシナリオには enroll しない
- **AC-7**: `trigger_type` が `tag_added` 以外のシナリオには enroll しない
- **AC-8**: `stripe.ts` / `step-delivery.ts` / `duplicate-detect.ts` / `immediate-first-step.ts` の
  `addTagToFriend` 呼び出しは変更されていない（差分に現れない）

## 検証手段

- `apps/worker/src/services/event-bus.test.ts` に AC-1〜AC-7 のテストを追加する
- `cd apps/worker && ../../node_modules/.bin/vitest run` が全緑
- `cd apps/worker && ../../node_modules/.bin/tsc --noEmit` が exit 0
- AC-8 は `git diff --stat` で対象ファイルが出ないことを確認
- **新しいテストは必ず変異させ、空振りでないことを実測する**（実施済み）:
  - `trigger_tag_id === tagId` を `true` に → **AC-6 だけが FAIL**
  - `trigger_type === 'tag_added'` を `true` に → **AC-7 だけが FAIL**
  - `event-bus.ts` が token 付きで `push` を渡す形に → **AC-5b だけが FAIL**
    （これは `pushImmediateFirstStep` の `vi.mock` が `friend-tag-attach.ts` の import に
    実際に刺さっていることの証明も兼ねる。刺さっていなければこの変異でも落ちない）

## レビュー結果（2026-08-29）

fresh Sonnet（一次）＋ Grok 4.6（別家系）の2本。**致命は両者とも「無し」。**

| 指摘 | 裁定 |
|---|---|
| `tag_change` の入れ子発火で blast radius が広がる（両者） | **据え置き**。本番の購読者ゼロを PM が実測。要件書に記録済み・ユーザー裁定済み |
| `remove_tag` → 同一タグ `add_tag` で無制限に再入しうる（Grok・新規） | **据え置き＋記録**。上記「事前に確認済みの副作用」2 に追記 |
| AC-5 が token 無しの呼び出ししか見ておらず回帰を逃す（Grok） | **修正**。AC-5b を追加し、変異で実証 |
| `trigger_type` を落とすテストが無い（Grok） | **修正**。AC-7 を追加し、変異で実証 |
| AC 番号が要件書とテストで衝突（Sonnet） | **修正**。要件書を AC-6 / AC-7 / AC-8 に振り直した |
| AC-1〜AC-4 が mock 呼び出し粒度で実 INSERT を見ていない（Grok・軽微） | **据え置き**。許可ファイルが event-bus 系2本に限定されているため、この粒度が上限 |

**両レビュアーとも「本番 D1 を見ていないので `tag_change` 購読者の有無は確認できない」と留保している。**
PM が実測して埋めた（automation 3本すべて `message_received` / outgoing webhook 0 / 通知ルール 0 / スコアリング 0）。
