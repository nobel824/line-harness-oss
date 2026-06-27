# Lessons (line-harness-oss / nobel824 fork)

リポジトリ固有の学び。同じミスを繰り返さないためのパターン集。

## 2026-06-27 未対応カウントは read/write の chat 行選択 (DESC/ASC) 一致を疑う

**症状**: 「解決済にする」を押しても未対応カウントが減らない。一部の friend だけ、かつ
「相手からメッセージが来た場合のみ」発生。

**根本原因**: `chats` は friend_id に UNIQUE 制約が無く 1 friend に複数行ありうる。
読み取り側（未対応カウント / チャット一覧 / 友だち一覧 / `getChatByFriendId`）は全て
**最新行 `created_at DESC`** を読むのに、書き込み側 `resolveOrCreateChat`（= 解決済ボタンの
PUT /api/chats/:id）だけが **最古行 `created_at ASC`** を更新していた。複数行 friend では
resolve が古い行に `resolved` を書き、カウントは新しい行の `unread` を読むため消えない。
incoming が無いと未対応候補に出ないので「相手から来た時だけ」見える。

**修正**: `resolveOrCreateChat` の既存行ルックアップ＆lazy-create 後の再読込を canonical
アクセサ `getChatByFriendId`（DESC）に統一し、resolve の書き込み行と読み取り行を一致させた。
データ移行は不要（デプロイ後にもう一度「解決済」を押せば最新行が更新されて消える）。

**教訓 / How to apply**:
- カウントやバッジ系の「消えない/減らない」バグは、**同じ論理エンティティに対する read と
  write が同じ物理行を指しているか**をまず確認する。`ORDER BY created_at ASC` と `DESC` の
  混在は典型的な発火点。
- `chats` のような「1:多になりうるが実質 1 を期待」しているテーブルは、UNIQUE 制約が無いか
  確認し、行選択セマンティクスを 1 箇所（canonical accessor）に集約する。
- この種の SQL 行選択ズレは stubDB（canned 結果）では再現できない。**実 SQLite
  (`better-sqlite3` を D1 風 adapter で包む)** で統合テストを書く必要がある。
  参考: `apps/worker/src/routes/chats.resolve-multirow.test.ts`。

## 2026-06-27 デプロイは「フォーク origin の main に merge → GitHub Actions」が唯一の正規経路

ローカル `wrangler deploy` は不可（`wrangler.toml` は placeholder ID）。
`deploy-cloudflare-worker.yml` が `github.repository != 'Shudesu/...'` ガードで upstream では
走らず**フォークでのみ**実行。実 CF 認証はフォークの GitHub Secrets が patch する。
PR は必ず `--repo nobel824/line-harness-oss` 明示（upstream 宛て事故防止）。

- **push トリガーはフォークでは発火しない**。`gh workflow run deploy-cloudflare-worker.yml --ref main`
  の **workflow_dispatch で手動起動**する。
- **本番 D1 への直接アクセス（wrangler d1 execute --remote）は auto モードで遮断される**。
  デプロイ系の DB 操作は CI（正規 token）に任せる。

## 2026-06-27 デプロイ・パイプラインに 3 つの既存不備があった（いずれも初回 CI 成功を阻害）

`ai-komon` はこれまで CI デプロイが一度も成功しておらず（run 0 件）、本番は 2026-06-13 の
手動 upload のまま動いていた。修正をデプロイしようとして以下が順に露見し、すべて解消した。
**いずれもアプリのバグとは無関係のパイプライン不備**。今後は main 更新だけで回る。

1. **`CLOUDFLARE_API_TOKEN` シークレット未設定** — 他3つ（ACCOUNT_ID / D1_DATABASE_ID /
   D1_DATABASE_NAME）はあるのにトークンだけ欠落。マイグレーション段冒頭の `test -n` で即失敗。
   → ユーザーが Cloudflare でトークン作成し GitHub Secrets に追加。
2. **bootstrap 構築 DB の `_migrations` 未 baseline** — setup の `bootstrap.sql` は全 migration を
   内包するのに `_migrations` 追跡表が空。CI が 001 から再適用し `duplicate column name` で停止。
   → 適用ループ直前に baseline ステップを追加（`_migrations` が空のときだけ `bootstrap-meta.json`
   の `includedMigrations` を applied 登録、`INSERT OR IGNORE`、冪等）。安全性は日付で検証
   （migration 最終追加 2026-05-20 / bootstrap 2026-05-22 ＜ DB 作成 2026-06-10 ＝ 未適用 0 件）。
3. **依存ビルド段が `@line-harness/update-engine` を作らない** — worker は self-update で
   update-engine（main=dist/index.cjs）に依存するのに、ビルドが shared/line-sdk/db の 3 つだけ。
   dist 不在で vite が `Failed to resolve entry` 失敗。→ ビルド対象に update-engine を追加
   （worker の buildable workspace 依存 = shared/line-sdk/update-engine、db はビルド不要）。

**教訓**: 「一度も成功していない CI」を初めて通すときは、blocker が 1 つとは限らない。
1 つ直すと次が露見する前提で、ステップ単位で潰す（secret → migration baseline → 依存ビルド →
config patch → deploy）。各失敗は `gh run view <id> --log-failed` で該当ステップだけ読む。
