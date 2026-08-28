# 要件定義書 v2｜案内の再送時刻（F-9）＋ セッション選択の3日先送り（F-10）＋ アーカイブ期限リマインド（F-11）

作成: 2026-08-28（v2） / 正本 `tasks/requirements-auto-webinar-funnel.md` の続き（F-1〜F-8 の続き番号）
状態: **未着手**。設計判断の経緯は `tasks/state.md` の「2026-08-28 の決定」節が正本。

> **v1 からの改訂点**（v1 全文は commit `3bf4f32`）
> - **v1 の F-9「相談枠ピッカーの単体ページ `page=consult` を新設」は却下。** 前提が2つとも誤りだった（下記 §10-1）
> - **C-1「案内を特典応答から外して翌日 push に移す」はユーザー決定で取り消し**（2026-08-28 夕方）。
>   2バブル目の flex カードは応答メッセージ＝**0通**で配れているため残す。採用するのは **C-2（時刻 19:00）だけ**
> - Grok spec レビューの致命1・重要12・軽微4を反映。テーブル名・CHECK 制約・UNIQUE キー・
>   候補SQL の分岐位置・期待ステータスの誤りを訂正した

---

## 1. 目的・背景

### 何が問題か

ウェビナーを**最後まで見た人＝一番濃い層**に、何も飛んでいない。

| 到達段階 | いま飛ぶもの | タイミング |
|---|---|---|
| 案内リンク未クリック | シナリオ `5202064a` | 翌日 18:30 |
| 選択画面を開いたが未予約 | `picker_no_registration` | 30分後 |
| 予約したが未視聴 | `registered_no_show` | 配信終了30分後 |
| 視聴したが CTA 前で離脱 | 同上（本文を出し分け） | 同上 |
| **CTA まで見たが押していない** | **無風** | — |
| CTA を押してフォーム未送信 | `after_30m` / `after_24h` | 30分後 / 翌日 |
| フォーム送信・予約未確定 | `submitted_no_booking_*` | 無効化中（`booking_url = NULL`） |

**穴の正体**: `buildRegisteredNoShowText` は `lastPosition >= ctaAt` のとき **`null` を返して送らない**
（`webinar-followups.ts:88-90`）。一方 `after_30m` / `after_24h` の候補SQLは **`v.cta_clicked_at IS NOT NULL`**
が必須（`:177`）。→ **49:57 まで見たのに CTA を押さなかった人は、どちらの網にも入らない。**

もう1つ、**アーカイブが3日で切れることを誰にも伝えていない**。`ARCHIVE_WINDOW_DAYS = 3`
（`webinar-schedule.ts:11`）で実際にリンクは閉じるのに、閉じる前の告知が無い。

### 併せて直す2つ

- **案内の再送が 18:30**。夕食どきに重なる。19:00 に寄せる（C-2）
- **セッション選択に当日・翌日の回が出る**。申し込みから視聴までの猶予が無く、
  「今夜20時」を選んだ人がそのまま来ない（C-3）

## 2. スコープ

### やる

- **F-9**: シナリオ `5202064a`（案内の再送）の配信時刻を 18:30 → **19:00** に変更（DB 設定のみ・コード変更なし）
- **F-10**: セッション選択に出る回を **`now + 3日` 以降**に限定（サーバー1点＋表示条件の手当て）
- **F-11**: 旅程ステージ `archive_closing` を1つ追加。**アーカイブ期限の6時間前に1回だけ**、視聴の進み具合で本文を3分岐

### やらない（Out of scope）

- **相談枠ピッカーの単体ページ `page=consult` の新設** — 不要と確定（§10-1）
- **特典応答の2バブル目（flex カード）の削除** — ユーザー決定で取り消し。**触らない**
- **シナリオ `5202064a` の `tag_not_exists` を外して全員に送る（C-4）** — 同上。未クリック者限定のまま
- `submitted_no_booking_*` の解禁（`booking_url` は NULL のまま）。F-11 の実測を見てから別途判断
- 実在コメントの相互表示（同時視聴者が数人になってから）
- `registerSession` の契約変更（予約成功なのに `load()` 失敗で「送信に失敗しました」と出る既存の穴）

### 前提（実コードで確認済み・仮定ではない）

| # | 事実 | 出典 |
|---|---|---|
| P-1 | 相談枠 API は **フォーム未送信だと 403 `form_required`** | `services/webinar-consultation-booking.ts:113-121` |
| P-2 | `?page=form&id=<相談フォームID>` は**送信後その場で枠選択に進む** | `client/form.ts:1093-1096` / `routes/forms.ts:126-147` |
| P-3 | 追客本文に `page=form` を載せる**前例がある**（`formUrl`） | `webinar-followups.ts:63-67`, 呼び出し `:485-486` |
| P-4 | 本番 LIFF は worker 内蔵クライアント。`?page=form` を処理する | `wrangler.toml:13-20` / `client/main.ts:702-705` |
| P-5 | `ARCHIVE_WINDOW_DAYS = 3` / `LOOKAHEAD_DAYS = 8` | `services/webinar-schedule.ts:6,11` |
| P-6 | 旅程ステージのテーブルは **`webinar_journey_followups`**（`webinar_followups` ではない） | `webinar-followups.ts:267-270,330-334` |
| P-7 | `kind` に **CHECK 制約**（既存4値のみ）。SQLite は CHECK を ALTER できない | `060_webinar_journey_followups.sql:37-42` |
| P-8 | UNIQUE は **`(webinar_id, friend_id, kind)`**。session を含まない | 同 `:50` |
| P-9 | 候補SQLは **ループ前に全部 await**。1本が throw すると その tick の追客が全滅 | `webinar-followups.ts:446-463` |
| P-10 | 新規予約の成功ステータスは **201** | `routes/webinars.ts:707` / `webinars.test.ts:917` |

## 3. 機能要件と受け入れ条件

危険 zone（migration）を含むため **AC は EARS 形式**（When … , the system shall …）で書く。

### F-9 案内の再送時刻を 19:00 にする

**変更はシナリオ `5202064a` の step 1 のみ。コードは触らない。**

- **AC-9-1**: When `GET /api/scenarios/5202064a` を叩いたとき, the system shall step 1 の
  `deliveryTime = "19:00"` / `offsetDays = 1` を返す
  検証: `curl -sH "Authorization: Bearer $KEY" .../api/scenarios/5202064a | jq '.steps[0] | {offsetDays, deliveryTime}'`
  → `{"offsetDays":1,"deliveryTime":"19:00"}`
- **AC-9-2**: When 同じ step を見たとき, the system shall `conditionType = "tag_not_exists"` /
  `conditionValue = "d780e7e7-6335-49b3-9490-ddaa338b83bc"`（ウェビナー案内クリック）を**保ったまま**返す
  ＝ **C-4 は実行しない**。未クリック者限定を維持する
- **AC-9-3**: When `GET /api/auto-replies/d8f05c9e...` を叩いたとき, the system shall
  `responseType2 = "flex"` を返す ＝ **2バブル目を消していない**こと

> `absolute_time` の step は **`offsetDays` + `deliveryTime` のみ**許可。`delayMinutes` / `offsetMinutes` を
> 混ぜると 400（`routes/scenarios.ts` `validateStepSchedule:149-158`）。
> 条件のキーを**省略すると既存条件が残る**ので、変更するのは時刻だけにする。

### F-10 セッション選択に出る回を `now + 3日` 以降にする

**生成はサーバー1点** — `upcomingSessions`（`services/webinar-schedule.ts:116-126`）のフィルタ
`s > nowEpochSeconds` を `s >= nowEpochSeconds + REGISTRATION_LEAD_SECONDS` に変える。

- **AC-10-1**: When ピッカーが回の一覧を組み立てるとき, the system shall
  **開いた時刻から72時間より後**に始まる回だけを返す
  検証: `upcomingSessions` の**新規単体テスト**（現状ゼロ）。週5回20時のルールで `now = 月曜12:00` を与え、
  返り値の先頭が **木曜20:00 以降**であること
- **AC-10-2**: When 3日以内の回の `sessionStartAt` を `POST /api/liff/webinars/:slug/register` に渡したとき,
  the system shall **400 `invalid_session`** を返す（`routes/webinars.ts:510-518` が同じ配列で受理判定するため、
  自動的にそうなる。**意図どおりであることをテストで固定する**）
- **AC-10-3**: When 週5回（月・水・金・土・日 20:00）の設定でピッカーを開いたとき, the system shall
  **最低5件**の回を返す
  → `LOOKAHEAD_DAYS = 8` のままだと 3日切り捨て後に**5日分しか残らない**。
  **`LOOKAHEAD_DAYS` を 11 に延ばす**（8 + 3）。定数の意味が「先読み日数」なので、
  リード日数を足した値にする理由をコメントに残す
- **AC-10-4**: When 予約済みの利用者が画面を開き、かつ選べる回が0件だったとき, the system shall
  **予約済みカードを表示する**（待機画面に落とさない）
  → 現状の分岐条件は `!state.live && (state.upcoming?.length ?? 0) > 0`（`client/webinar/main.tsx:796`）。
  **`… || state.registeredSessionAt !== null` を足す**。あわせて枠リストが空のときの見た目を決める
  （予約済みカードだけを出し、「選べる回はまだありません」を添える）
- **AC-10-5**: When 入場リンクから視聴するとき / アーカイブを再生するとき, the system shall
  **これまでどおり再生できる**（`upcomingSessions` を通らない経路）。
  検証: `routes/webinars.test.ts` の既存テスト（`256,273,301,392,421`）が green のまま
- **AC-10-6**: When 開始5分以内の「現在回」があるとき, the system shall
  **これまでどおりそれを返す**（`webinars.ts:325-327` の別経路。3日フィルタの外）

> リード時間は**定数として1箇所に置く**（`REGISTRATION_LEAD_DAYS = 3`）。本文・テスト・
> `LOOKAHEAD_DAYS` の3箇所がこの定数から導出されること。ハードコードした数字を散らさない。

### F-11 アーカイブ期限リマインド `archive_closing`

**アーカイブ期限の6時間前に1回だけ。** ②「今日で最後です」と③「見た人に無料相談」は
どちらも「アーカイブ窓が閉じる前」という同じ時間軸なので、**ステージを2つに割らない**
（`registered_no_show` で確立済みの「ステージは増やさず視聴の進み具合で本文を出し分ける」パターン）。

**送信時刻**: `session_start_at + duration_seconds + ARCHIVE_WINDOW_SECONDS - 6h`。
20:57 終了なら3日後の 14:57 頃。**送信時刻の最適解に一次データは無い**
（`2026-0803-send-time-optimum-is-refuted`・Braze が自社データで反証）`[観察]`。
根拠は「今日で最後だと言えて、かつ夕方〜夜に57分を見返す時間が残る」という構造だけ。

**母数（誰に送るか）**: 予約済み（`webinar_registrations` に行がある）かつ、
**まだ相談に進んでいない人**。「進んでいない」の定義は下の3分岐で確定させる。

**本文の3分岐**（`webinar_viewers.last_position_seconds` と `webinar_ctas` の `kind='form'` の
最小 `at_seconds` で判定。**CTA 位置はハードコードしない**）:

| 分岐 | 条件 | 送るもの |
|---|---|---|
| **(a) 未視聴** | `webinar_viewers` に行が無い、または `last_position_seconds = 0` | 期限告知 ＋ 入場リンク ＋ **別の回を選び直す導線** |
| **(b) 途中離脱** | `0 < last_position < COALESCE(MIN(cta.at_seconds), 0)` | 「終盤が残っています」＋ 期限 ＋ 入場リンク |
| **(c) 完走・CTA未クリック** | `last_position >= COALESCE(MIN(cta.at_seconds), 0)` かつ `cta_clicked_at IS NULL` | **無料相談のリンクだけ**（`?page=form&id=<相談フォームID>`） |

**除外**: `cta_clicked_at IS NOT NULL` の人は**送らない**。`after_30m` / `after_24h` の母数
（`webinar-followups.ts:177`）と重なり、期限前にもう1通行くため。

- **AC-11-1**: When 予約済み・未視聴の friend について送信時刻を過ぎたとき, the system shall
  `kind = 'archive_closing'` の行を `webinar_journey_followups` に1件だけ作り、(a) の本文を送る
- **AC-11-2**: When 視聴位置が form CTA の `at_seconds` 未満の friend について送信時刻を過ぎたとき,
  the system shall (b) の本文を送る
- **AC-11-3**: When 視聴位置が form CTA 以上で、かつ `cta_clicked_at` が NULL の friend について
  送信時刻を過ぎたとき, the system shall (c) の本文を送り、本文に
  `https://liff.line.me/<liffId>/?page=form&id=<相談フォームID>&liffId=<liffId>` を含める
- **AC-11-4**: When `cta_clicked_at` が NULL でない friend を評価したとき, the system shall
  `archive_closing` の行を**作らない**
- **AC-11-5**: When form CTA を持たないウェビナーを評価したとき, the system shall
  **例外を投げず**、視聴済みの人を (c) ではなく (a)/(b) 側で扱う
  → 閾値は `COALESCE(MIN(wc.at_seconds), 0)`。**`COALESCE` を落とすと `>= NULL` が NULL に評価されて
  沈黙故障する**（2026-08-27 に1度踏んでいる）。SQL 文字列を縛るアサーションをテストに入れる
  （モックだと SQL が壊れても green のため）
- **AC-11-6**: When 同じ friend × 同じウェビナーで2回目の予約をしたとき, the system shall
  `archive_closing` を**もう送らない**
  → UNIQUE は `(webinar_id, friend_id, kind)` で **session を含まない**（P-8）。
  **これは仕様として受け入れる**（1ウェビナーにつき生涯1回）。v1 の AC は「friend × webinar × session」と
  書いていたが、そのままでは2回目の予約回で INSERT が弾かれて**1通も送れない**
- **AC-11-7**: When `archive_closing` の候補SQLが例外を投げたとき, the system shall
  **他の kind の追客を通常どおり送る**
  → `journeyDue` は4本を順に await してスプレッド（`webinar-followups.ts:450-463`）＝
  **1本 throw すると後続 kind が走らない**。候補取得を `Promise.allSettled` か個別 try/catch に変える
- **AC-11-8**: When `GET /api/webinars/:id/analytics` を叩いたとき, the system shall
  `journey` に `archive_closing` の件数を含める
  → `isWebinarJourneyFollowupKind`（`packages/db/src/webinars.ts:447-453`）に足す。
  **ここに無い kind は集計から黙って捨てられる**ので、0件と沈黙故障を区別できなくなる
- **AC-11-9**: When 既存の4ステージ（`picker_no_registration` / `registered_no_show` /
  `after_30m` / `after_24h`）の候補を評価したとき, the system shall **これまでと同じ母数**を返す
  → 新 kind の専用分岐を **else の前**に置く。else は `submitted_no_booking_*`
  （`webinar-followups.ts:341-390`）なので、専用 `if` が無いと母数が「フォーム送信済み・未予約」になり
  **AC-11-1 の逆**になる

**通数への影響（承知のうえ）**: 未視聴者は `registered_no_show`（配信終了30分後）と
`archive_closing`（3日後）の**2通を受け取る**。ステージ排他ではない — 前者は「見逃し」、後者は「期限」で
役割が違うため意図的に重ねる。1人あたり最大 **4通 → 5通**。
ブロック理由1位は「配信頻度が多すぎる」26.5%（モビルス・2025・n=655）`[実証]`。
ただし同 atom の Baek et al. が示すのは、頻度を下げると**解約59%減・短期売上5〜8%減**という
**トレードオフ**であって「送らない＝無料の安全策」ではないこと（メールの数値なので**構造だけ転用**）。
**通数に正解は存在しない** `[実証・該当なしの確認]`（`2026-0803-no-public-data-on-step-completion`）。
→ 段別カウントで測る（AC-11-8）。

## 4. 配信本文（実文）

**本文が無いと AC-11-1〜3 は検証できない**ので先に確定させる。`{}` は実装時に差し込む値。

### (a) 未視聴

```
ご予約いただいた「{title}」の入場リンクは、本日 {期限時刻} で閉じます。

まだご覧になっていなければ、それまでにどうぞ👇
{入場リンク}

見る時間が取れないときは、別の回に申し込み直せます。
同じ内容を、月・水・金・土・日の20時から開催しています👇
{ピッカーURL}

※約57分です。カメラ・マイクは使いません。
```

### (b) 途中離脱

```
「{title}」の続きが見られるのは、本日 {期限時刻} までです。

いちばんお伝えしたいのは終盤です。
Xを仕事につなげるために、最後に何から手をつけるかの話をしています。

続きはこちらから👇
{入場リンク}

※残りは約{n}分です。
```

### (c) 完走・CTA未クリック

```
「{title}」を最後までご覧いただき、ありがとうございました。

終盤でご案内した無料相談は、こちらから申し込めます👇
{相談フォームURL}

tatsukiが45分、実際にあなたのXアカウントを見ながら、
いまどこが詰まっているかを一緒に整理します。料金はかかりません。

※日程は、フォームを送信したあとその場で選べます。
```

**(c) に期限を書かない理由**: 閉じるのは**アーカイブのリンク**であって、相談枠ではない。
完走した人にとって「今日で最後」なのは動画だけで、相談は明日でも申し込める。
**実在しない期限を書けば嘘になる**（争点マップ §3-1「希少性・限定性の演出 × 景品表示法」——
分かれ目は「表示している希少性が実在する事実に基づくか」の一点で、**法令が優先し技術論に落とさない**）。

**「日程はフォーム送信後に選べます」を必ず書く理由**: フォームだけ出して枠に進めないと最悪の体験になる。
実際には送信後その場で枠選択に進む（P-2）ので、**先に言っておけば期待とズレない**。

## 5. 文言の線（外すとルール違反または嘘になる）

| 判定 | 表現 | 理由 |
|---|---|---|
| ✅ | 「**このリンクが**本日 20:57 で閉じます」 | 事実。`ARCHIVE_WINDOW_DAYS = 3` で実際に閉じる |
| ✅ | 期限を**具体的な日時**で書く | 「期間限定」のような曖昧語より機能する（第二の脳: "限定期間オファーの期限は具体的な日時で明確に切る" `[伝聞]` / 14-offer-pricing）。**ただし約束した期限を守らないと信頼を失う**と同エントリが警告 |
| ❌ | 「この動画は**もう見られなくなります**」 | **嘘**。週5回開催なので次の回で見られる |
| ❌ | 「今すぐ」「もう二度と」「急いで」「残りわずか」 | 実在しない緊急性。第二の脳: "緊急性・限定性は正直な範囲でのみ使う" `[実測]` / 16-objection-proof-cta —— 虚偽の緊急性は**信頼を永続的に損なう** |
| ❌ | 見なかった場合の結末を煽る | 恐怖訴求は**対処法とセットでないと逆効果**（防御的回避）。メタ分析でも効果量は小さい d=0.29（Tannenbaum et al. 2015, 248研究。争点マップ §2-2「煽り（Agitation・恐怖訴求）か、寄り添い（Affinity）か」） |
| ✅ | (a) に**次の回への導線を併記** | 既存 `registered_no_show` が「都合のよい回に選び直せます」と正直に処理しているのと同じ整理 |
| ✅ | **1通1CTA** | (a) だけリンクが2本（入場・ピッカー）になるが、これは「見る」と「選び直す」で**排他の選択肢**。同一行動への競合ではない（第二の脳: "1通1メッセージ・単一CTAの原則で配信を組み立てる" `[観察]` / 08-media-specific） |

**規約リスクは増えない** `[公式]`（`2026-0803-guideline-bans-the-pitch-not-the-business`）。
禁じられているのは〈儲かる系 or 簡易性の謳い文句〉＋〈誘導〉の**型**で、期限の告知そのものは謳い文句ではない。
同 atom の 2026-08-27 追記が「**判定単位はメッセージではなく導線。分割は回避策にならない**」と記録しているとおり、
1通足しても導線の性質は変わらないのでリスクは増えも減りもしない。

## 6. 非機能要件・実装制約

- **migration が要る**（`kind` の CHECK に `archive_closing` を足す）。SQLite は CHECK を ALTER できないので
  **テーブル作り直し**。＝ **危険 zone**。追番は本体取り込みと衝突しないか採番前に確認する
- **`is_active` を 0→1 に戻すと `stage_enabled_at` が古いままで過去の離脱者にバースト送信**（既知の罠）。
  新ステージも同じ構造なので、**有効化前に `stage_enabled_at` を必ず今にする**
- 期限の計算は `session_start_at + duration_seconds + ARCHIVE_WINDOW_SECONDS - 6h`。
  `ARCHIVE_WINDOW_DAYS` は定数から引く（**ハードコードしない**）
- 相談フォームの URL は `formUrl`（`webinar-followups.ts:63-67`）を流用する。**未 export なので
  同ファイル内に置くか export する**。liffId の解決順は ①ウェビナーの `account_id` → `line_accounts.liff_id`
  ②`options.defaultLiffId` ③cron が `env.LIFF_URL` から抽出。**どちらも無いと throw**（`:484`）
- 送信ループ側（`:511-575`）は候補ごと try/catch なので、止まるのは**候補取得の段階だけ**（AC-11-7）
- 既存テストを壊さない: `apps/worker test` 102 files / 1054 tests・`packages/db test` 24 files / 168 tests
- **`packages/db` のテストは `test/` に置く**（vitest の include が `test/**` 限定。`src/*.test.ts` は走らない）

## 7. 失敗モードリスト（痛い順・テスト化の根拠）

| # | 失敗モード | 痛み | 扱い |
|---|---|---|---|
| 1 | 新 kind の INSERT が CHECK で弾かれ、cron がその tick ごと落ちる | **全追客が停止** | migration ＋ AC-11-7 |
| 2 | 候補SQLの throw で既存4ステージが送られなくなる | **全追客が停止** | AC-11-7（`allSettled`） |
| 3 | 専用分岐を else の後に置き、母数が「フォーム送信済み・未予約」になる | **狙いと逆の人に送る** | AC-11-9 |
| 4 | `COALESCE` 落ちで CTA 無しウェビナーが沈黙故障 | 誤配信 | AC-11-5（SQL 文字列アサーション） |
| 5 | `stage_enabled_at` が古く、過去の離脱者に**バースト送信** | **通数枯渇＋ブロック** | §6 の運用手順 |
| 6 | `now+3日` で upcoming が空になり、予約済みの人が待機画面に落ちる | 予約が消えたように見える | AC-10-4 |
| 7 | `LOOKAHEAD_DAYS` 据え置きで選べる回が1〜2件に減る | 選べない | AC-10-3 |
| 8 | `cta_clicked_at` 済みを除外し忘れ、`after_24h` と二重に届く | 通数の無駄・不信 | AC-11-4 |
| 9 | 2回目の予約で UNIQUE に弾かれ、1通も送れない | 沈黙故障 | AC-11-6（仕様として明記） |
| 10 | 段別カウントに kind を足し忘れ、0件と故障を区別できない | 計測不能 | AC-11-8 |

## 8. 実装順序（依存関係順）

1. **F-9**（シナリオ時刻 19:00）— DB のみ・独立・すぐ出せる
2. **F-10**（`now + 3日`）— コードだが小さい。**F-11 の (a) 本文が「別の回」を勧めるので先に入れる**
3. **F-11**（`archive_closing`）— migration あり・危険 zone。最後

## 9. 受入条件（DoD）

- [ ] AC-9-1〜3 / AC-10-1〜6 / AC-11-1〜9 が**すべて**検証コマンドで pass
- [ ] `apps/worker test` / `packages/db test` / `typecheck` / `build` が green（**PM 自身が再実行**）
- [ ] negative case 3件以上（CTA 無しウェビナー / 2回目の予約 / 候補SQL throw）
- [ ] 独立レビュー（fresh Sonnet）の致命・重要が 0
- [ ] migration があるので **fresh Opus max のゲートを1発**通す
- [ ] 有効化の直前に `stage_enabled_at` を現在時刻に更新した記録がある
- [ ] 本番投入後、`GET /api/webinars/:id/analytics` の `journey` に `archive_closing` が出ることを実測

## 10. 却下した設計と、その理由

### 10-1. F-9（v1）「相談枠ピッカーの単体ページ `page=consult` を新設」→ **却下**

v1 の前提が2つとも誤っていた。

- **誤り1「idToken だけで枠が出る」**: `resolveWebinarCaller`（`routes/webinars.ts:131-144`）は確かに
  idToken だけで friendId を解決するが、**その先の `loadContext` に別のゲートがある**。
  相談フォーム未送信なら **403 `form_required`**（P-1）。(c) の対象は定義上フォーム未送信なので、
  consult ページを作ってリンクを送っても**開けない**。PM が `resolveWebinarCaller` だけ読んで確定扱いにしたのが原因
- **誤り2「`page=form` は送信すると『送信完了』で終わる」**: 参照した `client/form.ts:659` は
  **汎用フォームの成功画面**で別経路。実際は `consultationWebinarSlug` があれば
  `renderConsultationBooking` を呼ぶ（P-2）。相談フォーム `95a1355f` は解決条件を満たす

→ **`?page=form&id=<相談フォームID>` を送るだけで、記入 → 送信 → 枠選択 → 予約確定まで繋がる。
送信した時点で `form_required` も自然にクリアされる。実装ゼロ。**

**既に送信済みの人が再度開いたとき**（確認済み）: 「送信済みです」ガードは無く、空フォームが再表示され、
再送信すると `form_submissions` に**行が増える**（upsert ではない）。ただし既存予約が `confirmed` かつ
`meetUrl` 有りなら「個別相談が確定しました」で止まり、サーバー側も `created:false` で既存を返す。
→ **二重予約にはならない。** 唯一の穴は既存が `requested` 止まりのときで、確定時に 409。

### 10-2. C-1「案内を特典応答の2バブル目から外し、翌日 push に移す」→ **ユーザー決定で取り消し**

応答メッセージ（Reply API）は**課金対象外**なので、案内はいま **0通で配れている**。
翌日 push に移すと**課金1通 × 全員分**が乗る。残枠 約2,000通 `[実測]`、分母の月間新規特典請求者数は**未実測**。
→ カードは残し、**未クリック者への再送（既存シナリオ）の時刻だけ 19:00 に変える**。通数の増分ゼロ。

### 10-3. 一般予約経路 `page=salon-book` を使う → **却下（既知）**

`addGoogleMeet` の分岐に乗らず Meet が付かない。リマインドも2時間前になり、録画 57:06 の
「通話のリンクは自動で発行されて、事前にLINEでリマインドが届きます」と食い違う。
一律 ON にすると他2アカウント（クラファン／サガリ藤）の予約全部に波及する。

### 10-4. `archive_closing` を「期限2時間前」「12時間前」に送る → **却下**

2時間前は57分の動画を見返す時間が残らない。12時間前は「本日で最後」と書けず切れ味が落ちる。

## 11. 未決事項

- **`archive_closing` の送信が実際に読まれるか**は測れない（送信時刻の一次データ無し `[観察]`）。
  段別カウント（AC-11-8）で見る
- **`submitted_no_booking_*` の解禁**。`page=form` で戻り導線ができたので技術的には解けるが、
  F-11 の実測を見てから判断する
- **旧 install 向けの Cloudflare Pages（`apps/liff/`）が生きている環境**では、
  同じ URL が `/booking` に落ちる（`apps/liff/src/legacy-route.ts:39-42`）。
  **本番は worker 内蔵クライアントなので影響なし**（P-4）が、他アカウントに展開するときは確認が要る

## 12. 参照

- `tasks/state.md` — 決定の経緯（正本）
- `tasks/requirements-auto-webinar-funnel.md` — F-1〜F-8（正本）
- `tasks/webinar-copy-and-config.md` — 既存の文言・設定値
- v1 全文 — commit `3bf4f32`
