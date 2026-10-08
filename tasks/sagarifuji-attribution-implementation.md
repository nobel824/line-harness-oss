# Saga専用LINE帰属の実装

2026-10-08。ユーザーの「無駄な検証を増やさないで、最短最速で実装して」を受け、保存済みの修正仕様から実装した。仕様レビューは再起動せず、本番データ・認証・Sagaの投稿設定は変更していない。

## 完了

- 専用refのaccount/LIFF解決はfail closed。本人確認済みの処理accountとfriend所属が一致する前に専用refを書き込まない。
- 既存の非NULL初回refを保持し、専用ref由来のcampaign処理を追加しない。
- ローカルSQLiteの読み取り専用集計を追加。現在のaccount所属・専用初回ref・最初の有効touchと予約作成時刻を使い、欠測を帰属不明として分ける。
- 実装担当の検証: 対象/隣接Vitest 41件、Python fixture 5件、worker typecheck成功。依存リンク補正で型検査を再実行したが、包括テストや範囲外の修正はしていない。
- Opus独立コードゲートは重大/重要0でpass。軽微2件のうち、混合caseの専用refを入口/保存前に拒否し、文書の相談status表現を揃えた。変更後の対象2ファイル29件成功。Python/型検査/隣接テスト/同じコードゲートは再実行していない。
- PMの最終差分確認: 上の軽微修正は受付条件を狭める変更と文書修正だけ。初回審査snapshot後のtest-only差分は、既存OAuth処理を完走するための空line_accounts fixture追加。

## 審査記録と裁定

既存CLI・設定でこのセッションの確認済みモデルを再利用した。コード・仕様だけを送信し、個人情報/秘密値/非公開実測は含めない。

| 担当 | 実ID/指定 | 結果 |
|---|---|---|
| Sonnet | claude-sonnet-5-5 | 初回/一度の再実行ともexit1、構造化結果なし。原因は未判別で、認証切れと断定しない |
| Grok | grok-4.7 | 360秒timeout、構造化結果なし。再試行せず、成功/認証切れ扱いしない |
| fresh Opus | claude-opus-5-5 | 構造化pass、重大/重要0、軽微2（修正済み） |

審査入力SHA・最終source SHA・実行時刻・実結果は `tasks/reviews/20261008-sagarifuji-attribution.json`。一時入力原本は `/private/tmp/20261008-saga-line-code-reviews/`。OpusのpassをSonnet/Grokの未取得結果へ代用しない。本番用の全ゲートが完了したとは扱わず、ローカル実装をドラフトPRとして保存する。

## 残作業

本番での同ref使用衝突確認、必要な未取得コード審査、本番反映、AstraによるLIFF到達検収、新URLの具体的な採用承認とSagaの許可URL切替。UI確認はユーザー方針で後回しにし、既存の投稿/補充/計測を中断しない。既存の予約本文・receipt・CTAを差し替えない。
