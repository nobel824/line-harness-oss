# 要件定義書 v3｜案内の再送時刻（F-9）＋ セッション選択の3日先送り（F-10）＋ アーカイブ期限リマインド（F-11）

作成: 2026-08-28（v3） / 正本 `tasks/requirements-auto-webinar-funnel.md` の続き（F-1〜F-8 の続き番号）
状態: **未着手**。設計判断の経緯は `tasks/state.md` の「2026-08-28 の決定」節が正本。

> **v1 からの改訂点**（v1 全文は commit `3bf4f32`）
> - **v1 の F-9「相談枠ピッカーの単体ページ `page=consult` を新設」は却下。** 前提が2つとも誤りだった（下記 §10-1）
> - **C-1「案内を特典応答から外して翌日 push に移す」はユーザー決定で取り消し**（2026-08-28 夕方）。
>   2バブル目の flex カードは応答メッセージ＝**0通**で配れているため残す。採用するのは **C-2（時刻 19:00）だけ**
> - Grok spec レビュー（1回目）の致命1・重要12・軽微4を反映。テーブル名・CHECK 制約・UNIQUE キー・
>   候補SQL の分岐位置・期待ステータスの誤りを訂正した
>
> **v3（2026-08-28・Grok spec レビュー2回目を反映。致命8・重要9を全件採用）**
> 1. **閾値の `COALESCE(..., 0)` は除外側の式で、入口に転用すると意味が反転する** —— CTA 無しウェビナーで
>    視聴者全員が (c) に落ち、`form_id` が無いので URL を組めない。3分岐を排他かつ網羅に書き直した
> 2. **CTA クリックの除外は friend × ウェビナー単位**。session 単位だと `after_24h` と二重になる
> 3. **入場リンクは `buildWebinarUrl`（session 付き）**。ピッカー URL では再生できない
> 4. **F-10 は既存テストを壊すのが正しい** —— 「更新する3箇所」と「守る2箇所」を分けた
> 5. **AC の検証コマンドが `.data` を通していなかった** —— 実装が正しくても fail する AC だった
> 6. **`stage_enabled_at` の下限を候補SQLに入れる**（運用手順だけでは効かない）
> 7. **migration は 075 から**（060 を書き換えても適用済み D1 は変わらない）＋ bootstrap 再生成
> 8. **AC-11-8（migration 前の INSERT）を新設**。`getOrCreateJourneyFollowup` は送信ループの try の外にある

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
| CTA を押してフォーム未送信 | `after_30m` / `after_24h`（**別テーブル `webinar_followups`**） | 30分後 / 翌日 |
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
| P-10 | `POST .../register` の成功は **200 `{ ok, sessionStartAt, created }`**（`routes/webinars.ts:543`）。201 は**相談枠の `consultation-book`**（`:707`）で別物 | 実コード |

## 3. 機能要件と受け入れ条件

危険 zone（migration）を含むため **AC は EARS 形式**（When … , the system shall …）で書く。

### F-9 案内の再送時刻を 19:00 にする

**変更はシナリオ `5202064a` の step 1 のみ。コードは触らない。**

- **AC-9-1**: When `GET /api/scenarios/5202064a` を叩いたとき, the system shall step 1 の
  `deliveryTime = "19:00"` / `offsetDays = 1` を返す
  検証: `curl -sH "Authorization: Bearer $KEY" .../api/scenarios/5202064a | jq '.data.steps[0] | {offsetDays, deliveryTime}'`
  → `{"offsetDays":1,"deliveryTime":"19:00"}`
  **レスポンスは `{ success, data: { steps } }` で包まれている**（`routes/scenarios.ts:222-227`）。
  `.steps[0]` と書くと**実装が正しくても null になって fail する**。AC-9-3 の `/api/auto-replies/:id` も同じ
  （`routes/auto-replies.ts:154`）
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
**境界は `>=` を正とする**（ちょうど72時間後の回は出す）。テストの期待値もこれで固定し、
実装とテストのどちらが仕様かで割れないようにする。

- **AC-10-1**: When ピッカーが回の一覧を組み立てるとき, the system shall
  **開いた時刻の72時間後ちょうど以降**に始まる回だけを返す
  検証: `upcomingSessions` の**新規単体テスト**（現状ゼロ）。週5回20:00・`now = 月曜12:00` で先頭が木曜20:00。
  **境界を2件置く**: ちょうど `now + 72h` の回は**含む** / その1秒手前は**含まない**
- **AC-10-2**: When 3日以内の回の `sessionStartAt` を `POST /api/liff/webinars/:slug/register` に渡したとき,
  the system shall **400 `invalid_session`** を返す。
  **ただし開始5分以内の「現在回」は例外**で、これまでどおり受理する
  → `currentIsBookable` が `upcoming.includes` の**前段**にある（`routes/webinars.ts:511-518`・猶予定数 `:78`）。
  **「3日以内なら常に400」とテストを書くと、正しい実装が fail する**
- **AC-10-3**: When 週5回（月・水・金・土・日 20:00）の設定でピッカーを開いたとき, the system shall
  **最低5件**の回を返す
  → `LOOKAHEAD_DAYS = 8` のままだと3日切り捨て後に**5日分しか残らない**。**11 に延ばす**（8 + 3）。
  コメントの更新対象は `webinar-schedule.ts:6` と `:66`（「未来 8 日」）の**両方**
- **AC-10-4**: When 予約済みの利用者が画面を開き、かつ選べる回が0件だったとき, the system shall
  **予約済みカードを表示する**（待機画面に落とさない）
  → 分岐条件は `!state.live && (state.upcoming?.length ?? 0) > 0`（`client/webinar/main.tsx:797`。796 はコメント行）。
  **`… || state.registeredSessionAt !== null` を足す**。あわせて枠リストが空のときの見た目を決める
  （予約済みカードだけを出し、「選べる回はまだありません」を添える）
- **AC-10-5**: 既存テストは **「更新するもの」と「守るもの」を分ける**。
  **更新する**（仕様変更なので落ちるのが正しい・落ちなければ F-10 が効いていない）:
  `routes/webinars.test.ts:392` / `:421`（開始1時間前・10分前のピッカーが `upcoming: [SESSION_START]` を期待）、
  `:848-858`（開始1時間前の register が 200 を期待。AC-10-2 で 400 になる）。
  スケジュールは once 1本（`:68-80`）なので、**リード日数を跨ぐ固定値に作り替える**。
  **守る**（F-10 の影響を受けない・green のままでなければ回帰）:
  `:306` / `:328`（`replay: true` + `playlistUrl` のアーカイブ再生）
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

#### 母数と3分岐（排他かつ網羅）

閾値 **T = そのウェビナーの form CTA の最小 `at_seconds`**（`webinar_ctas.kind='form'`）。**form CTA が無ければ T は NULL**。
`pos = webinar_viewers.last_position_seconds`（`NOT NULL DEFAULT 0`）。

| 分岐 | 条件 | 送るもの |
|---|---|---|
| **(a) 未視聴** | viewer 行が無い、**または** `pos = 0` | 期限告知 ＋ 入場リンク ＋ **別の回を選び直す導線** |
| **(b) 途中離脱** | `pos > 0` **かつ**（`T IS NULL` **または** `pos < T`） | 「終盤が残っています」＋ 期限 ＋ 入場リンク |
| **(c) 完走・CTA未クリック** | `T IS NOT NULL` **かつ** `pos >= T` **かつ** その friend × ウェビナーで `cta_clicked_at` が**1度も付いていない** | **無料相談のリンクだけ**（`?page=form&id=<form_id>`） |

**閾値に `COALESCE(MIN(at_seconds), 0)` を使ってはいけない。** 既存の `COALESCE(..., 0)`
（`webinar-followups.ts:298-304`）は **除外側**の式で、意味が逆。入口に転用すると CTA 無しのとき T=0 になり、
**(b) が空集合・viewer 行がある人全員が (c) に落ちる**。しかも (c) は相談フォームの URL が必須なのに
form CTA が無ければ `form_id` が無く、URL を組み立てられない。
→ **form CTA が無いウェビナーでは (c) は成立しない**（視聴者は (b) に入る）。

**除外は friend × ウェビナー単位で見る。** `webinar_viewers.cta_clicked_at` は
`(webinar_id, friend_id, session_start_at)` の行に付く（`packages/db/src/webinars.ts:304-317`）。
**session 単位で除外を書くと**、1回目でCTAを押した人が2回目を予約して未視聴のとき (a) に入り、
friend 単位で母数を取る `after_30m` / `after_24h`（`webinar-followups.ts:173-177`）と**二重になる**。

**候補SQLに `form_id` を SELECT する。** (c) の URL は `formUrl` と同じ形だが、`JourneyCandidate`
（`webinar-followups.ts:38-49`）は `form_id` を持たない（CTA 追客側の `candidates()` は `:183-185` で取っている）。
足さないとハードコードか `booking_url` 流用に流れる。

**`stage_enabled_at` の下限を候補SQLに入れる。** 既存の journey SQL は
`datetime(r.created_at) >= datetime(COALESCE(cfg.stage_enabled_at, cfg.enabled_at))`（`:284`）を持つ。
**この行をコピーしないと、有効化した瞬間に過去の予約者へバースト送信される。**
§6 の運用手順（有効化前に `stage_enabled_at` を今にする）は、SQL が参照して初めて効く。

#### 受け入れ条件

- **AC-11-1**: When 予約済み・(a) の条件を満たす friend について送信時刻を過ぎたとき, the system shall
  `kind = 'archive_closing'` の行を `webinar_journey_followups` に1件だけ作り、(a) の本文を送る
- **AC-11-2**: When (b) の条件を満たす friend について送信時刻を過ぎたとき, the system shall (b) の本文を送る
- **AC-11-3**: When (c) の条件を満たす friend について送信時刻を過ぎたとき, the system shall (c) の本文を送り、
  本文に `https://liff.line.me/<liffId>/?page=form&id=<form_id>&liffId=<liffId>` を含める
- **AC-11-4**: When その friend × ウェビナーで `cta_clicked_at` が1つでも非 NULL のとき, the system shall
  session を問わず `archive_closing` の行を**作らない**
- **AC-11-5**: When form CTA を持たないウェビナーを評価したとき, the system shall **例外を投げず**、
  viewer 行がある人を **(b)** として扱い、**(c) を1件も作らない**
  検証: form CTA 無しのフィクスチャで候補SQLを実行し、(c) 用の分岐が0件・(b) が該当件数であること。
  **SQL 文字列に `COALESCE(MIN(...), 0)` が現れないこと**をアサーションで縛る（モックだと SQL が壊れても green のため）
- **AC-11-6**: When 同じ friend × 同じウェビナーで2回目の予約をしたとき, the system shall
  `archive_closing` を**もう送らない**
  → UNIQUE は `(webinar_id, friend_id, kind)` で session を含まない（P-8）。
  **1ウェビナーにつき生涯1回**を仕様として受け入れる。v1 の AC は「friend × webinar × session」と書いていたが、
  そのままでは2回目の予約回で INSERT が弾かれて**1通も送れない**
- **AC-11-7**: When `archive_closing` の候補SQLが例外を投げたとき, the system shall
  **他の kind の追客を通常どおり送る**
  → `journeyDue` は4本を順に await して配列リテラルにまとめる（`webinar-followups.ts:450-463`）＝
  **1本 throw すると配列が完成せず、先に取った候補も捨てられ、送信ループ（`:466` 以降）に入らない**。
  `due`（`:446-448`）も同じブロックなので CTA 追客まで止まる。候補取得を `Promise.allSettled` か個別 try/catch にする
- **AC-11-8**: When migration 適用前の DB で `archive_closing` を INSERT しようとしたとき, the system shall
  **他の kind の送信を止めない**
  → `getOrCreateJourneyFollowup`（`:393-422`）は送信ループの try（`:514`）の**外**にある。
  CHECK 違反の throw がここで出ると後続 journey が止まる。**AC-11-7 だけでは塞げない**
- **AC-11-9**: When `GET /api/webinars/:id/analytics` を叩いたとき, the system shall
  `data.journey.journeyFollowups.archive_closing` に件数を返す
  → 足す箇所は**5つ**。`WebinarJourneyFollowupKind`（`packages/db/src/webinars.ts:116-120` と worker 側 `:17-21`）/
  `emptyWebinarJourneyFollowupCounts`（`:467-473`）/ `isWebinarJourneyFollowupKind`（`:447-453`）/
  テスト mock（`webinars.test.ts:124-129`・`webinar-journey-stats.test.ts:87-92`）。
  1つでも漏れると型が壊れるか 500 になるか、**0件と欠測を区別できない**（未知 kind は `:525-527` で黙って捨てられる）
- **AC-11-10**: When 既存4ステージ（`picker_no_registration` / `registered_no_show` /
  `submitted_no_booking_30m` / `submitted_no_booking_24h`）の候補を評価したとき, the system shall
  **これまでと同じ母数**を返す
  → **`after_30m` / `after_24h` は別テーブル `webinar_followups`** で、`candidates()`（`:165-211`）が取る。
  journey 側の CHECK 4値と混同しない。新 kind の専用分岐を **else の前**に置く。
  else は `cfg.booking_url IS NOT NULL`（`:368`）なので、専用 `if` を忘れると
  「フォーム送信済みに誤配」ではなく **候補0件の沈黙**になる（`booking_url` は NULL のままのため）。
  **回帰テストは「0件でないこと」を見る形にする**（0件で green になるテストでは沈黙を検出できない）

**通数への影響（承知のうえ）**: (a) と (b) は `registered_no_show` の母数
（除外は `pos >= COALESCE(MIN(cta), 0)`・`:298-304`）に**残る**ので、両方受け取る。
除外されるのは (c) だけ。1人あたり最大 **4通 → 5通**。
ブロック理由1位は「配信頻度が多すぎる」26.5%（モビルス・2025・n=655）`[実証]`。
ただし同 atom の Baek et al. が示すのは、頻度を下げると**解約59%減・短期売上5〜8%減**という
**トレードオフ**であって「送らない＝無料の安全策」ではないこと（メールの数値なので**構造だけ転用**）。
**通数に正解は存在しない** `[実証・該当なしの確認]`（`2026-0803-no-public-data-on-step-completion`）。
→ 段別カウントで測る（AC-11-9）。

### F-12 案内文言の刷新（2026-08-28 実施済み・本番データのみ・コード変更なし）

ユーザー指摘3件を受けて本番データ3箇所を差し替えた。**コードは触っていない**。

| 指摘 | 直したもの |
|---|---|
| 「文言がなぜか動画を1本みたいな感じになっている」 | 「動画」表現を全廃し「無料ウェビナー」に。**開催時刻を選ばせるのに「動画にまとめました」だと、なぜ回を選ぶのか説明がつかない** |
| 「インプは増えたけど、の訴求文だとほとんど取りこぼす」 | フックを「フォロワーが増えない／増えても、仕事にはつながらない」に。**インプが出ている前提だと、まだ増えていない層を丸ごと落とす** |
| 「限定ウェビナーであることを強調して」 | 「特典を受け取った方だけにご案内しているもので、一般には公開していません」「参加無料」「アーカイブは3日間」を明記 |

適用先は3箇所（すべて同じフックに統一した）:

1. `auto_reply d8f05c9e` のバブル2（当日の flex カード）— ボタンも「無料で参加する回を選ぶ」に
2. シナリオ `5202064a` step1（翌日19時・**未クリックのみ**のまま）
3. `webinars.intro_text`（LIFF のセッション選択画面）

**「有料級」は使わない**（PM 判断・ユーザー了承）。理由は2つ。

- **景表法**: 不実証広告規制は「根拠資料を出せない広告は違反扱い」という立て付け
  （第二の脳 "優良誤認表示 — 定義と不実証広告規制" `[法規]` / 19-legal-ethics）。
  実際に有料販売した実績が無いと「有料級」の根拠を出せない
- **LINE規約**: 判定単位は1通ではなく**導線**で、この導線には既に
  「3ヶ月でフォロワー1万人」という成果訴求が立っている
  （`2026-0803-guideline-bans-the-pitch-not-the-business` の 2026-08-27 追記が同型を名指し）

→ **代わりに「ふだん顧問先にお話ししているような内容」で価値を事実として取った。**
「有料級」が主張したかったことを、根拠のある形で言い換えている。

**「無料」の明言を足した根拠**: "「無料」の言い切りは登録数を大きく押し上げる" `[実測]`
/ 16-objection-proof-cta、"「無料」はゼロ価格効果で損失回避の痛みを外す" `[観察]` / 18-japanese。
**限定性は実在する**ので書いてよい（特典受領者にしか案内していない／週5回のみ／3日で実際に切れる。
争点 §3-1「表示している希少性が実在する事実に基づくかの一点」）。

**C-4（未クリック限定を外して全員に送る）は一度適用して取り消した。** ユーザー判断
「当日でいい／翌日は未クリックでいい」（2026-08-28）。現在は `tag_not_exists` が復活している。

### F-13 無料相談の予約を運営者の LINE に通知する（2026-08-28 実装済み・PR #49）

**予約確定の通知が予約した本人にしか飛んでいなかった。** 運営側は Google カレンダーに
予定が入るのを見るまで気づけない状態だった。

- 通知先は環境変数 `ADMIN_NOTIFY_LINE_USER_ID`。**未設定なら何もしない**
  （この worker は他アカウントでも動くので、設定していない環境の挙動を変えない）
- 送信は予約者への確認 push と同じ経路（`pushViaHarnessProxy`）
- **独立した try/catch**。失敗しても予約の確定と予約者への通知に影響しない
- **冪等キーを分けた**（`bookingId:admin`）。予約者向けと同じキーだと片方が重複扱いで落ちる

**マージ後に必要な作業**: Cloudflare の worker に `ADMIN_NOTIFY_LINE_USER_ID` を設定する。

### 運用上の穴（F-11 で塞ぐ）

**`webinar_followup_configs` を書き込む経路が API にも管理画面にも存在しない**（2026-08-28 実測）。
そのため §6 の運用手順「`is_active` を立てる前に `stage_enabled_at` を今にする」を**実行する手段が無い**。
D1 への直接アクセスも、手元の Cloudflare API トークンに D1 権限が無く叩けなかった。
→ **F-11 の実装に `GET` / `PUT /api/webinars/:id/followup-config` を含める。**
これが無いと、有効化した瞬間に過去の予約者へバースト送信される事故を防げない。

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

**`{入場リンク}` は session 付きの URL**（`buildWebinarUrl`・`services/webinar-reminders.ts:29-37`）。
`?page=webinar&slug=…&sessionStartAt=<予約した回>&liffId=…` の形でなければアーカイブ再生に入れない
（`routes/webinars.ts:176-200` が `sessionStartAt` 付きの予約行を要求する）。
**`webinarPickerUrl`（`webinar-followups.ts:70-75`）は slug だけで session を持たないので、入場リンクには使えない。**
送信時点で対象回は過去回なので、F-10 後の `upcoming` にも出ない ——
**ピッカー URL を入場リンクに使うと、メッセージは届くのに再生できない。**
`{ピッカーURL}`（(a) の「別の回を選び直す」導線）だけが `webinarPickerUrl`。

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
  **テーブル作り直し**。＝ **危険 zone**。
  **既存の最新は `074_auto_reply_second_message.sql` なので採番は 075 から。**
  `060_webinar_journey_followups.sql` を書き換えても**適用済み D1 の CHECK は変わらない**。
  あわせて **`pnpm --dir packages/db generate:bootstrap` で bootstrap を再生成**する（`packages/db/package.json:18`）
- **`is_active` を 0→1 に戻すと `stage_enabled_at` が古いままで過去の離脱者にバースト送信**（既知の罠）。
  **有効化前に `stage_enabled_at` を必ず今にする**。加えて**候補SQL側にも下限フィルタを入れる**（F-11 §母数）
- 期限の計算は `session_start_at + duration_seconds + ARCHIVE_WINDOW_SECONDS - 6h`。
  `ARCHIVE_WINDOW_DAYS` は定数から引く（**ハードコードしない**）
- **入場リンクは `buildWebinarUrl`（session 付き）／ピッカーは `webinarPickerUrl`／相談フォームは `formUrl`** と使い分ける。
  `formUrl`（`webinar-followups.ts:63-67`）は未 export なので同ファイル内に置くか export する。
  liffId が解決できないときの throw は **CTA 側が `:484`、journey 側が `:524`** の2箇所
- 送信ループ側（`:511-575`）は候補ごと try/catch なので、止まるのは**候補取得と `getOrCreateJourneyFollowup` の段**
  （AC-11-7 / AC-11-8）
- 既存テストを壊さない: `apps/worker test` 102 files / 1054 tests・`packages/db test` 24 files / 168 tests。
  **ただし F-10 は仕様変更なので、AC-10-5 が名指しする3箇所は「更新する」対象**
- **`packages/db` のテストは `test/` に置く**（vitest の include が `test/**` 限定。`src/*.test.ts` は走らない）

## 7. 失敗モードリスト（痛い順・テスト化の根拠）

| # | 失敗モード | 痛み | 扱い |
|---|---|---|---|
| 1 | migration 前に新 kind を INSERT し、CHECK 違反が送信ループの外で throw する | **全追客が停止** | AC-11-8（AC-11-7 では塞げない） |
| 2 | 候補SQLの throw で配列リテラルが完成せず、既存4ステージが送られない | **全追客が停止** | AC-11-7（`allSettled`） |
| 3 | `stage_enabled_at` 下限を候補SQLに入れ忘れ、有効化直後に**バースト送信** | **通数枯渇＋ブロック** | F-11 §母数・§6 |
| 4 | 閾値に `COALESCE(..., 0)` を使い、CTA 無しウェビナーで視聴者全員が (c) に落ちる | **URL が組めず throw、または誤配** | AC-11-5（SQL 文字列アサーション） |
| 5 | 専用分岐を else の後に置き、候補が**0件で沈黙**する（else は `booking_url IS NOT NULL`） | 何も送られないのに気づけない | AC-11-10（「0件でないこと」を見る） |
| 6 | 除外を session 単位で書き、CTA 済みの人に `after_24h` と二重に届く | 通数の無駄・不信 | AC-11-4（friend × ウェビナー単位） |
| 7 | 入場リンクにピッカー URL を使い、**届くのに再生できない** | 一番濃い層を落とす | §4 の注記 |
| 8 | `now+3日` で upcoming が空になり、予約済みの人が待機画面に落ちる | 予約が消えたように見える | AC-10-4 |
| 9 | `LOOKAHEAD_DAYS` 据え置きで選べる回が1〜2件に減る | 選べない | AC-10-3 |
| 10 | 2回目の予約で UNIQUE に弾かれ、1通も送れない | 沈黙故障 | AC-11-6（仕様として明記） |
| 11 | 段別カウントの5箇所のどれかを足し忘れ、0件と欠測を区別できない | 計測不能 | AC-11-9 |
| 12 | AC の検証コマンドが `.data` を通さず、**実装が正しくても fail** する | 誤った手戻り | AC-9-1 の注記 |

## 8. 実装順序（依存関係順）

1. **F-9**（シナリオ時刻 19:00）— DB のみ・独立・すぐ出せる
2. **F-10**（`now + 3日`）— コードだが小さい。**F-11 の (a) 本文が「別の回」を勧めるので先に入れる**
3. **F-11**（`archive_closing`）— migration あり・危険 zone。最後

## 9. 受入条件（DoD）

- [ ] AC-9-1〜3 / AC-10-1〜6 / AC-11-1〜10 が**すべて**検証コマンドで pass
- [ ] `apps/worker test` / `packages/db test` / `typecheck` / `build` が green（**PM 自身が再実行**）
- [ ] negative case 4件以上（CTA 無しウェビナー / 2回目の予約 / 候補SQL throw / migration 前の INSERT）
- [ ] AC-10-5 が名指しする既存テスト3箇所を**更新**し、守る2箇所が green のままであること
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
