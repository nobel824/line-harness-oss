# 要件: 特典応答の2バブル化 ＋ 自分のコメントのリロード復元

対象 repo: line-harness-oss（nobel824 フォーク）。ブランチ `feat/webinar-two-bubbles`。

---

## A. auto_reply を2バブル送れるようにする（migration 074）

### なぜ
特典配布メッセージにオートウェビナーの案内が同梱されていて、1通の中に CTA が2本立っている。
分けたいが、**シナリオで翌日に送ると課金1通×全員分**が乗る。
**応答メッセージ（Reply API）は課金対象外**で、**吹き出しは1配信3つまで**送れるので、
**同じ応答の中で2バブルに分ければ課金0のまま**分けられる。

### 現状の制約（実装を読んで確認済み）
`apps/worker/src/services/auto-reply.ts` は `buildMessage` を1回だけ呼び、`replyMessage(replyToken, [replyMsg])` と
**単一要素の配列**を渡している。リポジトリ内に複数メッセージ送信の前例は1つも無い。

### 実装
`packages/db/migrations/074_auto_reply_second_message.sql`（新規）:
```sql
ALTER TABLE auto_replies ADD COLUMN response_type_2 TEXT;
ALTER TABLE auto_replies ADD COLUMN response_content_2 TEXT;
```

- **`response_content_2` が NULL か空文字なら、従来どおり1通**。既存の全 auto_reply は挙動が変わらないこと
- 値があれば `buildMessage` をもう一度呼び、`[msg1, msg2]` を渡す
- `response_type_2` が NULL のときは `response_type`（1通目）と同じ型として扱う
- **テンプレート変数の展開・LIFF ID の解決（`{{liff_id}}`）は2通目にも同じように適用する**
- **`logOutgoingMessage` は2通分記録する**。1通分だけだと配信実績が実態とずれる
- 管理 API（`apps/worker/src/routes/auto-replies.ts` の POST / PUT / GET）で
  `responseType2` / `responseContent2` を読み書きできるようにする。**PUT は既存どおり部分更新を維持**
- 管理画面（`apps/web`）の auto_reply 編集フォームに2通目の入力欄を足す。**空なら送らない**ことが分かる文言にする

### 危険 zone の注意
`auto_reply` は**この worker の全アカウント（AI顧問 / クラファン / サガリ藤）が共有する経路**。
「NULL なら従来どおり1通」が壊れると全アカウントの応答が壊れる。
**既存 auto_reply（2通目が NULL）の挙動が1バイトも変わらないことを検証するテストを必ず書く。**

---

## B. 自分のコメントがリロードで消えるのを直す

### なぜ
視聴中に送ったコメントは `webinar_user_comments` に保存され、管理画面からも読める。
ところが `/state` のレスポンスに含めていないので、**リロードすると自分の発言だけ消える**。
保存されているのに表示されないのは不整合。

### 実装
公開 `/state` のレスポンスに `myComments` を足す。

- 中身は **その friend 自身が・その回（`session_start_at`）に投稿したコメントだけ**
  （`webinar_user_comments` を `friend_id` と `session_start_at` で絞る）
- **他人のコメントは絶対に含めない。** 設計方針として「存在しない参加者を演出しない」を守っており、
  実在コメントの相互表示は別途の判断待ち。ここでは**自分の分だけ**を戻す
- クライアント（`apps/worker/src/client/webinar/main.tsx`）は初期ロード時に `myComments` を
  `atSeconds` 順でチャット欄に流し込む。表示は既存の自分のコメントと同じ（`authorName: 'あなた'` / `mine: true`）
- **サクラコメント（`comments`）との二重表示や順序崩れを起こさないこと**
- `myComments` が無い古いレスポンスでも落ちないこと（**optional 扱い**。apps/web と apps/worker は別デプロイ）

---

## 受入条件（すべて自分で実行して green を確認）
1. `pnpm --dir packages/db test`
2. `pnpm --dir apps/worker test`
3. typecheck が db / worker / web の3つとも通る
4. **A**: 2通目が NULL の既存 auto_reply が、従来と同一の1通だけを送ること／2通目があるとき
   `replyMessage` に**2要素の配列**が渡ること／ログが2件記録されること／`{{liff_id}}` が2通目でも展開されること
5. **A**: migration 074 で列が追加され、既存行が壊れないこと（`packages/db/test/074_*.test.ts`）
6. **B**: `/state` が自分のコメントだけを返し、他人のコメントを含まないこと

## 踏みやすい罠
- migration を足したら**必ず** `pnpm --dir packages/db generate:bootstrap`（bootstrap は手で書かない）
- **packages/db のテストは `packages/db/test/` 配下**（`src/*.test.ts` は走らない）
- 新フィールドは**常に optional 扱い**（apps/web と apps/worker は別デプロイ）
- 担当範囲外のファイルを触らない。隣接コードを "改善" しない
- **`claude` / `opus-pm` コマンドを呼ばない**（sandbox から Keychain が見えず失敗する）
- **コミットはしない**
