# 要件定義：admin フォーム管理ページ（/forms）

- **日付**: 2026-07-16
- **背景**: [[docs/superpowers/specs/2026-07-16-onboarding-survey-redesign-design.md]]
- **目的**: 稼働中インスタンスにしか存在しないアンケート（フォーム）を、admin(apps/web) の UI から
  作成・編集・削除できるようにする。これにより今回の3問デモグラアンケートも今後の設問調整も UI で完結する。
- **スコープ**: apps/web(Next.js admin) のみ。worker / packages/db は変更しない。

## 対象 API（既存・変更しない）

- `GET  /api/forms` … 一覧（認証必須）。`{ success, data: Form[] }`、fields は**配列**。
- `GET  /api/forms/:id` … 詳細。`{ success, data: Form }`、fields は**配列**。
- `POST /api/forms` … 作成。body の `fields` は**配列で送る**（worker が stringify）。`isActive` は受け取らない。
- `PUT  /api/forms/:id` … 更新。`isActive` を受け取る。**undefined のキーは更新スキップ（部分更新）**。
- `DELETE /api/forms/:id` … 削除。

送信 body（camelCase）: `name`(必須), `description?`, `fields?`(配列), `saveToMetadata?`, （PUTのみ）`isActive?`。
`onSubmitTagId` 等の送信後設定は **UI では扱わず body に含めない** → PUT の部分更新で既存値が保全される。

## フィールド（設問）のデータ形

各設問オブジェクト（既存の worker/クライアントが消費する形に合わせる）:
```ts
type FormFieldType = 'text' | 'textarea' | 'number' | 'tel' | 'email' | 'date' | 'select' | 'radio' | 'checkbox';
interface FormField {
  name: string;        // データキー（回答保存時の key。一意・必須）
  label: string;       // 設問文（必須）
  type: FormFieldType;
  required?: boolean;
  options?: string[];  // select/radio/checkbox のときのみ
  placeholder?: string;
  columns?: number;    // 任意（2 で2列表示。radio/checkbox のみ意味を持つ）
}
```

## 受け入れ条件（Acceptance Criteria）

主語・動詞・期待結果で記述。すべて満たすこと。

1. **一覧表示**: ユーザーが `/forms` を開くと、既存フォームの一覧（フォーム名・回答数(submitCount)・有効/無効(isActive)）がカードまたはテーブルで表示される。
2. **新規作成**: ユーザーが「新規フォーム」を押すと空の編集モーダルが開き、フォーム名・設問を入力して保存すると `POST /api/forms` が呼ばれ、一覧に新フォームが追加される。
3. **編集**: ユーザーが既存フォームの「編集」を押すと現在の値が入った編集モーダルが開き、保存すると `PUT /api/forms/:id` が呼ばれて反映される。**送信後設定(onSubmit系)は画面に無くても、編集保存で消えない**（部分更新で保全）。
4. **削除**: ユーザーが削除を押すと確認ダイアログの後 `DELETE /api/forms/:id` が呼ばれ、一覧から消える。
5. **設問の追加/削除/並べ替え**: 編集モーダル内で、ユーザーは設問行を追加・削除でき、↑↓で並べ替えできる。
6. **設問タイプ切替**: 各設問で type を上記9種から選べ、`select/radio/checkbox` を選んだときだけ「選択肢(options)」の編集UI（選択肢の追加/削除）が現れる。それ以外の type では options 編集は出ない。
7. **選択肢編集**: `select/radio/checkbox` の設問で、ユーザーは選択肢を1つずつ追加・削除・文言編集できる。
8. **バリデーション**: フォーム名が空、設問が0件、設問の label が空、`select/radio/checkbox` で options が0件、のときは保存できずエラーメッセージが出る。設問の `name`(データキー) は未入力なら自動採番(例 `field_1`)で補完し、重複は保存前に検出してエラーにする。
9. **今回のアンケートが作れる**: このUIだけで「Q1 立場(radio,必須,6択)／Q2 年齢層(radio,必須,5択)／Q3 性別(radio,必須,3択)」の3問フォームを作成・保存できる（設計書の選択肢どおり）。
10. **既存パターン踏襲**: 一覧+モーダルCRUD は `auto-replies/page.tsx`、動的配列編集は `segment-builder.tsx` / event-form の `BulkSlotDialog`、型/fetch は `form-submissions/page.tsx` を踏襲。データ取得は `lib/api.ts` に `forms` メソッド群を追加して使う。UIは Tailwind 手書き・ブランド緑 `#06C755`・`<Header>`＋`app-shell` 前提。shadcn等は導入しない。
11. **ナビ追加**: `sidebar.tsx` に `{ href:'/forms', label:'フォーム管理', icon }` を1項目追加（「フォーム回答」の近く）。
12. **型健全性**: `apps/web` で型チェック（`pnpm --filter <web> typecheck` 相当）とビルドが通る。`any` の乱用をせず、fields は上記 `FormField` 型で扱う。fields が文字列で来た場合も `typeof === 'string' ? JSON.parse : そのまま` でガードする。

## 非ゴール

- ランキング設問タイプの新規実装（既存9種のみ）
- 選択肢別/設問別の集計・可視化（回答閲覧は既存 `form-submissions` のまま）
- 条件分岐・複数ページ・送信後設定(tag/scenario/message/webhook)の編集UI
- worker 側の認証是正（`PUT/DELETE /api/forms/:id` が現状無認証で通る件は**別課題としてメモのみ**、本タスクでは触らない）

## 検証（Verify）

- 型チェック / ビルドが通る。
- （可能なら）dev サーバを起動し `/forms` を開いて、新規作成→設問追加→radio選択肢入力→保存→一覧反映→編集→削除の一連が動くことを確認。
