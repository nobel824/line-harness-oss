# Environment contract

L Harnessを別のCodexタスクから開いても、必要な外部依存と設定場所を推測せず確認できるようにするための一覧です。秘密値そのものはこのリポジトリへ保存しません。

## 設定面

| 面 | 設定先 | 用途 |
|---|---|---|
| Worker | Cloudflare Worker secrets / vars、D1・R2・Durable Object bindings | API、Webhook、LIFF、配信、予約、自己更新 |
| Web | `apps/web/.env.local` またはCloudflare Pages variables | 管理画面からWorkerへ接続 |
| MCP | MCPクライアントの環境変数 | AIクライアントからWorker APIへ接続 |
| ローカル検証 | 原則secret不要 | typecheckとunit test。外部サービスへ接続しない |

NO WAVE環境のKeychain ID、secret binding、疎通状態は `nowave-ops` のregistryとdoctorが正本です。この文書や`.env.example`へIDや値を複製しません。bindingが未登録または曖昧なら、稼働済みと判定せず`nowave-ops`側で解決します。

## Worker

### 基本運用で必要

| 変数・binding | 種別 | 用途 |
|---|---|---|
| `DB` | D1 binding | CRMデータ、設定、配信・予約状態 |
| `IMAGES` | R2 binding | 画像保存 |
| `ASSETS` | Worker Assets binding | LIFF SPA配信 |
| `TENANT_SCHEDULER` | Durable Object binding | 配信・リマインド等の定期処理 |
| `API_KEY` | secret | 通常APIのowner Bearer認証。staff API keyもD1から認証される |
| `LINE_CHANNEL_ACCESS_TOKEN` | secret | LINE Messaging API送信・プロフィール取得 |
| `LINE_CHANNEL_SECRET` | secret | `POST /webhook` のLINE署名検証 |
| `LINE_LOGIN_CHANNEL_ID` | secret/config | LINE LoginとLIFFのID token検証 |
| `LINE_LOGIN_CHANNEL_SECRET` | secret | `GET /auth/callback` のLINE Login OAuth |
| `WORKER_URL` | var | Workerの公開origin、callback・追跡URL生成 |
| `LIFF_URL` | var/secret | 既定LIFF URL。アカウント個別設定がない場合のfallback |

LINE側の主なcallbackは次です。

- Messaging API webhook: `<WORKER_URL>/webhook`
- LINE Login callback: `<WORKER_URL>/auth/callback`
- LIFF endpoint: 現行のWorker-assets構成ではWorker配下。旧構成では別のPagesプロジェクトを使う場合があります。

### 機能を有効にすると必要

| 変数 | 必須になる条件 | 用途 |
|---|---|---|
| `STRIPE_WEBHOOK_SECRET` | Stripe webhookを使う | `POST /api/integrations/stripe/webhook` の署名検証 |
| `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` | Google Calendar OAuth方式 | Calendar接続。callbackは `<WORKER_URL>/api/booking/google-calendar/oauth/callback` |
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` / `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY` | service account方式 | Calendar/Meet作成。対象Calendarをservice accountへ共有する |
| `ADMIN_API_KEY` | Worker自己更新APIを使う | `/admin/update/*`のserver-side secret。browserへ渡さない |
| `CF_API_TOKEN` | Worker自己更新APIを使う | WorkerからCloudflare APIを操作するsecret |
| `CF_ACCOUNT_ID` / `D1_DATABASE_ID` / `WORKER_NAME` / `ADMIN_PAGES_PROJECT` / `LIFF_PAGES_PROJECT` | 自己更新を使う | 更新対象Cloudflare resourcesの識別 |
| `MANIFEST_URL` / `WORKER_PUBLIC_URL` / `ADMIN_PUBLIC_URL` / `LIFF_PUBLIC_URL` | 自己更新を使う | release確認と更新後疎通確認 |
| `ADMIN_SSO_SECRET` | 外部SSOを使う | `/admin/sso` の署名。32文字以上。未設定時はroute自体が無効 |
| `ADMIN_BROWSER_AUTH_MODE` / `ADMIN_ACCESS_TEAM_DOMAIN` / `ADMIN_ACCESS_AUD` | Cloudflare Accessを使う | 管理画面browser認証 |
| `ADMIN_ORIGIN` / `ADMIN_ALLOW_CROSS_SITE` / `ADMIN_COOKIE_SAMESITE` | 管理画面とWorkerが別site | credentialed CORSとsession cookie制御 |
| `ADMIN_NOTIFY_LINE_USER_ID` | 更新通知をLINEへ送る | 自己更新結果の通知先 |
| `X_HARNESS_URL` | X Harness連携 | cross-account linking |
| `IG_HARNESS_URL` / `IG_HARNESS_LINK_SECRET` | IG Harness連携 | cross-platform linkingと署名 |
| `LOG_RETENTION_DAYS` | 保存期間を制限する | messages log保持日数 |
| `QUOTA_FRIENDS_MAX` / `QUOTA_MONTHLY_MESSAGES_MAX` / `QUOTA_NOTICE_URL` | quotaを使う | 利用上限と案内URL |
| `LEGACY_API_KEY` | API key rotation中のみ | 旧keyの猶予受付。恒久利用しない |

ローカルの`create-line-harness update`は`CLOUDFLARE_API_TOKEN`を読みます。Worker内の自己更新routeが読む`CF_API_TOKEN`とは設定面が異なり、名前を置き換えません。CLIは現在`ADMIN_API_KEY`も任意で読み、設定時はWorkerの`/admin/version`へ`x-admin-api-key` headerを付けます。これはCLI process内だけの任意入力で、browser公開値ではありません。`CLOUDFLARE_ACCOUNT_ID`と`D1_DATABASE_NAME`は既存のfork向けCloudflare deploy手順で使われる識別子です。

`LINE_CHANNEL_ID`は型に残る互換項目です。現行のLINE Login処理は`LINE_LOGIN_CHANNEL_ID`を使い、Messaging APIの複数アカウント情報はD1にも保存されます。新規設定で両者を推測して同一視しません。

## Web

| 変数 | 必須/任意 | 用途 |
|---|---|---|
| `NEXT_PUBLIC_API_URL` | 必須 | 管理画面から接続するWorker origin |
| `NEXT_PUBLIC_ADMIN_API_KEY` | **設定禁止** | build時にbrowser bundleへ露出する。空文字を含め、定義されているとWeb buildと`verify:readiness`が値を表示せず失敗する |
| `NEXT_PUBLIC_BASE_PATH` / `NEXT_BASE_PATH` | 任意 | subpath配信 |
| `NEXT_PUBLIC_API_MODE` | 任意 | API接続mode |

`NEXT_PUBLIC_ADMIN_API_KEY`をWeb / Pages環境へ設定しません。値をbrowserへ配布すると第三者も同じcredentialで更新APIを呼べます。誤設定やlegacy設定を見逃さないため、空文字でも変数名が存在すればWeb buildと`verify:readiness`を失敗させ、値自体は出力しません。現行のbrowser自己更新UIはコードで固定offで、`NEXT_PUBLIC_UPDATE_BANNER_ENABLED`を含む環境設定では再有効化できません。安全なserver-side認証が実装・確認されるまではローカルの`create-line-harness update`を使います。browser経由を再実装する場合は、Cloudflare Access等で更新route自体をserver-sideに保護したうえで、コードと挙動testの変更・レビューを必要とします。

## MCP

| 変数 | 必須/任意 | 用途 |
|---|---|---|
| `LINE_HARNESS_API_URL` | 必須 | Worker API base URL |
| `LINE_HARNESS_API_KEY` | 必須 | 通常APIへBearer認証するclient側の名前。Workerの`API_KEY`またはD1のstaff API keyに対応 |
| `LINE_HARNESS_ACCOUNT_ID` | 任意 | 操作対象LINEアカウントを固定 |

`ADMIN_API_KEY`と`LINE_HARNESS_API_KEY`は用途が異なります。前者は自己更新routerの`x-admin-api-key`、後者はMCPから通常APIへ送る`Authorization: Bearer`です。値が同じであると仮定しません。

MCPの読み取りは接続確認に使えますが、`broadcast`、`send_message`、シナリオ変更などは外部書き込みです。LINE送信・公開・本番反映はユーザー承認後に実行します。

## Plugin template

[`packages/plugin-template/README.md`](../packages/plugin-template/README.md)をpackage固有の正本とします。Workerと同梱MCP serverは次を使います。

| 変数 | 必須/任意 | 設定面・用途 |
|---|---|---|
| `LINE_HARNESS_API_URL` | 必須 | Worker `[vars]`またはMCP client env。接続先L Harness API |
| `LINE_HARNESS_API_KEY` | 必須secret | `wrangler secret put`またはMCP client env。L Harness通常APIのBearer認証 |
| `EXTERNAL_API_KEY` | 必須secret | `wrangler secret put`またはMCP client env。連携先serviceの認証 |
| `LINE_ACCOUNT_ID` | 任意 | Worker `[vars]`。複数LINEアカウント時の対象固定 |

## LIFF build

| 変数 | 必須/任意 | 用途 |
|---|---|---|
| `VITE_LIFF_ID` | 条件付き必須 | Worker Assets版LIFFの既定LIFF ID。URLに`?liffId=`が常に付く構成では省略可。deploy/release workflowとcreate-line-harnessがbuild時に渡す |
| `VITE_BOT_BASIC_ID` | 任意・互換 | deploy/release workflowとcreate-line-harnessが渡す公開build値。現行clientは友だち追加用IDをAPIから動的取得するためfallbackとしては参照しない |
| `VITE_CALENDAR_CONNECTION_ID` | 任意 | 予約LIFFのCalendar connectionを固定する場合に設定。slots/book requestへ`connectionId`として付与し、未設定時はserver側の既定接続を使う |
| `VITE_API_BASE` | 任意 | LIFF bundleが接続するAPI base。未設定時は同一origin |
| `VITE_DEFAULT_LIFF_ID` | 任意 | URLの`liffId`指定がない場合の既定LIFF ID |
| `VITE_BASE_PATH` | 任意 | LIFFをsubpathへ組み込む配布buildのasset base。未設定時は`/` |

これらはbrowser bundleへ入る公開値です。secretを設定しません。Viteが自動生成する`BASE_URL`は`VITE_BASE_PATH`から導出される内部値で、手動設定しません。

## CLI・release・build

### オペレーターが必要時だけ設定する値

| 変数 | 必須になる条件 | 用途 |
|---|---|---|
| `CLOUDFLARE_API_TOKEN` | `create-line-harness update`や非interactiveなCloudflare操作 | ローカルCLI用token。Worker secretの`CF_API_TOKEN`とは別の設定面 |
| `ADMIN_API_KEY` | `create-line-harness update`で任意headerを付ける | CLIが設定時だけ`/admin/version`へ`x-admin-api-key`を送る。browserへ渡さない |
| `CLOUDFLARE_ACCOUNT_ID` | fork向けdeploy手順 | Cloudflare account識別子 |
| `D1_DATABASE_NAME` / `D1_DATABASE_ID` | fork向けdeploy・migration手順 | D1 resource識別子 |
| `LINE_HARNESS_REPO_URL` | installerのclone元を公式repo以外へ変える | source repo URL override。未設定時は公式GitHub repo |
| `LINE_HARNESS_ALLOW_SOURCE_PUBLISH` | source treeからnpm publish guardを意図的に外す | `1`だけがbypass。通常は空のままにする |
| `NEXT_BASE_PATH` | Adminをsubpathへ組み込む配布build | Next.js `basePath`。先頭`/`が必要 |
| `NEXT_PUBLIC_API_MODE` | 同一origin bundle等 | `same-origin`または既定の`worker-origin` |
| `NEXT_PUBLIC_API_URL` | WorkerとAdminが別origin | Adminが接続するWorker origin |

`LINE_HARNESS_ALLOW_SOURCE_PUBLISH=1`は公開guardを解除します。公開操作そのものと同様、ユーザー承認なしに設定しません。

### build toolingが自動生成する値

| 変数 | 生成元・fallback | 用途 |
|---|---|---|
| `APP_VERSION` | root `package.json` | 画面と更新判定のversion |
| `APP_COMMIT_SHA` | release/build metadata | build commit。未設定時は`GITHUB_SHA`、`CF_PAGES_COMMIT_SHA`、ローカルgitの順にfallback |
| `APP_BUILD_TIME` | release/build metadata | build時刻。未設定時はbuild開始時刻 |
| `GITHUB_SHA` | GitHub runtime | commit SHA fallback |
| `CF_PAGES_COMMIT_SHA` | Cloudflare Pages runtime | commit SHA fallback |
| `NEXT_PUBLIC_BASE_PATH` | `NEXT_BASE_PATH`からNext configが生成 | browser側のsubpath |

これらは通常、人が`.env`へ固定しません。`HOME`、`USERPROFILE`、`npm_config_user_agent`もNode/package managerが供給するruntime情報なので、このリポジトリのsecret contractには含めません。

## Cloudflare resources

稼働にはCloudflare account/OAuthまたはAPI tokenと、構成に応じた次のresourceが必要です。

- D1 databaseと適用済みmigration
- Worker、Worker Assets、R2 bucket、Durable Object、cron trigger
- 管理画面用Pages project、または同一origin構成
- 旧3-artifact構成のみLIFF用Pages project。現行CLI構成はWorker AssetsからLIFFを配信
- custom domainやPages/Worker originに対応するCORS、cookie、LINE callback設定

## 安全な確認順序

1. `pnpm install --frozen-lockfile`で依存を揃える（初回のみnetworkが必要）。
2. `pnpm verify:readiness`でCodex利用準備・整理差分のbuildとtestを行う。これが今回差分のship gate。
3. `pnpm verify:local`で全workspaceのtypecheckとunit testを包括診断する。既知のrepository failureも隠さず非zeroで返す。
4. NO WAVE環境では`nowave-ops`のdoctorでbindingと疎通状態を確認する。未登録・曖昧な項目はそのまま未解決として扱う。
5. deploy前にCloudflare resource名、D1 migration、LINE callback、MCP接続先を対象環境ごとに確認する。
6. remote migration、deploy、LINE送信、Calendar/Meet/Stripe/Cloudflare設定変更はユーザー承認後に実行する。
