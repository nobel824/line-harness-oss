# 要件 — 分析の数字から内部（テスト）アカウントを除外する

## 背景

オートウェビナー導線の分析で、奥田本人（`tatsuki okuda` / friend `ad1cdf5c-c352-4494-b437-1e74cb90b474`）の
テスト操作が全段に混ざっている。2026-09-01 の実測では、**CTAクリック 1 / フォーム送信 1 / 相談予約 1 が
すべて本人の 8/27 のテスト**で、外部からの獲得は 0 件。本人を除くと下流3段は 0 になる。

「少ない」のか「まだ一件も起きていない」のかが数字から読み取れず、判断を誤る。

## 目的

**分析の集計から内部アカウントを除外し、管理画面が除外済みの数字を既定で表示する。**

## スコープ

含む: 分析の集計（`GET /api/webinars/:id/analytics` の7ブロック）と、その管理画面表示。
**含まない（重要）**: 追客・リマインド・配信の**送信対象の決定ロジック**。
`webinar-followups.ts` / `webinar-reminders.ts` は一切触らない。
分析用の除外を送信側に持ち込むと本番の配信挙動が変わるため、**意図的に分離する**。

## 設計

### 1. `friends.is_internal`（migration 078）

```sql
ALTER TABLE friends ADD COLUMN is_internal INTEGER NOT NULL DEFAULT 0;
```

既定 0 なので既存行の意味は変わらない。フラグは友だち単位で、アカウント横断で効く。

**採用理由**: 「本人のテストが数字に混ざる」は今後も繰り返し起きる。除外対象を設定値やコード定数で
持つと、増えるたびに設定を触ることになる。友だちの属性として持つのが素直。

### 2. 集計7関数に除外を通す

`packages/db/src/webinars.ts` の以下すべて。1つでも漏れると段ごとに分母が食い違い、
**遷移率だけが静かに壊れる**（もっとも気づきにくい壊れ方）。

- `getWebinarAnalyticsSummary`
- `getWebinarDailyStats`
- `getWebinarParticipantStats`
- `getWebinarSessionStats`
- `getWebinarDropoff`
- `getWebinarFormFunnelStats`
- `getWebinarJourneyStats`（`picker_opens` / `registrations` / `entry_tag_friends` / `invite_tag_friends` /
  `followups` / `journey_followups` を含む。**タグ由来の2段も対象**。本人は特典請求・案内クリックの
  両タグを持っているため、ここを漏らすと上流2段だけ本人が残る）

### 3. API

`GET /api/webinars/:id/analytics?excludeInternal=true` で除外する。
**パラメータ省略時は従来どおり全件**（後方互換。既存の呼び出し元や外部集計を黙って変えない）。

### 4. 管理画面

`apps/web/src/app/webinars/edit/page.tsx` の分析タブ。

- **初期表示は除外済み**（`excludeInternal=true` を送る）
- 「内部アカウントを含める」チェックボックスで切り替えられる（本人がテストして数字が動くことを
  確認したい場面があるため、除外を固定にはしない）
- 除外中はその旨が画面上で分かること（除外していると気づかずに「0件だ」と誤読しないため）

### 5. フラグの立て方

友だちの更新 API に `isInternal` を通し、管理画面の友だち詳細でトグルできること。
初期投入として本人 1 名に立てる運用は手動でよい（マイグレーションでの決め打ち投入はしない）。

## Acceptance Criteria

- **AC-1**: `is_internal=1` の友だちが視聴・予約・CTAクリック・フォーム送信を行っている状態で、
  `GET /api/webinars/:id/analytics?excludeInternal=true` を叩くと、
  **7ブロックすべて**がその友だちを含まない値を返す（`participants` 配列にも現れない）。
- **AC-2**: 同じ状態で `excludeInternal` を付けずに叩くと、**従来と同一の値**を返す。
- **AC-3**: 管理画面のウェビナー分析タブを開くと、**初期表示が除外済みの数字**になっており、
  除外中であることが画面から分かる。チェックボックスで全件表示に切り替えられる。
- **AC-4**: `is_internal` の値を変えても、`processWebinarFollowups` と `processWebinarReminders` の
  **送信対象は1件も変わらない**（テストで担保する）。
- **AC-5**: 友だちの更新 API 経由で `is_internal` を 0/1 に変更でき、管理画面から操作できる。

## 検証

- `pnpm test`（`packages/db` のテストは `test/` 配下に置く。`src/*.test.ts` は vitest の
  `include` に入らず走らない）
- migration の採番は **078**（`077_webinar_funnel_upstream_tags.sql` の次）。
  採番衝突を避けるため、着手時に `ls packages/db/migrations | tail -3` で再確認する。

## 担当範囲外

`webinar-followups.ts` / `webinar-reminders.ts` / 追客の候補SQL / CTA の設定値。
これらは別途未決の論点があり、この PR では触らない。
