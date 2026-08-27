# 要件定義書｜相談ページの単体化（F-9）＋ アーカイブ期限リマインド（F-10）

作成: 2026-08-28 / 正本 `tasks/requirements-auto-webinar-funnel.md` の続き（F-1〜F-8 の続き番号を使う）
状態: **未着手**。設計判断の経緯と根拠は `tasks/state.md` の「2026-08-28 の決定」節が正本。

## 1. 目的・背景

### 何が問題か

ウェビナーを **最後まで見たのに CTA を押さなかった人に、何も届いていない**。

`buildRegisteredNoShowText` は `lastPosition >= ctaAt` のとき **`null` を返して送信しない**
（`webinar-followups.ts:90`）。一方 CTA 後の追客 `after_30m` / `after_24h` の候補SQLは
**`v.cta_clicked_at IS NOT NULL` が必須**（`webinar-followups.ts:177`）。
→ **49:57 まで見て押さなかった人は、どちらの網にも入らない。** 一番濃い層がそこで落ちている。

### なぜ今まで塞げなかったか

塞ぐには「無料相談はこちら」と**リンクを1本渡す**のが自然だが、**そのリンクが存在しなかった**。
相談枠ピッカーはウェビナー視聴画面の中にしか無く、単体で開ける URL が無い。
この制約は `submitted_no_booking_30m` / `submitted_no_booking_24h` の2通を無効化している理由でもある
（`booking_url` を意図的に NULL にして発火させていない）。

### 調べた結果、作るコストは小さい

- **API は既に独立している**: `GET /api/liff/webinars/:slug/consultation-slots` /
  `POST /api/liff/webinars/:slug/consultation-book`（`webinar/main.tsx:1256,1292`）
- **認証は idToken だけで完結する**: `resolveWebinarCaller`（`routes/webinars.ts:131-144`）は
  Authorization ヘッダの LIFF idToken から lineUserId を取り、account 内の friend を引くだけ。
  **視聴セッションにも予約状態にも依存していない**
- **UI は枠一覧の描画70行程度**（`webinar/main.tsx:1390-1460`）
- **ルーティングは1行**（`client/main.ts:690-705` の `page===` 分岐）

### この2本で解けること

1. F-10 の (c) が「無料相談はこちら」＋リンク1本で済む（完走者に57分の動画を再び開かせない）
2. **`submitted_no_booking_*` の2通が解禁される**
3. Meet が付いたまま（`consultation-book` 経由なので `addGoogleMeet` の分岐に乗る）

## 2. スコープ

### やる
- **F-9** 相談枠ピッカーを `?page=consult&slug=<slug>` で単体で開けるようにする
- **F-10** アーカイブ期限の6時間前に1通だけ送る新ステージ `archive_closing`

### やらない（Out of scope）
- `submitted_no_booking_*` の**有効化そのもの**。F-9 完了で技術的に可能になるが、
  有効化は `booking_url` の設定＝**運用判断**。本書では「解禁可能になる」までを扱う
- 一般予約経路（`page=salon-book`）への `addGoogleMeet` 追加。
  **他2アカウント（クラファン／サガリ藤）の予約全部に波及するので採らない**
- `page=form` を相談フォームに使う道。**送信すると「送信完了」で終わり枠選択に進めない**
  （`client/form.ts:659`）ため、フォームだけ開かせて予約できない最悪の体験になる
- 追客ステージの追加（`archive_closing` 以外）。本文の出し分けで対応する
- ヘッダー画像・実在コメントの相互表示（別件）

### 前提（実測で確定済み・仮定ではない）
- `ARCHIVE_WINDOW_DAYS = 3`（`services/webinar-schedule.ts:11`）
- 現行の最大通数は4通。本書の F-10 で **5通**になる
- form CTA の位置は `webinar_ctas` の `kind='form'` の最小 `at_seconds`（本番は 2997＝49:57）
- 本番ウェビナーは `eec8dea0` の1件のみで、form CTA を1枚持つ

## 3. 機能要件と受け入れ条件

> **危険 zone（DB migration を含む）のため AC は EARS 形式（When … , the system shall …）で書く。**

### F-9 相談枠ピッカーの単体ページ

| ID | Acceptance Criteria（EARS） | 検証手段 |
|---|---|---|
| **AC-9-1** | When 友だちが `?page=consult&slug=ai-x-webinar` を LIFF で開く, the system shall 当該ウェビナーの相談枠一覧を表示する | 実機で開いて枠が1件以上出る。`GET /consultation-slots` が 200 と `slots.length > 0` |
| **AC-9-2** | When 呼び出した友だちが**視聴記録も予約も持たない**, the system shall それを理由に拒否せず枠を表示する | テスト: `resolveWebinarCaller` のモックで viewers / registrations 空の状態を作り 200 を確認 |
| **AC-9-3** | When 友だちが枠を1つ選んで確定する, the system shall 予約を確定し **Google Meet リンク付き**の予定を作成する | 実機で予約 → Google カレンダーに Meet URL 付きの予定。`consultation-book` が 200 |
| **AC-9-4** | When 対象ウェビナーの `status` が `active` でない, the system shall 404 を返す | `loadActiveWebinar` の既存挙動。draft のウェビナー slug で 404 |
| **AC-9-5** | When `webinar_followup_configs.booking_menu_id` が未設定, the system shall 404 を返す | 既存挙動（`webinar-consultation-booking.ts:106`）。設定を外して 404 |
| **AC-9-6** | When Authorization ヘッダの idToken が無効, the system shall 401 を返す | 既存挙動（`:136`）。無効トークンで 401 |
| **AC-9-7** | When ページを開いた, the system shall 視聴画面（`page=webinar`）の表示・挙動を変更しない | `page=webinar` の既存テストが全て green のまま |

### F-10 アーカイブ期限リマインド `archive_closing`

| ID | Acceptance Criteria（EARS） | 検証手段 |
|---|---|---|
| **AC-10-1** | When 予約した回の**アーカイブ期限の6時間前**に到達し、対象者が未行動である, the system shall `archive_closing` を **1通だけ**送信する | 期限 = `session_start_at + duration_seconds + ARCHIVE_WINDOW_SECONDS`。候補SQLのユニットテストで境界（6h1m前=対象外 / 6h前=対象 / 期限後=対象外） |
| **AC-10-2** | When 対象者が既に相談フォーム（`webinar_ctas.form_id`）を送信済み, the system shall 送信しない | `NOT EXISTS (form_submissions …)` をテスト |
| **AC-10-3** | When `last_position_seconds >= form CTA の at_seconds` かつ CTA 未クリック, the system shall **(c) の本文**（相談ページ `page=consult` へのリンクを含む）を送信する | `buildArchiveClosingText` のユニットテスト。本文に `page=consult` が含まれる |
| **AC-10-4** | When `last_position_seconds < form CTA の at_seconds`, the system shall **(b) の本文**（終盤が残っている旨）を送信する | 同上 |
| **AC-10-5** | When 視聴記録が無い, the system shall **(a) の本文**を送信し、**次の回を選べる導線（picker URL）を含める** | 同上。本文に picker URL が含まれることをアサート |
| **AC-10-6** | When 同一 friend × webinar × session に `archive_closing` が既に `sent`, the system shall 再送しない | `NOT EXISTS (webinar_followups … kind='archive_closing' AND status='sent')` |
| **AC-10-7** | When form CTA が1つも無いウェビナーである, the system shall `COALESCE(…, 0)` により「視聴したら除外」の従来挙動を維持する | **SQL 文字列に `COALESCE` があることを文字列アサートする**（モックだと SQL が壊れても green になるため。⑭で実際に踏んだ） |
| **AC-10-8** | When 本文を組み立てる, the system shall 「もう見られなくなります」「今すぐ」「急いで」「もう二度と」を**含めない** | 禁止語の配列でユニットテスト（3分岐すべて） |
| **AC-10-9** | When `archive_closing` が送信された, the system shall `journey` の段別カウントに件数を反映する | `GET /api/webinars/:id/analytics` の `journeyFollowups` に `archive_closing` が現れる |
| **AC-10-10** | When 設定が `is_active` 0→1 に切り替わる, the system shall `stage_enabled_at` より前の離脱者を候補にしない | 既存の全ステージと同じガード。バースト送信の再発防止 |

## 4. 非機能要件・実装制約

- **通数**: 1人あたり最大4通 → **5通**。ステージ排他なので全員が5通受けるわけではない。
  ブロック理由1位は「配信頻度が多すぎる」26.5%（モビルス・2025・n=655）`[実証]`
- **課金**: push は課金対象。母数は「予約したが完走も申込もしていない人」だけ。残枠 約2,000通 `[実測]`。
  **分母である月間の新規特典請求者数は未実測**
- **`ARCHIVE_WINDOW_DAYS` をハードコードしない**。`services/webinar-schedule.ts:11` の定数を import する
- **CTA 位置をハードコードしない**。`webinar_ctas` の `kind='form'` の最小 `at_seconds` を引く
- **cron の CPU 制約**: 1 tick の cpuTime は現状 17〜44ms。Free プランの 10ms 上限はバースト許容で通っているが、
  候補SQLを増やすので **tick あたりの実行時間が伸びないか tail で確認する**
- **`apps/web`(Pages) と `apps/worker`(Workers) は別デプロイ**。新フィールドは常に optional 扱いにする

## 5. 失敗モードリスト（痛い順・テスト化の根拠）

| # | 失敗モード | 扱い |
|---|---|---|
| 1 | form CTA 無しのウェビナーで `MIN()` が NULL になり、完走者に「今日で最後」が飛ぶ | **テスト化**（AC-10-7）。⑭で同型を実際に踏んでいる |
| 2 | `is_active` 再有効化で過去の離脱者にバースト送信 | **テスト化**（AC-10-10）。既知の罠 |
| 3 | 期限を過ぎてから送信され、リンク先が死んでいる | **テスト化**（AC-10-1 の境界） |
| 4 | 同一セッションに複数回送信される | **テスト化**（AC-10-6） |
| 5 | 「もう見られません」と書いて事実に反する（週5回開催なので次の回で見られる） | **テスト化**（AC-10-8） |
| 6 | consult ページが視聴セッションを要求して 403 になる | **設計で解決済み**。`resolveWebinarCaller` は idToken のみ（実測確認済み）。AC-9-2 で担保 |
| 7 | consult ページの追加が視聴画面を壊す | **テスト化**（AC-9-7）。既存テスト green の維持 |
| 8 | 予約は入るが Meet が付かない | **テスト化**（AC-9-3）。`salon-book` 経路を使わないことで構造的に回避 |
| 9 | cron が重くなり `exceededCpu` で毎tick死ぬ | **設計に戻す**（非機能要件）。tail で cpuTime を実測してから有効化 |

## 6. 文言の線（外すと嘘になる）

3日で**実際にリンクが切れる**ので希少性は実在する（launch-consult 必須4点「偽の席・偽の値上げ日・
リセットするカウントダウンは出さない」争点 §1 をクリア）。**ただし週5回開催なので、次の回を予約すれば同じ内容を見られる。**

- ✅ 「**このリンクが**今日で閉じます」＝ 事実
- ❌ 「この動画は**もう見られなくなります**」＝ 嘘
- ❌ 「今すぐ」「もう二度と」「急いで」＝ 焦らせる語は LINE 規約の〈謳い文句〉側の翼に寄る
- (a) には**次の回への導線を必ず併記**する（既存 `registered_no_show` の処理と揃える）

**本文の実文は未執筆**（3分岐とも）。UI 文言ではなく配信本文なので `writing-consult` の領分。

## 7. 実装順序（依存関係順）

1. **F-9 を先に作る**（migration 不要・M規模）。F-10 の (c) がこれに依存する
2. F-9 のデプロイと実機確認（AC-9-1〜9-7）
3. **F-10**（migration あり・危険 zone）
4. `journey` への `archive_closing` 追加（AC-10-9）
5. **`is_active` を立てる前に `stage_enabled_at` を今にする**（AC-10-10）
6. tail で cron の cpuTime を確認してから本番有効化

## 8. 受入条件（DoD）

- [ ] `packages/db test` / `apps/worker test` / typecheck（db・worker・web）が **PM 自身の再実行で** green
- [ ] AC-9-1〜9-7 / AC-10-1〜10-10 すべてに対応するテストが存在する
- [ ] 失敗モードリストの #1〜#5, #7, #8 がテストで守られている
- [ ] `COALESCE` を SQL から外すと**実際にテストが落ちる**ことを確認した（外して1回落として戻す）
- [ ] migration 追加後に `pnpm --dir packages/db generate:bootstrap` を実行した
- [ ] **packages/db のテストは `packages/db/test/` 配下に置いた**（vitest の include が test/** 限定）
- [ ] 一次レビュー（fresh Sonnet）で致命・重要が 0
- [ ] 危険 zone のため **fresh Opus max のゲート**を1発通した
- [ ] 実機で AC-9-1 / AC-9-3 を踏んだ

## 9. 未決事項

- **本文の実文**（3分岐）。`writing-consult` を引いてから書く
- **送信時刻 15:00 前後が実際に読まれるか**は測れない。送信時刻の最適解に一次データは無い `[観察]`
  （`2026-0803-send-time-optimum-is-refuted`）。段別カウントで見る
- **`submitted_no_booking_*` を実際に有効化するか**（F-9 完了後の運用判断）
- **legacy cta の掃除**。`eec8dea0` に `showAtSeconds: 2880` / spirinc URL が残っている。
  `webinar_ctas` があるので現在は無視されるが、**カードを消すと48分の位置に spirinc が復活する**時限爆弾

## 10. 参照

- 設計判断の経緯と根拠: `tasks/state.md`「2026-08-28 の決定」節
- 正本（F-1〜F-8）: `tasks/requirements-auto-webinar-funnel.md`
- アーカイブ3日の要件: `tasks/requirements-webinar-archive-window.md`
- 実機E2E: `tasks/_review/webinar-e2e-checklist.html`（gitignore・無ければ再生成）
