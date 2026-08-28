# 要件定義書｜相談ページの単体化（F-9）＋ アーカイブ期限リマインド（F-10）

> # ⚠️ この版（v1）は誤りを含む。改訂するまで実装に入らない
>
> 2026-08-28 の Grok spec レビュー ＋ PM 自身の再検証で、**v1 の前提2つがコードと違っていた**ことが確定した。
> **下の「改訂ノート」を読んでから本文を読むこと。本文の F-9 は却下済み、AC の多くは書き直しが要る。**

---

## 改訂ノート（2026-08-28・v2 を書くための入力）

### A. v1 の致命的な誤り 2つ（どちらも実コードで再確認済み）

**A-1. F-9 の前提「idToken だけで枠が出る」は誤り。`form_required` 403 がある。**

`resolveWebinarCaller`（`routes/webinars.ts:131-144`）は確かに idToken だけで friendId を解決する。
**しかしその先の `loadContext` に別のゲートがある**:

```
SELECT 1 FROM form_submissions fs
  INNER JOIN webinar_ctas wc ON wc.form_id = fs.form_id
 WHERE wc.webinar_id = ? AND fs.friend_id = ?
→ if (!submitted) throw new WebinarConsultationError('form_required', 403);
```
（`services/webinar-consultation-booking.ts:113-121`）

`consultation-slots` も `consultation-book` も `loadContext()` を通る。
→ **相談フォーム未送信の人には枠が出ない。**
→ F-10 の (c)＝「CTA を押していない人」は**定義上フォーム未送信**なので、
  consult ページを作ってリンクを送っても **403 で開けない**。**F-9 は目的を達成しない。**

PM が `resolveWebinarCaller` だけ読んで「確定事実」と書いたのが原因。
`tasks/state.md` 側は「未確認・着手時に最初に確認する」と正しく書いていたのに、要件書で確定扱いに格上げしてしまった。

**A-2. `page=form` を却下した理由が不正確。実は送信後に枠選択まで進む。**

v1 は「`page=form` は送信すると『送信完了』で終わる（`client/form.ts:659`）」を根拠に却下したが、
**`:659` は汎用フォームの成功画面**で、別経路だった。実際はこうなっている:

```
if (state.formDef.consultationWebinarSlug) {
  await renderConsultationBooking(state.formDef.consultationWebinarSlug);
} else {
  renderSuccess();
}
```
（`client/form.ts:1093-1096`）

`consultationWebinarSlug` は `webinar_ctas → status='active' の webinars → is_active かつ
booking_menu_id が非NULL の config` を辿って解決される（`routes/forms.ts:126-147`）。
**相談フォーム `95a1355f` はこの条件を全部満たす**（CTA `f4396e5a` に紐付き・ウェビナー active・booking_menu_id あり）。

### B. 結論: **F-9（新しい consult ページ）は不要。実装ゼロで済む。**

`?page=form&id=95a1355f` のリンクを送るだけで、
**フォーム記入 → 送信 → その場で枠選択 → 予約確定**まで繋がる。
送信した時点で `form_required` も自然にクリアされるので、A-1 の壁も同時に消える。

- **v2 では F-9 を削除**し、「(c) の行き先は `page=form&id=<相談フォームID>`」と書く
- **URL の組み立て形式は着手時に確認**（LIFF URL / tracked_link のどちらの流儀に合わせるか）
- `submitted_no_booking_*` の解禁も同じ道で解ける可能性があるが、
  **既に送信済みの人が再度 `page=form` を開いたときの挙動は未確認**（再送信になるのか、枠選択に直行するのか）

### C. 今回ユーザーから出た変更 4つ（v2 に機能要件として書く）

| # | 変更 | 決定日 | 覆した過去の決定 |
|---|---|---|---|
| C-1 | **ウェビナー案内を特典応答の2バブル目から外し、翌日の push に移す** | 2026-08-28 | state.md ①「当日・同一応答内の2バブル」 |
| C-2 | **案内の配信時刻は 19:00** | 2026-08-28 | 既存シナリオ `5202064a` は 18:30 |
| C-3 | **セッション選択に出る枠は「画面を開いた日から3日後以降」**（friend ごとではなく `now + 3日` 起点。実装が軽いほうをユーザーが選択） | 2026-08-28 | state.md ②-旧「最短視聴可能時刻は現状維持＝当日の直近の枠」 |
| C-4 | **既存シナリオ `5202064a`（未クリック者への翌日再送）を、案内本体に作り替える**。`tag_not_exists` 条件を外して全員に送る | 2026-08-28 | — |

**C-1 のコスト（ユーザーに提示済み・承知のうえでの決定）**: 応答メッセージ（Reply API）は課金対象外 `[公式]` なので
いま案内は **0通で配れている**。翌日 push に移すと**案内が課金1通 × 全員分**乗る。残枠 約2,000通 `[実測]`、
分母の月間新規特典請求者数は**未実測**。
**C-4 により通数の増分は抑えられる**（もともと未クリック者には送っていた枠を流用するため）。

**C-1 + C-3 の副作用**: 特典受け取りから視聴まで**最短4日**空く（翌日案内 ＋ 3日後の枠）。
「熱は待つと下がる」`[実測]`（`2026-0802-warm-leads-die-at-the-form`・自社で返信13名→フォーム回答3名）
と衝突するが、**「何日空けるのが正解か」の公開データは存在しない** `[実証・該当なしの確認]`
（`2026-0803-no-public-data-on-step-completion`）。**測れる形にして段別カウントで見る**しかない。

**C-4 で失うもの**: 「案内を見なかった人への再フォロー」が消える。
ユーザー判断は「まず作り替えて出し、段別カウントで案内を開かない人が何人いるか 測ってから再フォローを戻すか決める」。

### D. Grok spec レビューの指摘（v2 で必ず潰す）

**致命**
1. A-1 の `form_required`（上記）。AC-9-1 / 9-3 / 10-3 は現行 API 契約では pass できない

**重要**
2. **テーブルを取り違えている。** 旅程ステージは `webinar_journey_followups` であって `webinar_followups` ではない
   （`webinar-followups.ts:267-270, 330-334`）。AC-10-6 / AC-10-9 の検証SQLが誤り
3. **`kind` に CHECK 制約がある。** `webinar_followups.kind` は `after_30m`/`after_24h` のみ（`bootstrap.sql:1054`）、
   `webinar_journey_followups.kind` は既存4値のみ（同 `:1089-1093` / `060_webinar_journey_followups.sql:37-42`）。
   **migration なしで INSERT すると cron がその行で例外を投げる**
4. **UNIQUE は `friend × webinar × kind` で session を含まない**（`060_…sql:50`）。
   AC-10-6 は「friend × webinar × session」と書いており矛盾する。2回目の予約回に1通も送れなくなる
5. **`journeyCandidates` の else 分岐が `submitted_no_booking_*`**（`webinar-followups.ts:341-390`）。
   新 kind を専用枝なしで足すと母数が「フォーム送信済み・未予約」になり **AC-10-2 の逆**になる
6. **新SQLが throw すると既存追客も全部止まる。** `processWebinarFollowups` は候補SQLを
   **ループの前に全部 await** している（`:446-463`）。`archive_closing` の SQL が落ちると
   その tick の `after_30m` も `registered_no_show` も送られない
7. **「ステージ排他なので5通にならない」は誤り。** 既存4ステージは到達段で分かれるが、
   `archive_closing` は**時間軸**なので `registered_no_show` と重なる。未視聴者は両方受け取る
8. **AC-9-3 の期待ステータスが誤り。** 新規確定は **201**（`webinars.ts:707`・既存テスト `webinars.test.ts:917`）。200 を正にすると成功予約が fail する
9. **AC-9-1 の `slots.length > 0` はカレンダーの空き次第**で、0件も正常系（`webinar/main.tsx:1405-1408`）。実装が正しくても fail しうる
10. **「未行動」が未定義**（AC-10-1）。CTAクリック済／予約済／`registered_no_show` 既送のどれを行動とみなすか決まっていない
11. **CTAクリック済・フォーム未送信の人の分岐が無い。** `after_30m`/`after_24h` の母数（`:177`）と重なり、
    期限前にもう1通行き得る
12. AC-10-3/4/5 は**本文が未執筆**なので pass/fail できない。観測点が URL 含有だけになっている
13. AC-10-7 の「SQL 文字列に COALESCE があること」は挙動の pass/fail ではない。
    archive_closing で「視聴したら除外」なのか (c) 扱いなのかを AC に書く必要がある

**軽微**
14. `webinar/main.tsx:1390-1460` は枠グリッドだけでなく**送信後シートの文言込み**。切り出すと視聴画面用コピーが残る
15. AC-9-5 の 404 は `booking_menu_id` 欠如だけでなく **`is_active = 1` 必須**でも起きる（`:102`）
16. `friend_not_found` 403（`webinars.ts:142`）が AC に無い
17. `apps/liff/src/legacy-route.ts:39-42` は未知 `page` を `/booking` に落とす。
    **本番 LIFF が本当に worker クライアントだけかは未確認**

**Grok が未確認と明記した点**: 本番 DB は叩いていない（「本番ウェビナーは `eec8dea0` の1件」「form CTA は 2997」は
state.md の記録に依拠）。→ **これは PM が別途 API で実測済み・一致している。**

### F. 着手前の未確認点はすべて解消した（2026-08-28・Grok コード調査）

改訂ノート B / D が「着手時に確認」と残していた点を実コードで潰した。**v2 はこれを前提に書ける。**

**F-1. LIFF URL の組み立て形式（B の未確認）**
実体は `https://liff.line.me/<liffId>/?page=<page>&...&liffId=<liffId>`。
`?page=form&id=<formId>` を追客本文に載せる**前例がある**（非公開関数 `formUrl` `webinar-followups.ts:63-67`、
呼び出しは `after_30m` / `after_24h` の `:485-486`）。ピッカーは `webinarPickerUrl` `:70-74`。
liffId の解決順は ①ウェビナーの `account_id` → `line_accounts.liff_id` ②`options.defaultLiffId`
③cron が `env.LIFF_URL` から正規表現で抽出（`index.ts:1012-1017`）。どちらも無いと throw（`:484`）。
→ **相談フォームのリンクは `formUrl` を流用すれば済む**（export されていないので同ファイルに置くか export する）。

**F-2. 送信済みフォームの再オープン（B の未確認）**
「送信済みです」ガードは**無い**。空フォームが再表示され、再送信すると `form_submissions` に**行が増える**
（upsert ではない・`packages/db/src/forms.ts:315-328`。`(form_id, friend_id)` の UNIQUE は無い）。
ただし送信後の相談枠画面は安全側に倒れている:
既存予約が `confirmed` かつ `meetUrl` 有りなら「個別相談が確定しました」を出して終了し、枠選択に進まない
（`client/form.ts:720-737, 766-781`）。サーバー側も `created:false` で既存を返す
（`webinar-consultation-booking.ts:275-294`）。**二重予約にはならない。**
唯一の穴は既存が `requested` 止まりのとき — 枠画面に進めてしまい、確定時に 409 `consultation_already_booked`。

**F-3. 新 kind `archive_closing` の追加コスト（D-3 の確定）**
`kind` の CHECK は `060_webinar_journey_followups.sql:37-42` の4値のみ。**SQLite は CHECK を ALTER できない**ので
**テーブル作り直しの migration が要る**（＝危険 zone で確定。additive では済まない）。
UNIQUE は `(webinar_id, friend_id, kind)`（`:50`）で **session を含まない**＝ D-4 のとおり v1 の AC-10-6 は誤り。
`status` の CHECK は `pending|sent|failed|skipped`。
候補SQLは `picker_no_registration` / `registered_no_show` が専用分岐で、**残り全部が else**
（`webinar-followups.ts:341-390`）。専用 `if` を else の前に置かないと「相談未予約」の母数に吸い込まれる（D-5 確定）。
`journeyDue` は4本を**順に await してスプレッド**（`:450-463`）＝ **1本が throw すると後続 kind が走らない**（D-6 確定）。
送信ループ側（`:511-575`）は候補ごと try/catch なので、止まるのは候補取得の段階だけ。
→ 最小の手当ては候補取得を `Promise.allSettled` か個別 try/catch にすること。
段別カウントに出すには `isWebinarJourneyFollowupKind`（`packages/db/src/webinars.ts:447-453`）にも足す
（ここに無い kind は集計から**黙って捨てられる**）。

**F-4. セッション選択を `now + 3日` 以降にする（C-3）— 新しい落とし穴が1つ**
生成は**サーバー1点**。`upcomingSessions` `services/webinar-schedule.ts:116-126` のフィルタ `s > nowEpochSeconds` を変えるだけ。
**ただし `POST .../register` が同じ配列で受理判定している**（`webinars.ts:510-518`）ので、
3日以内の回は予約 API が 400 `invalid_session` になる。C-3 の意図どおりなので整合はする。
**落とし穴**: ピッカーの表示条件が `upcoming.length > 0`（`client/webinar/main.tsx:789`）。
**upcoming が空になると、予約済みの人にも予約済みカードが出ず待機画面に落ちる。**
先読みは `LOOKAHEAD_DAYS = 8`（`webinar-schedule.ts:6`）なので、週5回開催なら now+3日 でも3〜4件は残る計算だが、
**8日先読みのまま3日切り捨てると残りが 5日分しかない**。要件で先読み日数を延ばすか、空のときの表示を決める。
`upcomingSessions` の単体テストは**存在しない**。影響を受けるのは `routes/webinars.test.ts`（`256,273,301,392,421`）。
入場リンクからの視聴とアーカイブ再生は `upcomingSessions` を使わないので影響なし。
開始5分以内の「現在回」は別経路で足されるので now+3日 フィルタの外（`webinars.ts:325-327`）。

**F-5. シナリオ変更の API（C-1 / C-2 / C-4）**
`PUT /api/scenarios/:id/steps/:stepId`（`routes/scenarios.ts:411-574`）。stepId は `GET /api/scenarios/:id` から。
body は camelCase・部分更新可。`absolute_time` は **`offsetDays` + `deliveryTime` のみ**許可で、
`delayMinutes` / `offsetMinutes` を混ぜると 400（`validateStepSchedule:149-158`）。
タグ条件は `conditionType` / `conditionValue` を **null にすれば無条件配信**になる
（`step-delivery.ts:413-414` が `if (!step.condition_type) return true`）。
**キー自体を省略すると既存条件が残る**ので、C-4 では明示的に null を送ること。

**F-6. 本番 LIFF は worker 内蔵クライアントだけ（D-17 の解消）**
`apps/worker/wrangler.toml:13-20` の `[assets]` で SPA を配信し、`?page=form` は `client/main.ts:702-705` が処理する。
`apps/liff/` は Pages 用の旧実装で **form ルートを持たない**（未知 page を `/booking` に落とす）。
→ **`page=form` を配信本文に載せて問題ない。** ただし Grok は「このユーザーの Cloudflare に apps/liff が今載っているかは
repo からは未確認」と明記している。**旧 install 向けの Pages が生きている環境では同じ URL が予約画面に落ちる。**

### E. v2 を書くときの構成案

- **F-9 を削除**し、「(c) の行き先 = `page=form&id=<相談フォームID>`（実装ゼロ）」を前提に格下げ
- **F-9'（新）: 案内の配信タイミング変更**（C-1 / C-2 / C-4）
- **F-10'（新）: セッション選択を `now + 3日` 以降に**（C-3）
- **F-11: `archive_closing`**（旧 F-10。D の 2〜13 を全部反映）
- AC は EARS を維持。ただし**検証手段は「そのコマンドで本当に pass/fail が割れるか」を1件ずつ確かめてから書く**
- **本文の実文を先に書く**（`writing-consult` を引く）。本文が無いと AC-10-3/4/5 が検証不能のまま

---


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

### ~~F-9 相談枠ピッカーの単体ページ~~ 【却下・改訂ノート B を見よ】

> **この節は無効。** `form_required` により目的を達成せず、かつ `page=form` で実装ゼロで済むことが判明した。


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
