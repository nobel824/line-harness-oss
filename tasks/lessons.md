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
`deploy-cloudflare-worker.yml` が main への push/merge で発火し、`github.repository !=
'Shudesu/...'` ガードで upstream では走らず**フォークでのみ**実行。実 CF 認証は
フォークの GitHub Secrets（`CLOUDFLARE_API_TOKEN` 等）が patch する。
PR は必ず `--repo nobel824/line-harness-oss` 明示（upstream 宛て事故防止）。
