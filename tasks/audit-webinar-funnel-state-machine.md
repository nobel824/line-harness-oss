# 導線の状態機械監査（Grok 4.6・読み取り専用 / 2026-08-29）

> 実施: `grok -p ... -m grok-4.6 --tools read_file,list_dir,grep`（コード変更なし）
> 依頼の眼目: 「この行は正しいか」ではなく **状態遷移の網羅性**。
> このプロジェクトの欠陥は例外なく沈黙故障（落ちない・例外も出ない・ログにも残らない）だったため。
>
> PM 裁定の結果は `requirements-webinar-followup-state-machine-audit.md`。
> 本書は**監査の生の出力**（一次資料）で、裁定で「やらない」と決めた項目も残してある。

---

## A. 状態遷移表

凡例: **拾う** = その経路をコードが扱う。**除外** = 候補SQLまたは送信直前で落とす。

| 人がやること | 誰が拾うか | 二重に拾わないか | 沈黙したらどう見えるか |
|---|---|---|---|
| 特典請求・案内クリック（タグのみ） | 追客は見ない。分析の分母だけ `funnel_entry_tag_id` / `funnel_invite_tag_id`（`packages/db/src/webinars.ts:653-697`） | 追客と交差しない | タグ未設定なら分析が `null`。案内未クリックは **0通のまま正常と区別不能**（本機械の外） |
| LIFFを開くが friend 行がない | `resolveWebinarCaller` が 403（`webinars.ts:146-150`） | ピッカーも予約も書かない | ピッカー追客 0。ログは 403 のみ |
| 日程ピッカー表示（未予約） | `recordWebinarPickerOpen`（`webinars.ts:306-308, 335-337` → `webinars.ts:1121-1133`）。追客は `picker_no_registration`（`webinar-followups.ts:332-359`） | ピッカーは `(webinar, friend)` 一意で初回 `opened_at` 固定。予約後・viewer 行があると除外 | cron が `sent+failed=0` ならログなし（`scheduled.ts:174-176`）。管理画面の `journey_followups.picker_no_registration.sent` が 0 のまま |
| ピッカーをリロード・再訪 | INSERT OR IGNORE なので `opened_at` は動かない | 遅延の起点は初回のまま。2通目は UNIQUE で止まる | 「あとで決めよう」が初回+30分で1通。再訪しても時計は戻らない |
| 回を予約 | `POST .../register`（`webinars.ts:505-554`）。同一回は INSERT OR IGNORE。未来の別回は DELETE して1件化（`webinars.ts:1055-1080`） | 受付確認は `created===true` のときだけ | 確認プッシュ失敗は catch で握り潰す（`webinar-reminders.ts:122-140`）。予約自体は残る |
| 開始5分前リマインド | `processWebinarReminders`（`webinar-reminders.ts:70-111`）。窓は開始5分前〜セッション終了 | `notified_at` の CAS | `liffId` 欠落は毎分 failed のあと、終了すると候補から消えて **未通知のまま終了**（`webinar-reminders.ts:89-92`, `webinars.ts:1146-1152`） |
| ライブ入場 | GET が viewer を INSERT OR IGNORE（`webinars.ts:350`, `webinars.ts:394-408`） | 同じ回は1行 | GET を通さないと再生トークン自体が無い |
| 視聴位置ハートビート | `UPDATE ... MAX(last_position)`（`webinars.ts:427-430`）。**viewer 行が無いと 0 行更新でも 200**（`webinars.ts:410-431`） | 位置は減らない | 位置が 0 のまま → no_show 本文が「お会いできませんでした」。エラーもログも無し |
| 予約したが視聴 0 秒（viewer あり） | `registered_no_show`。SQL は form CTA より前なら残す（`webinar-followups.ts:371-390`）。本文は 0 秒を未参加扱い（`webinar-followups.ts:183-196` のテストで固定） | 後述の UNIQUE | 送られないと `registered_no_show.sent=0`。失敗は journey 側は再候補に出ない（後述） |
| 予約したが viewer 行なし（本当に未入場） | 同上。`last_position` は NULL → 未参加本文 | 未来予約があると除外（`webinar-followups.ts:371-375`） | 同上 |
| 途中まで見て離脱（CTA秒未満） | `registered_no_show` 本文が「続きが残っています」（`webinar-followups.ts:110-120`） | CTA到達は SQL で除外。本文でも `null` → `skipped/cta_reached`（`webinar-followups.ts:729-734`） | skipped は sent/failed に入らず、cron ログにも出ない。stats の `skipped` を見ないと分からない |
| 終盤まで見たが CTA を押さない | `registered_no_show` は除外。`archive_closing` が期限直前に拾う（`webinar-followups.ts:461-466` はクリックのみ除外） | archive は kind 一意 | **途中の追客は意図的に無い**（決定済み）。壊れると archive の sent=0 だけ |
| CTA カード出現（`autoOpen`） | クライアントが `openCta` → `cta-click` を送る（`main.tsx:518-519, 620-627`） | `cta_clicked_at = COALESCE(既存, now)` で初回固定（`webinars.ts:436-441`） | POST 失敗は `.catch(() => undefined)` で握り潰す。サーバー上は未クリック |
| CTA クリック（viewer 無し） | `UPDATE` が 0 行でも 200（`webinars.ts:575`）。funnel_event だけ残る | after_30m は `webinar_viewers.cta_clicked_at` 起点なので **拾わない** | 分析の funnel `cta_click` と viewers のクリック数がズレる。追客は 0 通 |
| CTA 後にフォーム未送信 | `after_30m` / `after_24h`（`webinar-followups.ts:250-295, 234-247`） | 各 kind は `status='sent'` のみ除外。**24h は 30m 送信済みを要求しない** | 候補 0 はログ無し。`webinar_followups` の sent が 0 |
| フォーム送信 | `POST /api/forms/:id/submit`（`forms.ts:451-545`）。friend 必須 | after_* は「クリック以降の送信」で除外（`webinar-followups.ts:277-282`） | 送信 401/404 なら `form_submissions` が無く、after_* が止まり続けない |
| 送信したが相談未予約 | `submitted_no_booking_30m` / `_24h`（`webinar-followups.ts:479-528`） | 24h は 30m が `sent` のときだけ（`webinar-followups.ts:482-488`）。予約は local `bookings` / `meet_consultations` | **`booking_url` か `booking_menu_id` が null なら SQL が 0 件**（`:506`）。エラー無し |
| 同一画面で相談枠を確定 | `consultation-book`（`webinars.ts:690-723` → `webinar-consultation-booking.ts:287-`） | 既存 confirmed+Meet は 200 で再利用 | calendar 失敗は booking を cancelled にして 503。追客除外は cancelled を見ないので、30m 未送信なら後から追客が来る |
| アーカイブ再生 | GET の replay 分岐（`webinars.ts:202-264`）。viewer を作る | 期限切れはピッカーへ落とす | トークン無しは 403。追客は archive_closing |
| アーカイブ期限直前 | `archive_closing`（`webinar-followups.ts:427-476`）。未視聴 / 途中 / 完走で本文分岐 | どのセッションでも CTA 済みなら除外（テスト AC-11-4）。kind 一意で再予約しても再送しない（AC-11-6） | 候補SQL例外は `console.error` のあと **その kind だけ 0 通**（`webinar-followups.ts:607-612`） |
| 別回に選び直し | 未来の旧予約は DELETE。過去の予約行は残る | no_show / archive は friend×webinar×kind で1回きり | 2回目の見逃しは **誰も再送しない** |
| 予約キャンセル | **キャンセル API は無い** | 旧予約が残るので no_show / archive が通常どおり発火 | 「キャンセルしたのに追客が来る」は仕様。来ない場合は別原因 |
| ブロック | CTA 候補は SQL で `is_following=1`（`:273`）。journey は送信時に `skipped/not_following`（`:680-685`） | CTA の failed は再候補可。journey の skipped は行があるので再候補不可 | journey は skipped が増えるだけ。cron ログは 0 |
| 同一人物が複数セッション視聴 | viewer / registration は session 単位。追客 kind は webinar×friend | クリックは全セッション OR で archive から除外 | 2回目の完走・見逃しに専用ステージは無い |

cron は `scheduled.ts:164-176` から **毎分** `processWebinarFollowups` を呼ぶ（5分ゲートの外）。`sent+failed=0` はログに出ない。

---

## B. 穴（誰も拾わない遷移）

**決定済みのため新ステージ提案はしないもの**

- 終盤まで見たのに CTA を押さなかった人を、archive より手前で追う経路。`registered_no_show` は CTA 到達で除外（`webinar-followups.ts:383-389, 107-108`）。archive まで空くのは仕様。

**確認できた穴**

| 深刻度 | 穴 | 根拠 |
|---|---|---|
| **致命に近い** | journey 4+1 ステージ（picker / no_show / submitted_* / archive）は、行が1つでもあると **status を問わず再候補に出ない**。`failed` も `pending` も同じ | `NOT EXISTS ... kind = ?` に status 条件が無い（例: `:351-355, 416-420, 514-523, 467-472`）。一方 CTA の after_* は `status='sent'` だけ除外（`:283-287`）。送信失敗・INSERT 後クラッシュは、journey では **その人に二度と飛ばない** |
| **重要** | CTA クリックが viewer 行より先（または UPDATE 0 行）だと `cta_clicked_at` が付かない。after_* も archive 除外も動かない（archive は「未クリック」と見るので期限直前に別文が飛ぶ可能性） | `recordWebinarCtaClick` は UPDATE のみ（`webinars.ts:428-441`）。クライアントは失敗を握り潰す（`main.tsx:627`） |
| **重要** | form CTA が無い（URL CTA だけ / `form_id` 無し）と after_* は永久 0 通。クリックしていれば archive からも除外される | EXISTS `form_id IS NOT NULL`（`:288-291`）。要件 AC-5-6 が同じことを書いている。クリック済み × form 無し = **両側から落ちる** |
| **重要** | 2回目以降の見逃し・アーカイブ期限。kind が session を持たない | UNIQUE `(webinar_id, friend_id, kind)`（`060_*.sql:50`, `075_*.sql:23`）。archive はテストあり（AC-11-6）。no_show の2回目はテスト無しだが同じ制約 |
| **重要** | ピッカー初回が `stage_enabled_at` より前だと、再訪しても `opened_at` が更新されないので picker 追客に二度と入らない | INSERT OR IGNORE（`webinars.ts:1121-1133`）+ `opened_at >= stage_enabled_at`（`webinar-followups.ts:340`） |
| **重要** | `submitted_no_booking_24h` は 30m が `sent` でないと出ない。30m が failed/skipped のままだと 24h は永久 0 | `:482-488` |
| **軽微〜重要** | 予約の全キャンセル手段が無い。残り1件を消せず、no_show / archive が走る | register は未来の別回を消すだけ（`webinars.ts:1065-1071`） |
| **軽微** | ピッカー表示時に upcoming が空だと `recordWebinarPickerOpen` しない | `webinars.ts:306, 335` |
| **軽微（既定値の地雷）** | `registered_no_show` の遅延は **セッション開始 + no_show_delay**。duration を足さない。INSERT 既定は 30 分（`webinars.ts:213`, `060_*.sql:10`） | 57分動画だと、既定のままなら **ライブ途中** に「お会いできませんでした / 続きが残っています」が飛ぶ。API で分数は変えられる（`webinars.ts:964-974`）。本番の実値はこの監査では未確認 |

**疑い（コード上あり得るが、実データ未確認）**

- フォーム送信が `getFriendByLineUserId`（アカウント未指定、`forms.ts:473`）。ウェビナー側は `ForAccount`（`webinars.ts:146-148`）。複数アカウントがあると、送信 friend と viewer friend がズレ、after_* が止まらず submitted は別行に付く。
- `unixepoch(jstNow文字列)`（`webinar-followups.ts:370, 374, 460`）。`jstNow` は `+09:00` 付き（`utils.ts:11-21`）。SQLite がオフセットを無視すると最大9時間ズレる。picker / after_* は `datetime()` 同士なので相対的には壊れにくい。**テストは SQL を実DBで実行していない**（モック）。

---

## C. 重複（2通以上飛びうる組み合わせ）

**確認できたもの**

1. **`after_30m` と `after_24h` が同一 cron で同時送信**  
   再現: CTA から 24h 以上経過していて、どちらも未送信（cron 停止、`is_active` を後から 1、クリックが古い）。  
   根拠: 候補を並列取得（`webinar-followups.ts:584-595`）。24h は 30m の `sent` を見ない。本文は「途中で止まっている」と「ご案内はこれで最後」が連続する。  
   `submitted_no_booking_24h` には 30m sent ゲートがあるので、こちらは同 tick 同時発射にはならない。

2. **`is_active` を切り直したときの CTA 追客バースト**  
   journey は `stage_enabled_at` を `isActive: true` で now に打ち直す（`webinars.ts:958-961`）。  
   after_* は **`enabled_at` のみ**（`webinar-followups.ts:263, 275`）。`enabled_at` は INSERT 時だけ（`webinars.ts:216-217`）。再有効化すると、昔の未送信 CTA 離脱者に 30m/24h が一気に載る。LIMIT 50/分で消化。

3. **順次の「別 kind 2通」は仕様**  
   no_show のあと archive、after_30m のあと after_24h、submitted 30m のあと 24h。UNIQUE は kind 単位なので **同じ kind の2通は DB 制約で止まる**（AC-5-4）。retry_key の 409 は成功扱い（`line-proxy-send.ts:34-37`）。

**疑い**

- `* * * * *` と `0 */6 * * *` が同じ分に二重起動（`scheduled.ts:40-41` のコメント、followups は5分ゲート外）。retry_key が効いていれば LINE 側は1通。効いていなければ2通。**実測していない**。
- CTA 未記録のままフォーム送信（視聴画面外の直接 LIFF）: `archive_closing` はクリックしか見ないので、submitted_* と archive の両方。autoOpen 経路なら `openCta` がクリックを書くので起きにくい。
- 外部 `booking_url` で予約が local `bookings` に落ちない場合、submitted_24h がまだ飛ぶ。除外は local だけ（`:508-518`）。

**該当なしに近いもの**

- 同じ kind を2行 INSERT: UNIQUE + INSERT OR IGNORE。
- picker と no_show: 予約または viewer で picker 除外。

---

## D. 沈黙故障のリスク箇所

壊れたときの通数は、そのステージが **0 通のまま**か、failed に残るか。

| 設定 / 分岐 | 壊れたとき | 見えるもの |
|---|---|---|
| `webinar_followup_configs` 行が無い / `is_active=0` | 全ステージ **0 通** | JOIN で候補消滅。ログ無し |
| `booking_url` または `booking_menu_id` が null / 空文字（API は trim して null、`webinars.ts:981-983`） | **submitted_* だけ 0 通**。他ステージは動く | 過去に踏んだ型。SQL `:506`。エラー無し |
| `LIFF_URL` 不整 + account.liff_id 無し | 候補は出るが throw `'LIFF ID not configured'`（`:635, 688`） | CTA は failed で再試行。**journey は failed のまま 0 通再送なし** |
| `WORKER_PUBLIC_URL` がプレースホルダのまま（`scheduled.ts:168-169`） | push 失敗 | 同上（CTA はリトライ、journey は一発アウト） |
| form CTA 無し | after_* **0 通**。クリック済みなら archive も 0 | AC-5-6。ログ無し |
| `tag_on_attend` / `tag_on_cta_click` が null | タグが付かないだけ。追客はタグを見ない | 分析の分母だけ欠ける |
| `funnel_*_tag_id` が null | 分析が null。追客 0 にはしない | |
| `duration_seconds = 0` | archive 期限計算が `session+0+3日-6h`。残り時間「あと少し」 | 本文は飛ぶ。期限がおかしい |
| `account_id` null | デフォルトトークンへフォールバック（`:562-576`） | 別アカウントに送る可能性。失敗なら failed |
| cron `sent+failed=0` | 正常 0 と故障 0 が同じ | `scheduled.ts:174-176` がログを出さない |
| 候補 SQL 例外 | その kind だけ空配列（`:588-592, 607-612`） | `console.error` は出る。通数は 0 |
| 確認プッシュ失敗 | 0 通（予約は残る） | `webinar-reminders.ts:139` の error ログのみ |
| 開始5分前リマインドがセッション終了まで失敗 | その後 **0 通で打ち切り** | `notified_at` は NULL のまま、due 条件から消える |
| ハートビートが viewer 無し | 位置 0 のまま。HTTP 200 | 追客は未参加扱いか archive 未視聴 |

`first_delay_minutes` / `picker_delay_minutes` / `booking_delay_minutes` は admin API から変えられない（変えられるのは noShow / bookingUrl / menu / isActive / stageEnabledAt 等）。既定のまま沈黙しても、画面上は「設定済み」に見える。

---

## E. after_30m / after_24h / submitted_no_booking_* の精読結果

この4本はテストが **本文とモックSQL文字列** が中心で、候補SQLを実D1/SQLiteに流していない。本番も after_24h / submitted_* / after_30m は 0 通、と前提にある。**一度も実行されていないコード**として見た。

**確認できた論理エラー**

1. **after_24h に「30m 送信済み」ゲートが無い**（submitted_24h にはある）。未実行コードが初めて動くとき、24h 以上放置されたクリックは 30m と 24h を同時に送る。列名や JOIN の取り違いは見当たらない。
2. **after_* だけ `stage_enabled_at` を見ない**。要件コメント（`requirements-auto-webinar-funnel.md` の「全ステージ COALESCE(stage_enabled_at)」）と実装が食い違う。再有効化バーストの温床。
3. **`cta_clicked_at` は初回固定**。有効化前のクリックは、再クリックしても after_* に入れない。form が無ければ archive からも落ちる。
4. **submitted は `booking_url` AND `booking_menu_id`**。片方 null で 0 通。本文は `bookingUrl ?? ''`（`:219, 227`）なので、SQL をすり抜けた空文字だと **リンク無し本文が送られる**。API 経由なら空文字は null 化される。
5. **journey の already-sent 判定が「行の存在」**なので、submitted の failed は 24h に進めず、30m も再送しない。
6. **after_* の `form_id` サブクエリは `kind='form'` ではなく `form_id IS NOT NULL`**（`:268-270`）。admin PUT は url CTA の form_id を null にする（`webinars.ts:1243`）ので、通常は一致する。archive / no_show 側は `kind='form'`（`:384-386, 443-445`）。フィルタがステージで違う。

**見当たらなかったもの（この4本に限る）**

- 存在しない列名、明らかな typo。
- `buildCtaFollowupText` の null 分岐抜け（常に string）。
- submitted 本文の switch 抜け（`buildJourneyFollowupText` は journey kind のみ。after_* は別関数）。

**疑い**

- クリック後より前のフォーム送信では after_* を止めない（`:281` が `created_at >= cta_clicked_at`）。先に送信して後から autoOpen クリック、だと after_* がまだ飛ぶ。
- 予約除外の `datetime(b.created_at)` は bookings 既定が TZ 無し JST 壁時計、submit は `+09:00`。通常は「予約の方が後」に見え除外される。境界の1秒は未検証。
- `Candidate.form_id` は型が `string` だが SQL 的にはサブクエリ。EXISTS と同時なので null はまず来ない。来たら `formUrl` に `"null"` が埋め込まれる。

---

## F. 足すべきテストの一覧

実弾が当分来ないので、**モックではなく実 SQLite（packages/db の既存テストと同じ形）**で候補SQLを固定する必要がある。今の `webinar-followups.test.ts` は `prepare().all()` を stub しており、WHERE の意味はほぼ見ていない。

| ステージ | 固定すること | なぜ実弾で担保できないか |
|---|---|---|
| after_30m | viewer に `cta_clicked_at`、form CTA あり、未送信 → 1件。送信済み form_submissions（クリック以降）→ 0件 | 本番 0 通。到達者が当分出ない |
| after_30m | viewer 行無しで cta-click API 相当の UPDATE 0 行 → 候補 0 | クライアント握り潰しとセット。本番で再現しにくい |
| after_24h | クリックから 24h 超、after_30m **未送信** → 現状は 24h も出る（同時発射を fail させるテスト） | 一度も実行されていない |
| after_24h | after_30m が sent のあと 24h → 1件（意図する直列） | 同上 |
| after_* | `stage_enabled_at` より前のクリックは出ない、を **今は FAIL するテストとして先に書く** | 再有効化は運用で稀。バーストはログ 0 と区別しづらい |
| after_* | form_id 無し / url CTA のみ → 0件 | AC-5-6。設定ミスは沈黙 |
| submitted_30m | booking_url null XOR menu_id null → 0件。両方あり未予約 → 1件 | 過去に本番で沈黙済み。再発防止 |
| submitted_30m | local booking `requested/confirmed/completed` あり → 0。`cancelled` のみ → 1 | Meet 失敗で cancelled になる経路がある |
| submitted_24h | 30m が sent 以外（failed / 行無し）→ 0件 | 30m が一度も成功しないと 24h は永久デッド |
| submitted_* | 外部 URL 予約を模して bookings 行無し → まだ候補（仕様の確認） | 外部完了は観測しづらい |
| picker | 有効化前の opened_at + 再訪しても INSERT されない → 0件 | 初回訪問の時刻は運用で戻せない |
| registered_no_show | `session_start + delay` が duration より短い既定 30 分で、ライブ中の viewer が候補になる | 本番 delay を上げると隠れる。新規 webinar の INSERT 既定 30 が残っている |
| registered_no_show | 2回目の予約・見逃しで kind 行済み → 0件 | 2回目は週次でも数が少ない |
| 全 journey | INSERT 後に push 失敗 → 次 tick も候補 0（現状）。CTA after_* は failed が再候補 | 失敗は稀で、stats の failed を見ないと分からない |
| 回帰 | `autoOpen` が cta-click を書くこと（クライアント）。切ると after_* の母数が変わる | 設定1フラグでファネル定義が変わる |

---

確認できた欠陥の優先順位は、**(1) journey の failed が再送されない**、**(2) after_24h の同時発射**、**(3) after_* が `stage_enabled_at` を無視する**、**(4) submitted の booking_url AND menu_id**（再発防止テスト）、です。コードは触っていません。

**次のタスクはこれ:** 上の (1)〜(3) のうち、どれを「バグとして直す」か「仕様としてテストで固定する」かを決めること。決まったら requirements の Acceptance Criteria を1枚にしてから実装に渡すのが安全です。監査の範囲では、勝手に直しに落ちません。

**今の進捗を全体像から整理するとこれ:** 特典→ピッカー→予約→視聴→CTA→フォーム→相談、の状態遷移をコード根拠で横断しました。動いているのは picker（7通）と no_show（2通）で、CTA 以降は未実行コードのまま本番に載っています。沈黙の型は「例外を投げず候補0」が主で、journey はそれに加えて「1回 failed したら終わり」です。
