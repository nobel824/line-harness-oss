# Project Instructions

- ゴールから外れる提案をしないでください。
- ゴールに進む提案を必ずしてください。
- 回答には必ず「次のタスクはこれ」「今の進捗を全体像から整理するとこれ」を含めてください。
- 私が大学生だと思って、言語化してください。
- L Harness Proxy から担当者として1対1返信する場合は、`X-Line-Harness-Source: manual` を必ず付けてください。予約通知などの自動送信には付けないでください。
- Google Meetの個別相談を確定・変更した場合は、カレンダー更新だけで終えず、`POST /api/meet-consultations` にGoogle Calendar event ID・LINE friend ID・日時・Meet URLを登録してください。前日・1時間前のLINEリマインドを必須セットにします。キャンセル時は `DELETE /api/meet-consultations/:externalEventId` も実行してください。

## Repository contract

- ローカル開発の入口は `README.md`、環境変数と外部サービスの契約は `docs/environment-contract.md` を正本とします。
- 秘密値はリポジトリへ保存しません。`.env.example` は変数名だけを示し、値は空のまま維持します。
- NO WAVE環境のKeychain ID・secret binding・疎通状態は `nowave-ops` を正本とし、このリポジトリへ複製しません。未登録・曖昧なbindingを推測で補完しません。
- `NEXT_PUBLIC_ADMIN_API_KEY` は設定しません。空文字を含め、この変数名が定義されているとWeb buildと`pnpm verify:readiness`は値を表示せず停止します。`NEXT_PUBLIC_*` はbrowser bundleへ公開されるため、Workerの`/admin/update/*`を守るcredentialにはなりません。現行のbrowser自己更新UIはコードで固定offです。環境設定だけでは再有効化できません。Cloudflare Access等のserver-side認証を更新routeへ実装・検証し、コードと挙動testを変更するまでは自己更新をローカルの`create-line-harness update`に限定します。
- `ADMIN_API_KEY` はWorker自己更新routerのserver-side secretです。ローカルの`create-line-harness update`も現在は同名envを任意で読み、`/admin/version`へ`x-admin-api-key` headerを付けます。`LINE_HARNESS_API_KEY`はMCPクライアントが通常APIへBearer認証する名前であり、同じ用途・値と仮定しません。
- plugin templateは`LINE_HARNESS_API_URL`、secretの`LINE_HARNESS_API_KEY`と`EXTERNAL_API_KEY`が必須で、`LINE_ACCOUNT_ID`は任意です。詳細は`packages/plugin-template/README.md`を正本とします。
- 今回のCodex利用準備・整理差分のship gateは `pnpm verify:readiness` です。`pnpm verify:local` は全workspaceを対象に、既知の失敗も隠さず非zeroで返すrepository全体の包括診断です。依存関係を初回取得する `pnpm install` 自体はネットワークを使用します。

## Safety gates

- Cloudflareへのdeploy、D1のremote migration、LINEメッセージ送信、MCPの書き込みツール、公開・外部送信は、実行前にユーザー承認を得てください。
- Google Calendarイベント・Meet・Stripe・LINE Developers・Cloudflareの本番設定を変更する操作も外部書き込みとして扱います。
- ローカル検証では本番secretを要求せず、`.env.example` の空欄を実値で埋めません。
