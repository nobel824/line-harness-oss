# 要件: 追客が「0通」のときの説明可能性を入れる

作成: 2026-08-30 / 規模: M / 状態: 実装前

## 1. 目的・背景

追客7ステージのどれかが **0通のとき、対象者が0なのか壊れて沈黙しているのかを外から判定できない。**

このプロジェクトで見つかった欠陥は**例外なく沈黙故障**だった（`booking_url` が null で2ステージが数日沈黙 /
重複ガードが `status` を見ておらず失敗行が永久に再送されない / `add_tag` がシナリオを起動しない）。
落ちない・エラーも出ない・ログにも残らない。

**直近の実例（2026-08-30）**: 「翌日の未参加フォロー（`registered_no_show`）が予期した日に飛んでいない」を
調査したが、本番 D1 を読む手段がないため**コードと集計からの推論**でしか説明できなかった。
結論は「予約可能な回が `REGISTRATION_LEAD_DAYS = 3` で3日先以降に制限されたため、その日には対象者が
構造的に0」＝正常。**判定に半日かかり、しかも裏が取れていない。**

`tasks/state.md` の ship 条件3・積み残し2 が指している穴がこれ。

## 2. 現状の観測手段（すべて不足）

| # | 手段 | 不足 |
|---|---|---|
| 1 | cron のログ | `if (sent + failed > 0)` のときだけ1行。**0通なら完全に沈黙**（`scheduled.ts:173`） |
| 2 | `wrangler tail` | **過去に遡れない**（保存されていない） |
| 3 | `GET /api/webinars/:id/analytics` | 集計のみ。**候補件数・落ちた理由・予約の回別内訳は出ない** |
| 4 | D1 直接クエリ | 不可（API トークンに D1 権限が無く、追加はユーザー作業） |

## 3. 設計判断（Fable 5 に当てて PM が裁定）

**アドバイザーの結論**: 案C（オンデマンド診断）を軸に、案A（常時ログ）を無条件で足す。
案B（毎tick観測行 INSERT）は読む人がいないデータを積むだけなので不採用。

**PM の裁定 — アドバイザー案から1点変更**:
アドバイザーは「候補0の理由を**段階的な絞り込み件数**で出し、最終段と実SQLの件数を突き合わせて
drift フラグを立てる」を提案した。**これは採らない。**
7ステージ × 5段の絞り込みを別途書くと候補SQLと二重管理になり、drift 検出はその**症状**への対処でしかない。

代わりに **「実候補件数（本番SQLをそのまま実行）＋ 母集団 ＋ 抑止行の内訳 ＋ 設定ブロッカー」** の4点だけを出す。
母集団は候補SQLの WHERE のコピーではなく「**そのステージの入口イベントが起きた人数**」という
**独立に意味のある数字**なので、候補SQLを直しても嘘にならない。**二重管理が構造的に発生しない。**

この4点で、0通は次の6つに判別できる:

| verdict | 条件 | 意味 |
|---|---|---|
| `blocked_by_config` | ブロッカーあり | 設定が欠けてステージが丸ごと死んでいる（`booking_url` null の前例） |
| `has_candidates` | 候補 > 0 | 次の tick で送信される候補がある＝異常ではない |
| `undetermined` | 候補 0 かつ `candidatesTruncated = true` | 全ウェビナー横断の `LIMIT 50` で候補全体を判定できない |
| `suppressed` | 抑止行（送信済み・スキップ済み・恒久ブロック）> 0 | 送信済み・スキップ済み・恒久ブロックで消えた＝正常 |
| `no_population` | 抑止行 0、母集団 0 | 入口イベントがまだ誰にも起きていない＝正常 |
| `needs_investigation` | 抑止行 0、母集団 > 0、候補 0 | **説明がつかない＝故障の疑い** |

判定順（上から優先）は `blocked_by_config` → `has_candidates` → `undetermined` →
`suppressed`（抑止行 > 0）→ `no_population`（母集団 = 0）→ `needs_investigation`。

`needs_investigation` が出ることが、この機能の唯一の存在理由。

## 4. 機能要件

### F-A: cron のログを常時1行にする

`scheduled.ts` の `if (result.sent + result.failed > 0)` を外し、**0通でも必ず1行出す**。
候補件数を含めるため `processWebinarFollowups` の戻り値に
`candidates: Record<kind, number | null>` を足す（候補SQL失敗は `null`）。

**候補SQLは毎tick既に実行されており件数は手元にある。CPU は増えない。**

### F-B: Workers Logs を有効化

`apps/worker/wrangler.toml` の既定側と `[env.production]` の両方に `[observability] enabled = true`。
ログが Cloudflare 側に保存され、ダッシュボードから検索・遡及できるようにする。

### F-C: 診断エンドポイント

`GET /api/webinars/:id/followup-diagnostics`（`requireRole` は既存 analytics と同じ扱い）

```json
{
  "config": { "isActive": true, "stageEnabledAt": "...", "bookingUrl": "...", "bookingMenuId": "...",
              "noShowDelayMinutes": 1380, "...": "..." },
  "stages": {
    "registered_no_show": {
      "candidates": 0,
      "candidatesTruncated": false,
      "population": 3,
      "rows": { "sent": 2, "skipped": 0, "failed": 0, "pending": 0, "permanentlyBlocked": 2 },
      "blockers": [],
      "verdict": "suppressed"
    }
  },
  "registrationsBySession": [
    { "sessionStartAt": 1787914800, "friends": 2, "ended": true }
  ]
}
```

- **`candidates`**: `candidates()` / `journeyCandidates()` を**そのまま呼び**、この webinar の分だけ数える
- **`candidatesTruncated`**: 候補SQLに `LIMIT 50` があるため、50 件に達したら `true`
- **`population`**: 下表の定義
- **`rows.permanentlyBlocked`**: `status IN ('failed','pending')` かつ `created_at + 24h < now` の行数
  （#70 で入れた恒久抑止。**これが state.md ship 条件3 の「失効がログに残らない」の直接の答え**）
- **`blockers`**: ステージを丸ごと殺す設定欠落。下表
- **`registrationsBySession`**: `stage_enabled_at` 以降に作られた予約の、回ごとの DISTINCT friend 数と
  「その回が既に終了したか」。**今回の調査で最初に欲しかった数字**

#### 母集団の定義（候補SQLのコピーではない）

すべて「`stage_enabled_at`（無ければ `enabled_at`）以降」に限る。

| ステージ | 母集団 |
|---|---|
| `after_30m` / `after_24h` | CTA をクリックした DISTINCT friend 数 |
| `picker_no_registration` | ピッカーを開いた DISTINCT friend 数 |
| `registered_no_show` | 予約のうち**回が既に終了している**もの の DISTINCT friend 数 |
| `submitted_no_booking_30m` / `_24h` | 相談フォームを送信した DISTINCT friend 数 |
| `archive_closing` | 予約のうち**回が既に終了している**もの の DISTINCT friend 数 |

#### ブロッカーの定義

| コード | 条件 | 影響するステージ |
|---|---|---|
| `config_inactive` | `is_active = 0` | 全ステージ |
| `booking_url_missing` | `booking_url IS NULL` | `submitted_no_booking_30m` / `_24h` |
| `booking_menu_missing` | `booking_menu_id IS NULL` | `submitted_no_booking_30m` / `_24h` |
| `form_cta_missing` | `webinar_ctas` に `kind='form' AND form_id IS NOT NULL` が無い | `after_30m` / `after_24h` |

## 5. Acceptance Criteria

- **AC-1**: cron が1 tick 実行されたとき、送信0通・失敗0件でも
  `[webinar-followups]` で始まる行が**必ず1行**出力される。
- **AC-2**: そのログ行には7ステージすべての候補件数が含まれる（該当0のステージも `0` として出る）。
- **AC-3**: `GET /api/webinars/:id/followup-diagnostics` が、7ステージそれぞれについて
  `candidates` / `population` / `rows` / `blockers` / `verdict` を返す。
- **AC-4**: 母集団 > 0・抑止行 0・候補 0 のステージについて、`verdict` が `needs_investigation` になる。
- **AC-5**: `booking_url` が null のとき、`submitted_no_booking_30m` / `_24h` の `blockers` に
  `booking_url_missing` が入り、`verdict` が `blocked_by_config` になる。
- **AC-6**: `is_active = 0` のとき、全ステージの `verdict` が `blocked_by_config` になる。
- **AC-7**: `registrationsBySession` が、`stage_enabled_at` 以降に作られた予約について
  回ごとの DISTINCT friend 数を返し、**同じ friend が複数の回に予約していれば回ごとに数える**
  （候補SQLの `MAX(session_start_at)` とは別の集計であることを明示する）。
- **AC-8**: `candidates` は `candidates()` / `journeyCandidates()` の**戻り値を数えたもの**であり、
  診断のために候補条件を書き直していない。
- **AC-9**: 候補が `LIMIT 50` に達したとき `candidatesTruncated` が `true` になる。
- **AC-10**: `rows.permanentlyBlocked` が、`status IN ('failed','pending')` かつ
  `created_at + 24時間 < 現在` の行数を返す。
- **AC-11**: ビルドで生成される `dist/line_harness/wrangler.json` に
  `observability.enabled = true` が含まれる。

## 6. 非機能要件

- **診断エンドポイントは cron に影響を与えない。** `processWebinarFollowups` の中に診断処理を足さない
  （Free プランの CPU 10ms 上限で cron が毎tick死んだ前例がある）。
- 診断は7ステージ分の候補SQL＋集計を1リクエストで流す。D1 クエリは I/O 待ちで CPU をほぼ食わないが、
  **`?stage=<kind>` で1ステージだけ引ける形にしておく**（重かったときの逃げ道）。
- 書き込みは一切しない（読み取り専用）。

## 7. 検証手段

| AC | 検証 |
|---|---|
| AC-1 / AC-2 | `apps/worker` の vitest。`processWebinarFollowups` を候補0で回し、`console.log` が1回呼ばれ 7 kind すべてを含むこと |
| AC-3〜AC-10 | **`better-sqlite3` のインメモリDBを D1 互換シムで包んだ実SQLテスト**。雛形は `packages/db/test/webinar-journey-stats.test.ts` の `asD1()`、実例は `apps/worker/src/services/webinar-followups-sql.test.ts`。**`prepare().all()` を stub したテストは書かない**（29 tests あって SQL を何も担保していなかった前例） |
| AC-11 | `pnpm --filter worker exec wrangler deploy --dry-run --outdir <tmp>` を流し、生成された `wrangler.json` に `observability.enabled` があること（`jq` で確認） |
| 全体 | `cd apps/worker && npx vitest run` 全緑 ／ `npx tsc --noEmit` exit 0 |

**新しいテストは必ず変異させて空振りでないか確かめること。** 変異のさせ方と結果を報告に含める。

## 8. 受入条件（DoD）

- [ ] AC-1〜AC-11 すべてにテストが対応し緑
- [ ] 追加テストを最低3本、実装側を変異させて FAIL することを確認済み
- [ ] `tsc --noEmit` exit 0 / 既存テスト全緑
- [ ] 本番で `GET /api/webinars/eec8dea0-.../followup-diagnostics` を叩き、
      `registered_no_show` の verdict が今回の推論（`suppressed` または `no_population`）と一致する
- [ ] `needs_investigation` が出たステージがあれば、その場で原因を追う

## 9. Out of scope（今回やらないこと）

- **管理画面の UI。** curl で読めれば足りる。UI を足すのは診断が実際に使われてから
- **抑止・失効の `skipped` 行化**（アドバイザー提案3）。候補SQLの意味論を変えるためリスクの階層が違う。**別 PR**
- **ハートビートの1行 UPSERT**（アドバイザー提案4）。Workers Logs の保持で不足だと実証されてから
- **`?as_of=` の過去再現モード。** 送信済み行や status 遷移は巻き戻らないので参考値にしかならない
- **D1 API トークンの権限追加**（ユーザー作業）
- 候補SQL自体の変更。**この PR は1行も候補条件を触らない**

## 10. 影響範囲

| ファイル | 変更 |
|---|---|
| `apps/worker/src/scheduled.ts` | F-A: ログを常時出力に |
| `apps/worker/src/services/webinar-followups.ts` | F-A: 戻り値に候補件数を足す／`candidates` `journeyCandidates` を export |
| `apps/worker/src/services/webinar-followup-diagnostics.ts`（新規） | F-C の本体 |
| `apps/worker/src/routes/webinars.ts` | F-C: エンドポイント追加 |
| `apps/worker/wrangler.toml` | F-B: `[observability]` × 2箇所 |
| テスト（新規） | 上記の検証手段のとおり |

**候補SQLの条件は1行も変えない。** 変えたら「診断のために本番の挙動が変わった」ことになる。
