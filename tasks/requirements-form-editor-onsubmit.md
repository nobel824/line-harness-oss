# 要件定義：フォーム編集UIに「送信後設定」を追加

- **日付**: 2026-07-17
- **前提**: [[tasks/requirements-admin-form-editor.md]] で作った `/forms` の増補
- **スコープ**: apps/web のみ。worker / packages/db は変更しない。

## 目的・背景

`/forms` の初版では「送信後設定(onSubmit系)の編集UI」を非ゴールに置いた。しかし実運用で、
稼働中の「副業アンケート」には次が設定されており、**これらこそ運用の要**だと判明した。

- `onSubmitTagId` … 回答者に「アンケート回答済み」タグを付与
- `onSubmitMessageType: 'text'` / `onSubmitMessageContent` … 回答後のお礼メッセージ

新フォームに切り替えるには同等の設定が要るが、UI が無いため設定できない（生 API を叩くのは
UI を迂回する悪手であり採らない）。よって **UI に送信後設定を足す**のが本筋。今後も調整したい箇所。

## 対象 API（既存・変更しない）

- `GET /api/tags` … タグ一覧。`{ success, data: Tag[] }`（`Tag = { id, name, color, createdAt }`）。
  `apps/web/src/lib/api.ts` に既存の `api.tags`（272行付近）がある。それを使う。
- `POST /api/forms` / `PUT /api/forms/:id` … 既に `onSubmitTagId` / `onSubmitMessageType` /
  `onSubmitMessageContent` を受け取る（`onSubmitMessageType` は `'text' | 'flex' | null`）。
  **undefined のキーは更新スキップ（部分更新）／null は明示的にクリア。**

## 受け入れ条件（Acceptance Criteria）

1. **タグ選択**: ユーザーがフォーム編集モーダルを開くと「回答後に付けるタグ」のセレクトがあり、
   `GET /api/tags` のタグ一覧＋「なし」から選べる。既存フォームを開くと現在の `onSubmitTagId` が選択済みで表示される。
2. **タグ保存**: タグを選んで保存すると `onSubmitTagId` にそのタグIDが保存される。「なし」を選んで保存すると
   `onSubmitTagId` が **null にクリア**される（undefined を送って据え置きにしてはいけない）。
3. **メッセージ種別**: 「回答後に送るメッセージ」の種別を「なし / テキスト / Flex」から選べる。既存値
   (`onSubmitMessageType`) が反映される。「なし」で保存すると `onSubmitMessageType` と
   `onSubmitMessageContent` の**両方が null にクリア**される。
4. **メッセージ本文**: 種別が「テキスト」または「Flex」のときだけ本文の textarea が現れ、`onSubmitMessageContent`
   を編集・保存できる。既存の本文が読み込まれる。改行が保持される。
5. **Flex を壊さない**: 既存フォームの種別が `flex` の場合、モーダルは種別=Flex・本文=既存 JSON 文字列を
   そのまま表示し、触らず保存しても**内容が変化しない**（text に勝手に変換しない）。
6. **未対応項目の保全**: `onSubmitScenarioId` / `onSubmitWebhookUrl` / `onSubmitWebhookHeaders` /
   `onSubmitWebhookFailMessage` は UI で扱わないため、**引き続き body に含めず**部分更新で保全される。
   （＝今回 body に増えるのは `onSubmitTagId` / `onSubmitMessageType` / `onSubmitMessageContent` の3つだけ）
7. **バリデーション**: 種別が「テキスト」or「Flex」なのに本文が空のときは保存できずエラーを出す。
   種別が「Flex」のとき、本文が JSON として parse できなければ保存できずエラーを出す。
8. **既存機能の非退行**: 設問(fields)の追加/削除/並べ替え・選択肢編集・`columns` の往復保全・
   フォーム名/説明/有効/メタデータ保存の挙動が従来どおり動く。
9. **今回の実運用要件**: このUIだけで、新フォーム「友だち追加アンケート」に
   タグ「アンケート回答済み」＋テキストのお礼メッセージを設定して保存できる。
10. **型健全性**: `pnpm --filter web exec tsc --noEmit` がエラー0。`any` を濫用しない。

## 非ゴール

- Flex メッセージのビジュアルビルダー（生 JSON の textarea で十分）
- `onSubmitScenarioId` / webhook 系の編集UI
- 集計・可視化

## 検証手段

- `pnpm --filter web exec tsc --noEmit` → エラー0
- `pnpm --filter web build` → 成功（`/forms` ルートが生成される）
- 目視: 既存フォームを開いて現在のタグ・お礼文が反映され、保存で消えないこと
