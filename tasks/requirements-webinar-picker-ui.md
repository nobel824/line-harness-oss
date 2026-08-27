# 要件: ウェビナー予約フローの改修（事前申し込みフォーム / 文言 / ヘッダー画像）

対象は line-harness-oss（nobel824 フォーク）。視聴画面の実体は `apps/worker/src/client/webinar/main.tsx`。
**`apps/liff/` 側は未デプロイの旧実装なので触らない。**

文言はすべて `uxw-consult`（UX ライティング第二の脳）を引いて確定済み。**本書のとおりに実装し、勝手に言い換えないこと。**

---

## A. 事前申し込みフォーム（新規・本改修の主目的）

### 仕様
オートウェビナーの視聴予約を、**フォームの送信をもって確定**させる。回を選んだだけでは予約されない。

フォームはウェビナーごとに `forms` テーブルの既存レコードを紐付ける方式にする（フォーム定義をコードに埋め込まない）。
**`forms` の項目定義・送信 API・`form_submissions` への保存はすべて既存の仕組みを再利用する。新しいフォーム基盤を作らない。**

### DB
`packages/db/migrations/073_webinar_pre_registration_form.sql`（新規・1行）:
```sql
ALTER TABLE webinars ADD COLUMN pre_registration_form_id TEXT REFERENCES forms(id);
```

### API
- 公開 `/state` の**全分岐**に `preRegistrationForm` を足す。
  値は「`pre_registration_form_id` が設定されていて、かつその form が `is_active=1`」のときだけ**フォーム定義（id / name / description / fields）**を返す。それ以外は `null`
- 管理 API（`GET` / `POST` / `PUT /api/webinars/:id`）で `preRegistrationFormId` を読み書きできるようにする
- **`POST /api/liff/webinars/:slug/register` は変更しない**（後述のとおりクライアントが2段で呼ぶ）

### クライアントの流れ
`preRegistrationForm` が `null` でないとき、回ボタンの押下で `registerSession()` を直接呼ばず、ボトムシートでフォームを開く。

送信ボタンを押したら、**この順序で**呼ぶ:
1. `POST /api/forms/:formId/submit`（既存の公開エンドポイント）
2. 成功したら `POST /api/liff/webinars/:slug/register`

**順序を逆にしないこと。** register を先にすると「予約は入ったがフォーム未回答」の状態が生まれ、
「フォーム送信をもって予約確定」という仕様が破れる。逆に submit だけ成功して register が落ちた場合は、
予約されないので利用者がもう一度やり直せる（`form_submissions` に重複が1件残るが害はない）。

1 か 2 のどちらかが失敗したらシート内にエラーを出し、**シートを閉じない**（入力を捨てない）。

### シートの文言（確定）
- 見出し: `8月27日(木) 22:00 の回に申し込む`（`formatJp(t)` の結果 ＋ ` の回に申し込む`）
- 見出し直下: `あとから別の回に変更できます。`
- その次の行: `すべての項目にご回答ください。`
- 送信ボタン: `この回で申し込む`
- 取消ボタン: `戻る`
- 送信中のボタン: `送信中...`

**すでに別の回を予約していて変更するとき**（`registered !== null && registered !== t`）は見出しだけ差し替える:
- 見出し: `8月27日(木) 22:00 の回に変更する`
- 見出し直下: `いまの予約（8月27日(木) 19:00 の回）は取り消されます。`  ← `formatJp(registered)` を埋める
- 送信ボタン: `この回に変更する`

**すでに予約済みの回（`registered === t`）を押したときはシートを開かない**（no-op）。

### 文言の制約（uxw 由来・変更禁止）
- **「本当によろしいですか？」を使わない**（uxw 正本 C-50「不可逆性の明示」[規範]／uxw 争点 confirm-vs-undo「日本語固有の注意」）
- **「元に戻せません」も書かない。** 予約は可逆なので事実に反する。代わりに**可逆であることを書く**
- 見出しは**操作と対象を具体的に再掲**する（uxw 正本 C-49「操作を再提示する確認」[規範]）
- ボタンラベルは**動詞終止形**。既存ラベル（「もっと先の時間を見る」「Google Meetを確認する」「ライブに戻る」「閉じる」）に合わせる。
  統一が最上位原則（uxw 争点 button-part-of-speech「既存プロダクトに大量の既存ラベルがある → 既存に合わせる」）
- 送信ボタンを赤にしない。既存の予約済み色 `bg-[#06C755]`（LINE グリーン）を使う
- **プレースホルダーをラベル代わりに使わない**（uxw 争点 placeholder-as-label・ほぼ決着）。ラベルは常に表示する

### 見た目
既存の `FormSheet`（`main.tsx` 1207 行付近）と同じボトムシートの型を踏襲する
（`fixed inset-0 z-50 flex flex-col justify-end` ＋ 背面 `bg-black/40` ＋ `rounded-t-2xl bg-white`、背面に `aria-label="閉じる"`）。
**フィールドのレンダリングは既存 `FormSheet` の実装（`main.tsx` 1407 行付近の `f.type` 分岐）を共通関数に切り出して再利用する。**
`text / textarea / select / radio / checkbox` の分岐をコピペで二重に持たないこと。

### `preRegistrationForm` が `null` のとき（フォーム未設定のウェビナー）
フォームの代わりに**確認ダイアログ**を出す（回ボタン押下で即予約にはしない）。文言:
- 見出し: `8月27日(木) 22:00 の回を予約します`
- 本文1行目: `開始5分前にLINEで視聴リンクをお送りします。`
- 本文2行目: `あとから別の回に変更できます。`
- 確定ボタン: `この回で予約する` / 取消ボタン: `戻る`

変更時は見出しを `〜の回に変更します`、本文1行目を `いまの予約（〜の回）は取り消されます。`、確定ボタンを `この回に変更する` にする。

---

## B. 予約済みカードの文言を統一する

### 現状の問題
同じ「予約できた」状態を2画面が別の言い方でアナウンスしていて、**セッション選択画面側に「このページを閉じてよい」が無い**。

| 画面 | 現状 |
|---|---|
| セッション選択メニュー（`main.tsx` 736 行付近） | `開始前にLINEで視聴リンクをお送りします。` / `時間になったらこのページも自動で配信に切り替わります` |
| ライブ参加ゲート（同 846 行付近） | `開始5分前にLINEでお知らせします。このページは閉じてOKです` |

実装の実値は `webinar-reminders.ts` の `LEAD_SECONDS = 300`＝**5分前**。
LINE 側の追客本文（`webinar-followups.ts:79`）も「開始5分前に専用の入場リンクがLINEに届きます」と言っている。
**「開始前に」だけの表記はこの2箇所と食い違う。**

### 実装
両画面の予約済み表示を次に統一する:
```
開始5分前にLINEで視聴リンクをお送りします。
このページは閉じて大丈夫です。
```
セッション選択メニュー側だけ、既存の「自動で切り替わる」情報を3行目の補足に下げる:
```
（開いたままにしておくと、時間になって自動で配信に切り替わります）
```
「別の回に変更する場合はもう一度選んでください」の行はそのまま残す。

### 根拠
- 「5分前」「視聴リンク」の2語を、LINE本文・リマインド・両画面の**4箇所すべてで同じ言い方に揃える**
  （uxw 争点マップ README「読むときの注意 1」＝一貫性が上位原則）
- 「閉じてOK」→「閉じて大丈夫です」。既存画面の口語体に揃える
- 完了後に**次に何が起きるかを書く**（uxw 正本 I-47「完了画面に次の行動」[経験則]／N-5「次に何が起きるか」[経験則]）

---

## C. タイトル上にヘッダー画像を出せるようにする

`intro_text`（migration 071・commit 4b5308e）と**完全に同じ流儀**で画像 URL 列を足す。
画像の実体は R2 `line-harness-images` に置いて公開 URL を管理画面で入れる想定なので、**アップロード機能は作らない。URL のテキスト入力だけ。**

| ファイル | 変更 |
|---|---|
| `packages/db/migrations/072_webinar_intro_image_url.sql` | 新規。`ALTER TABLE webinars ADD COLUMN intro_image_url TEXT;` の1行のみ |
| `packages/db/src/webinars.ts` | `intro_image_url` を Webinar / Create / Update に追加 |
| `apps/worker/src/routes/webinars.ts` | 管理 API の読み書き ＋ 公開 `/state` の**全分岐**に `introImageUrl` |
| `apps/worker/src/client/webinar/main.tsx` | セッション選択メニューのタイトル**上**に `<img>`。null / 空なら非表示 |
| `apps/web/src/components/webinars/webinar-form.tsx` | `intro_text` の textarea の**上**に URL の text input |

- 出す場所は**セッション選択メニューのみ**（`state.live` が false で `upcoming` があるブロック）。ライブ参加ゲート・待機ルーム・配信中には出さない
- `max-w-sm w-full rounded-2xl` 程度で、タイトルの上・`ライブ配信` ラベルの下
- **`alt=""` にする**（装飾画像。直後に同内容のタイトルが読み上げられるので、alt を付けると重複読み上げになる）
- 読み込み失敗で画面が壊れないこと（`onError` で非表示）

---

## 受入条件

1. `pnpm --dir packages/db test` が green（テストは **`packages/db/test/` 配下**。vitest の include が test/** 限定）
2. `pnpm --dir apps/worker test` が green
3. typecheck が db / worker / web の3つとも通る
4. **A のテスト**: 回ボタンを押しただけでは `POST /register` が飛ばないこと／シートの送信で
   `POST /api/forms/:id/submit` → `POST /register` の**順に**飛ぶこと／submit が失敗したら register が飛ばないこと
5. **C のテスト**: migration 072 / 073 で列が追加され既存行が壊れないこと
6. 更新 API に `introImageUrl` / `preRegistrationFormId` を渡さなかったときに既存値が消えないこと
7. `preRegistrationForm` が `null` のときに確認ダイアログ経由で従来どおり予約できること

## 踏みやすい罠（必ず読む）

- **`apps/web`(Pages) と `apps/worker`(Workers) は別デプロイ。** web が先に出ると新フィールドを持たないレスポンスが返るので、
  **新フィールドは常に optional 扱いにする**（分割代入で落ちた実績あり・commit 197a673）
- migration を足したら**必ず** `pnpm --dir packages/db generate:bootstrap`（bootstrap.sql / bootstrap-meta.json は手で書かない）
- **migration の採番衝突に注意**。既存の最大番号を確認してから 072 / 073 を採る
- **packages/db のテストは `packages/db/test/` 配下**（`src/*.test.ts` は走らずオーファン化する）
- 担当範囲外のファイルを触らない。既存の dead code や隣接コードを "改善" しない
- **`claude` / `opus-pm` コマンドを呼ばないこと**（sandbox から Keychain が見えず失敗する）
