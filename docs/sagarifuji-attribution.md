# Saga専用refのローカル集計

`sagarifuji-threads` はcampaignに使わない予約refです。`/r/sagarifuji-threads?account=2011217182` は、そのaccountのLIFFを解決できる場合だけ案内します。account欠落・不一致・未解決・LIFFなしでは停止します。直接LIFF/OAuthからのref保存も、ID token検証に使われたlogin channelから解決したaccountと、friendの現在の所属が両方一致する場合に限ります。OAuth state/queryのaccountだけでは帰属を認めません。既存の非NULL初回refは保持します。

集計には、明示したローカルSQLite snapshotだけを使います。snapshotの取得や本番への接続はこのスクリプトの機能に含みません。

```bash
python3 scripts/sagarifuji-attribution.py /path/to/local-snapshot.sqlite
```

SQLiteを`mode=ro`と`query_only`で開き、個別friend・相談・パスなどは出力しません。既存の`line_accounts`でchannel IDを内部account IDへ解決し、`friends`・`ref_tracking`・`meet_consultations`から次をJSONで返します。

- `firstRefFriends`: 現在指定accountに所属し、初回`ref_code`が専用refと完全一致する一意のfriend数。既存friendのNULL refへの初回保存も含むため、新規LINE登録数ではありません。
- `consultationsAfterObservedTouch`: 上の集合のうち、最も早い有効な専用ref観測時刻以後に作成された、`confirmed`/`completed`の一意の相談数。同時刻を含み、`cancelled`・到達前・他account・他初回refを除きます。
- `unknownConsultations`: 上の集合の`confirmed`/`completed`の相談で、専用touch欠測・有効touchなし・相談作成時刻不明により帰属を判定できない一意の件数。理由別の欠測数は重複する場合があります。

`status=partial`は未知の相談を含みます。既知件数0と未知件数を別々に読み、相談総数0とは解釈しません。account未解決・DB/schema不足は`status=unmeasured`、件数は`null`、終了コード2です。

writerで確認済みのUTC `Z`と明示offsetの日時をUTCへ正規化します。`ref_tracking`の旧default（`packages/db/migrations/003_entry_routes.sql`の`datetime('now')`）による`YYYY-MM-DD HH:mm:ss`だけはUTCとして扱います。offsetなしの相談日時や壊れた日時を推測で補完しません。現在のwriterはref touchをJST offset、相談作成をUTC `Z`で保存します。

account所属は現在値です。touch時点のaccount履歴、初回refの保存時刻、直前接点、因果効果、媒体由来は証明しません。クリック総数・新規登録・売上・投稿別成約は未計測です。専用refを他媒体へ転載すると、その媒体を区別できません。

ローカル実装は新HTTP route・migration・LINE送信を追加しません。本番のref衝突確認、deploy、LIFF到達検収、Sagaの許可URL/CTA切替は別の作業です。今回、本番DBは読んでいません。
