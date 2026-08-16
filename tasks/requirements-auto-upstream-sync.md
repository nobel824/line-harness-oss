# requirements: upstream 自動同期の修復と自動デプロイ

- Status: Draft
- Date: 2026-07-17
- 規模: M（新規ファイル含む / 危険 zone = migration を含む）

## 1. 目的・背景

フォーク `nobel824/line-harness-oss` を本体 `Shudesu/line-harness-oss` の更新に追従させる自動化
（`.github/workflows/update-from-upstream.yml`、日次 cron）は**2026-07-09 以降 8 日連続で失敗**しており、
upstream のコミットが 32 件滞留している。ユーザーは「マージ・デプロイまで完全自動」を要望。

**失敗原因（実測・再現済み）**: `git merge upstream/main` が `packages/db/bootstrap-meta.json` で
コンフリクトし、ワークフローがその時点で異常終了して PR すら作られない。同ファイルは
`packages/db/scripts/generate-bootstrap.mjs` の**生成物**で、フォーク・本体の双方が独自 migration を
足すたびに再生成するため、**構造的に毎回コンフリクトする**。

**self-update は採用しない（調査で確定）**: `@line-harness/update-engine` は upstream の GitHub Releases
のビルド済み成果物で Worker と管理画面を**丸ごと置換**する（`packages/update-engine/src/phases/apply.ts`)。
フォーク独自機能（フォーム管理 UI、webhook dedup）が消えるため、本体自身が fork 判定で 409 を返して
無効化している（`apps/worker/src/routes/admin-update.ts` の fork ガード、`docs/wiki/26-Manual-Update.md`）。
→ **フォークの正しい更新経路は git 同期のみ**。

## 2. 機能要件 / User Story

- 運用者（奥田）として、upstream の更新を**手を動かさずに**本番へ反映したい。ただし**戻せない本番データ操作**は
  自分の目を通してから適用したい。

## 3. Acceptance Criteria（EARS・危険 zone のため必須）

| # | 条件 | 期待結果 |
|---|------|---------|
| AC1 | When upstream/main に未取り込みコミットが存在し、マージのコンフリクトが生成ファイルのみで、CI が緑で、新規 migration にデータ破壊操作が無い | the workflow shall main へマージし、worker/admin のデプロイを**明示的に dispatch** する |
| AC2 | When コンフリクトが生成ファイル（`packages/db/bootstrap-meta.json` / `packages/db/bootstrap.sql` / `pnpm-lock.yaml`）のみ | the workflow shall 再生成で自動解決し処理を継続する |
| AC3 | When 生成ファイル以外のコンフリクトが残る | the workflow shall 自動マージを中止し、コンフリクト状態のブランチを push して PR を作り、対象ファイルを PR 本文に列挙する |
| AC4 | When 新規 migration に データ破壊操作（`DELETE FROM` / `DROP` / `TRUNCATE` / `UPDATE`）が含まれる | the workflow shall 自動マージせず PR を作り、該当ファイルと該当行を PR 本文に警告として明示する |
| AC5 | When CI（typecheck / test / build）が失敗 | the workflow shall 自動マージせず PR を作り、失敗内容を PR 本文に記す |
| AC6 | When upstream に未取り込みコミットが無い | the workflow shall 何もせず成功終了する |
| AC7 | 常時 | the workflow shall 既存 migration ファイルを**リネーム（採番し直し）しない** |
| AC8 | 常時 | the workflow shall `Shudesu/line-harness-oss` 上では実行されない |

### AC7 の根拠（load-bearing・絶対に動かさない前提）

`deploy-cloudflare-worker.yml` の migration ランナーは `_migrations` テーブルを**ファイル名**で追跡する
（`name=$(basename "$f")` → `SELECT name FROM _migrations WHERE name = '${name}'`）。番号では見ていない。
したがって:
- フォークの `049_webhook_event_dedup.sql` と本体の `049_tracked_links_short_code.sql` は**番号が重複しても
  両方そのまま正しく共存する**（実測: 再生成後の `includedMigrations` に両方が並ぶ・計 57 件）。
- 逆に**採番し直すと適用済みファイルが未適用扱いになり再実行される** → 事故。
→ 採番し直しロジックは**作らない**。番号重複は表示上の問題に過ぎない。

## 4. 非機能要件

- ワークフロー実行は 15 分以内（CI 相当のビルド + テストを含む）。
- 失敗時は必ず PR という形で痕跡が残る（silent fail を作らない）。
- upstream 所有ファイルへの変更は最小に留める（将来のマージ衝突を増やさないため）。
  → データ破壊検査は既存 `scripts/check-migrations.ts` を**改変せず**、新規ファイルとして追加する。

## 5. 検証手段

| AC | 検証コマンド / 期待出力 |
|----|----------------------|
| AC2 | ローカル worktree で `git merge upstream/main` → `node packages/db/scripts/generate-bootstrap.mjs` → `grep -c '<<<<<<<' packages/db/bootstrap-meta.json` が `0`（**実測済み**） |
| AC4 | `pnpm test:scripts` — 新規 `scripts/check-migration-data-safety.test.ts` が緑。`048_chats_friend_unique.sql`（`DELETE FROM` を含む実物）を検知し、`049_tracked_links_short_code.sql`（純追加）を通すこと |
| AC7 | `node -e "require('./packages/db/bootstrap-meta.json').includedMigrations"` に 049 が 2 本並ぶ（**実測済み**） |
| AC1/3/5 | `gh workflow run update-from-upstream.yml` を実際に起動し、`gh run view` で結果確認。今 32 件滞留しているため実物で検証可能 |
| AC6 | 同期完了後にもう一度 dispatch し、`has_changes=false` で成功終了すること |

## 6. 受入条件（DoD）— 2026-07-17 完了

- [x] `pnpm test:scripts` が緑（66 件 / うちデータ安全検査 29 件）
- [x] ワークフローを実起動し、滞留 32 件が main に入り本番デプロイまで到達
      （run 29579524120 でマージ `ac50c8e`、未取り込み upstream 0 件。デプロイは
      GH_REPO バグ修正後に到達。worker/admin とも success、`/admin/version` 200）
- [x] 危険 migration 検知のテストが `048` の実物 SQL で発火する
- [x] 独立レビュアー（fresh context）の「致命」「重要」指摘が 0（2 巡: 致命 2・重要 6 → 全対応）
- [x] AC6 実証: 再起動して差分ゼロで正常終了（run 29579921018 = success、PR/Issue 作らず）
- [x] AC7 本番実証: `Applying: 049_tracked_links_short_code.sql` / `Skipped: 049_webhook_event_dedup.sql`
      = 同番号の 2 migration が共存し、再適用も起きない
- [x] 通知経路の疎通確認（Issue #17 を作成 → close）

### 実起動で判明し修正した実バグ（2 巡のレビューでは出なかった）

1. **`gh` が本体 Shudesu を既定リポジトリに解決** → `gh workflow run` が 403 で落ち、
   マージ成功なのにデプロイ不発（= §9 失敗モード #4 の実現）。通知も道連れで失敗。
   → workflow レベル `env: GH_REPO` で固定（PR #16）。
2. **フォークは Issues が既定で無効** → 安全網の Issue 通知が動かなかった。
   → リポジトリ設定で有効化し疎通確認済み。**無効に戻すと通知が死ぬ。**

教訓: コードレビューは静的な欠陥をよく捕まえたが、**環境に起因する欠陥（既定リポジトリの
解決・リポジトリ設定）は実起動でしか出なかった**。危険 zone の自動化は実起動まで DoD に含める。

## 7. Out of scope

- self-update（update-engine）の有効化 — 上記理由により**採用しない**
- LIFF 友だち追加ループの修正（別件・未着手）
- upstream 本体への PR（禁止・`no-touch-shudesu-upstream`）
- 採番し直しロジック（AC7 の理由により不要かつ有害）

## 8. 影響範囲

| ファイル | 変更 | 所有 |
|---------|------|------|
| `.github/workflows/update-from-upstream.yml` | 全面書き換え | upstream 所有（将来の衝突は「コンフリクト → PR」で受け止める） |
| `scripts/check-migration-data-safety.ts` | **新規** | フォーク所有（衝突しない） |
| `scripts/check-migration-data-safety.test.ts` | **新規** | フォーク所有 |

## 9. 失敗モード列挙（痛い順）

| # | 失敗モード | 対処 |
|---|-----------|------|
| 1 | 本番データを消す migration が無人で適用される | AC4 のゲートで停止。`rollback.ts` の通り D1 は戻せないため最優先 |
| 2 | 採番し直しで適用済み migration が再実行される | AC7 でロジック自体を作らない |
| 3 | コンフリクトを機械が誤って解決し、独自機能が壊れる | AC2 で生成ファイルに限定。それ以外は人間へ |
| 4 | GITHUB_TOKEN の push でデプロイが発火せず、コードだけ進んで本番が古いまま | **AC1 で明示 dispatch**（GitHub は GITHUB_TOKEN 由来の push でワークフローを起動しない仕様） |
| 5 | CI 緑を騙るためテストが書き換えられる | 本 workflow はテストを実行するだけで改変しない |
| 6 | ワークフローが毎日失敗し続けても誰も気づかない | 失敗は必ず PR として残す（非機能要件） |
| 7 | **本体が workflow ファイルを変更した回に push が拒否され、PR すら作られない** | **2026-08-16 に実際に発生**（下記「同期用 PAT」）。`UPSTREAM_SYNC_TOKEN` で解消 |
| 8 | PAT の期限切れで 7 が再発する | 残り 30 日で Issue を 1 度立てる（`Warn before the sync PAT expires`） |
| 9 | PAT push で deploy が自動発火し、明示 dispatch と二重にデプロイされる | dispatch は PAT 未設定時のみ実行。二重適用は D1 migration の競合になる |

## 10. [ASSUMPTION]

- `gh workflow run`（workflow_dispatch）は `GITHUB_TOKEN` でも発火する。
  **検証方法**: AC1 の実起動でデプロイ run が生成されるかを `gh run list` で確認。
  発火しない場合は PAT（`secrets.DEPLOY_DISPATCH_TOKEN`）へ切り替える。
  → **2026-08-16 に検証済み・成立**（`gh workflow run` は GITHUB_TOKEN で発火した）。

## 11. 同期用 PAT（`UPSTREAM_SYNC_TOKEN`）

### なぜ要るか

本体が `.github/workflows/*` を変更した回、`GITHUB_TOKEN` での push は

```
! [remote rejected] ... (refusing to allow a GitHub App to create or update
  workflow `.github/workflows/deploy-cloudflare-admin.yml` without `workflows` permission)
```

で拒否される。`permissions: contents: write` を付けても効かない — GitHub App トークンに
workflow 権限を与える手段が無いため。この経路では **draft PR すら作られず**、Issue に
コメントが積まれるだけになる。2026-08-01〜08-16 の 17 日連続でこの状態になり、本体から
40 コミット遅れた（PR #25 で手動同期）。

### 発行手順

1. https://github.com/settings/personal-access-tokens → **Fine-grained personal access token**
2. Repository access: **Only select repositories** → `nobel824/line-harness-oss` だけ
3. Repository permissions:
   - **Contents**: Read and write（push）
   - **Workflows**: Read and write ← **これが本題**
   - **Pull requests**: Read and write（PR 作成）
   - **Issues**: Read and write（失敗通知・期限警告）
4. Expiration: 1 年（無期限も可。期限を付けた場合は残り 30 日で Issue が立つ）
5. リポジトリの Settings → Secrets and variables → Actions → **New repository secret**
   - Name: `UPSTREAM_SYNC_TOKEN`
   - Secret: 発行したトークン

### 挙動の違い（設定の有無で変わる）

| | PAT あり | PAT なし（従来） |
|---|---|---|
| workflow ファイルを含む同期 | 通る | **push 拒否 → 同期が止まる** |
| main への push | PAT | GITHUB_TOKEN |
| deploy の起動 | `push: branches: [main]` が自動発火 | `gh workflow run` で明示 dispatch |
| 期限切れ警告 | 残り 30 日で Issue | 対象外 |

**PAT で push すると deploy が自動発火する**ため、明示 dispatch は PAT 未設定時だけ実行する。
両方走らせると worker デプロイが二重になり、D1 migration の同時適用で競合しうる。

### 期限が切れたら

push が 403 になり `Notify on unexpected failure` が Issue を立てる。新しい PAT を発行して
Secret を差し替えれば、次の実行から復帰する（取りこぼした分は溜まっているだけなので、
1 回の同期でまとめて追いつく）。
