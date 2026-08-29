# requirements — 導線の状態機械監査で出た沈黙故障の修正

作成: 2026-08-29 / 起点: `tasks/state.md` §-4「次の一手: ① 導線の状態機械を通しで監査する」
監査は Grok 4.6（読み取り専用）に委譲済み。本書は PM 裁定後の実装仕様。

## 背景

このプロジェクトで見つかった欠陥は例外なく**沈黙故障**（落ちない・例外も出ない・ログにも残らない）。
`cron` は `sent + failed = 0` のときログを出さないので、**正常な 0 通と故障の 0 通が区別できない**。
監査は「この行は正しいか」ではなく「状態遷移を誰が拾い、二重に拾わず、沈黙したらどう見えるか」で見た。

## スコープ外（再提案しないこと）

- 終盤まで観たが CTA を押さなかった人を `archive_closing` より手前で拾う新ステージ
  → **ユーザー決定済み（2026-08-29 0:50）**。押さなかったこと自体が意思表示、という判断
- 予約キャンセル API の新設
- `submitted_no_booking_24h` が「30m が恒久 failed のときデッドになる」件
  → **正しい挙動**。1通目が届いていないのに「昨日ご案内した」は送れない

---

## F1. journey 5ステージが `failed` / `pending` を永久に再送しない（最優先）

**現象**: `journeyCandidates()` の重複ガードは `NOT EXISTS (... jf.kind = ?)` で
**status を見ていない**（`webinar-followups.ts:351-355 / 416-420 / 467-472 / 514-523`）。
行が1つでも出来た時点で、`pending`（INSERT 直後にクラッシュ）でも `failed`（push 失敗）でも
**その人には二度と飛ばない**。一方 CTA 側の `after_*` は `status = 'sent'` だけを除外している（`:283-287`）ので
挙動が非対称。

**なぜ効くか**: LINE の月間枠切れ（429）で push が全滅した実績がある。その間に候補になった人の
追客は**全員、永久に死ぬ**。しかも `sent = 0 / failed` はログに出ない。

**AC-A1**: `webinar_journey_followups` に `status = 'failed'` の行がある人は、
その行の `created_at` から **24時間以内**であれば候補SQLに再び現れる。
**AC-A2**: `status = 'pending'` の行も同じ条件で再び現れる。
**AC-A3**: `status = 'sent'` または `'skipped'` の行がある人は、経過時間にかかわらず候補に現れない。
**AC-A4**: `created_at` から24時間を超えた `failed` / `pending` の行がある人は候補に現れない
（期限を過ぎた `archive_closing` の「本日◯◯で閉じます」のような**古くなった本文を送らない**ため）。
**AC-A5**: 5ステージすべて（`picker_no_registration` / `registered_no_show` /
`submitted_no_booking_30m` / `submitted_no_booking_24h` / `archive_closing`）で A1〜A4 が成り立つ。

**二重送信について**: `retry_key` は行に固定で保存され、Harness プロキシ側で 409 は成功扱い
（`line-proxy-send.ts:34-37`）。したがって「LINE は受理したが DB 更新前に落ちた」ケースを再試行しても
利用者には1通しか届かない。

---

## F2. `after_30m` / `after_24h` が `stage_enabled_at` を見ていない（AC-5-8 違反）

**現象**: `candidates()` は `clicks` CTE と外側 WHERE の両方で `cfg.enabled_at` のみを門にしている
（`webinar-followups.ts:263, 275`）。`enabled_at` は config の INSERT 時にしか入らない
（`packages/db/src/webinars.ts:216-217`）。journey 5ステージは
`COALESCE(cfg.stage_enabled_at, cfg.enabled_at)` を使っている。

**なぜ効くか**: `requirements-auto-webinar-funnel.md` の **AC-5-8** が
「候補抽出SQLは**全ステージで** `datetime(source) >= datetime(COALESCE(cfg.stage_enabled_at, cfg.enabled_at))`
を門にしている」と明記している。`isActive: true` で PUT すると `stage_enabled_at` は now に打ち直される
（`routes/webinars.ts:958-961`）が、`after_*` はそれを無視するので、
**`is_active` を切り戻した瞬間に、有効化前の CTA 離脱者へ一斉送信が載る**（LIMIT 50/分で消化）。

**AC-B1**: `candidates()` の2箇所を `COALESCE(cfg.stage_enabled_at, cfg.enabled_at)` に揃える。
**AC-B2**: `stage_enabled_at` より前の `cta_clicked_at` を持つ人は `after_30m` / `after_24h` の候補に現れない。
**AC-B3**: `stage_enabled_at` が NULL のときは従来どおり `enabled_at` で判定する（既存挙動を壊さない）。

---

## F3. `after_24h` に「`after_30m` 送信済み」ゲートが無く、同一 tick で2通同時に飛ぶ

**現象**: `submitted_no_booking_24h` には
`EXISTS (... kind = 'submitted_no_booking_30m' AND status = 'sent')` があるが（`:482-488`）、
`after_24h` には無い。CTA から24時間以上経過していて両方未送信だと、同じ cron tick で並列に候補化され
（`:584-595`）、2通が連続して届く。本文は
「入力の途中で止まっているようです」＋「**昨日ご案内した**無料相談は…**ご案内はこれで最後です**」で、
1通目を送っていないのに「昨日ご案内した」と言うことになる。

**なぜ今まで出なかったか**: `after_24h` は**テストも本番実績もゼロ**。一度も実行されたことがない。

**AC-C1**: `after_24h` の候補SQLは `webinar_followups` に
`kind = 'after_30m' AND status = 'sent'` の行があることを要求する。
**AC-C2**: CTA から24時間超・`after_30m` 未送信のとき、`after_24h` は候補に現れない。
**AC-C3**: `after_30m` が sent になった後は、従来どおり `after_24h` が候補になる。

---

## F4. `registered_no_show` が回の終了前に発火しうる

**現象**: 発火時刻は `session_start_at + no_show_delay_minutes * 60` で、**動画の長さを足していない**
（`:370`）。`no_show_delay_minutes` の既定は **30**（`060_webinar_journey_followups.sql:10`、
`packages/db/src/webinars.ts:213` の INSERT も 30）。本番の動画は **3449秒（57分29秒）**。

つまり **`noShowDelayMinutes` を明示的に上書きしないまま有効化した新しいウェビナーでは、
配信開始30分後＝ライブの真っ最中に追客が飛ぶ**。しかもその時点の視聴者は
`last_position ≒ 1800 < form CTA の 2997` なので `missed` CTE から除外されず、
**視聴中の人に「続きがまだ残っています」が届く**。

本番は手作業で 1380 を入れてあるので今は出ていない。**設定を1つ忘れると再発する地雷**。

**AC-D1**: `missed` CTE に「回が終了していること」を追加する
（`r.session_start_at + w.duration_seconds <= unixepoch(?)`）。
**AC-D2**: `no_show_delay_minutes = 30` かつ `duration_seconds = 3449` のとき、
セッション開始30分後の時点では候補が 0 件になる。
**AC-D3**: セッション終了後（`session_start + duration` 経過後）は従来どおり候補になる。
**AC-D4**: 本番設定（`no_show_delay_minutes = 1380`）での挙動は変わらない。

---

## テストの方針（重要）

現行の `apps/worker/src/services/webinar-followups.test.ts` は `prepare().all()` を stub しており、
**候補SQLの WHERE は一度も実行されていない**。本書の AC は全部 SQL の意味に関するものなので、
モックでは担保できない。

**新規に `apps/worker/src/services/webinar-followups-sql.test.ts` を作り、`better-sqlite3` の
インメモリDBを `asD1` シムで包んで候補SQLを実際に流す。**
シムの雛形は `packages/db/test/webinar-journey-stats.test.ts:5-24` にある（`prepare().bind().all()/.first()`）。
`better-sqlite3` は `apps/worker` のテストでも既に使われている（`routes/webhook-dedup.test.ts` 等）。

### 実SQLで固定するテスト一覧

| # | ステージ | 固定すること |
|---|---|---|
| T1 | 全 journey 5種 | AC-A1〜A5（failed は24h以内なら再候補 / sent・skipped は恒久ブロック / 24h超は恒久ブロック） |
| T2 | after_30m | クリック済み・form CTA あり・未送信 → 1件。クリック以降の form 送信あり → 0件 |
| T3 | after_24h | AC-C1〜C3 |
| T4 | after_30m / after_24h | AC-B1〜B3 |
| T5 | after_* | form CTA が無い（url CTA だけ）→ 0件 |
| T6 | registered_no_show | AC-D1〜D4 |
| T7 | submitted_no_booking_30m | `booking_url` が NULL → 0件。`booking_menu_id` が NULL → 0件。両方あり未予約 → 1件 |
| T8 | submitted_no_booking_30m | local `bookings` が `requested`/`confirmed`/`completed` → 0件。`cancelled` だけ → 1件 |
| T9 | picker_no_registration | `stage_enabled_at` より前の `opened_at` → 0件（再訪しても `opened_at` は動かないため） |

T7 は `booking_url` が null で2ステージが数日沈黙した事故の再発防止。

## 非機能

- 既存 29 tests を壊さない
- 変更は `apps/worker/src/services/webinar-followups.ts` と新規テスト、および既存テストの追随のみ
- マイグレーションは追加しない（スキーマ変更なし）

---

## 追記（2026-08-29・実装1周目のレビュー後）

### F3 は未実装だった（実装側の誤認）

1周目の実装は「F3 の `after_30m` 送信済みゲートは既存実装済み」と報告したが、**誤り**。
既存の `needsFirstFollowup`（`webinar-followups.ts:481-488`）は
**`submitted_no_booking_24h` 用**であって、`after_24h` には効かない。
`candidates()`（`after_30m` / `after_24h` の候補SQL）には今も
`kind = 'after_30m' AND status = 'sent'` を要求する EXISTS が無い。

同じ理由で、新規テストの `T3` も名前は `after_24h` だが中身は
`submitted_no_booking_24h` を検証している。**AC-C1〜C3 は未達のまま。**

### F5. `archive_closing` がアーカイブ期限を過ぎても発火しうる（新規）

**現象**: `archive_closing` の候補SQLは下限（`>= 期限 − 6時間`）だけで**上限が無い**
（`webinar-followups.ts:493-495` 付近）。本文は「本日 ◯◯ で閉じます」と断定する。

- cron が数日止まった後に再開すると、**とっくに閉じたアーカイブについて「本日閉じます」と送る**
- F1 で `failed` / `pending` を24時間再試行するようにしたため、
  **push が失敗してから最大24時間後に再送**される。期限直前6時間の窓で失敗すると、
  再送時には期限を過ぎている

F1 を入れる以上、上限を付けないと F1 自体が誤送信の経路になる。

**AC-E1**: `archive_closing` の候補SQLに上限を足す
（`lr.session_start_at + w.duration_seconds + ARCHIVE_WINDOW_SECONDS > unixepoch(?)`）。
**AC-E2**: アーカイブ期限を過ぎたセッションは、`webinar_journey_followups` に行が無くても候補に現れない。
**AC-E3**: 期限内（期限の6時間前〜期限）は従来どおり候補になる。

### 追加テスト

| # | 固定すること |
|---|---|
| T3'（差し替え） | `after_24h`: クリックから24時間超・`after_30m` 未送信 → 0件（AC-C2）。`after_30m` が sent → 1件（AC-C3）。本文が `buildCtaFollowupText('after_24h')` のものであること |
| T10 | `archive_closing`: 期限を過ぎたセッション → 0件（AC-E2）。期限の6時間前〜期限内 → 1件（AC-E3） |

既存の T3（`submitted_no_booking_24h` を検証しているもの）は**消さずに名前を実態に合わせる**。
