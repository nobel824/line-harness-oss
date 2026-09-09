# 管理画面メール認証 要件

## 目的

独自ドメインの管理画面で、利用者が API キーを入力せず、Cloudflare Access のメール OTP で本人確認してログインできるようにする。

## 確定事項

- Cloudflare Access は本人確認のみを担当する。
- 管理画面の権限は `staff_members` を唯一の正本とし、Access 側の許可設定から role を推定しない。
- SDK・MCP・CLI の Bearer API キー認証は維持する。
- ブラウザ認証モードは `api_key`、`hybrid`、`access` の明示設定とする。未設定時は既存互換の `api_key`。
- Access 設定が欠けている `access` モードは fail closed とし、API キーログインへ自動フォールバックしない。
- Access JWT は Worker 自身が署名・issuer・audience・有効期限・メール claim を検証する。
- メールアドレスは trim + lowercase で照合し、該当する有効なスタッフがちょうど1件のときだけログインを許可する。
- セッション Cookie には既存のスタッフ API キーを格納し、既存 middleware がリクエストごとに `is_active` と role を再評価する。
- Access JWT や OTP をログへ出さない。

## Acceptance Criteria

1. 有効な Access JWT を持つ登録済みスタッフが `/admin/access` を開くと、Worker は既存の管理画面 Cookie セッションを発行し、設定済み管理画面URLへリダイレクトする。
2. Worker は未知・無効・重複メール、誤署名、誤 issuer、誤 audience、期限切れ JWT を受け取ると、Cookieを発行せずログインを拒否する。
3. `ADMIN_BROWSER_AUTH_MODE=access` のとき、管理画面は API キー入力欄を表示せず、メール認証ボタンから `/admin/access` へ遷移する。
4. `ADMIN_BROWSER_AUTH_MODE=hybrid` のとき、管理画面はメール認証と既存 API キーログインの両方を提供する。
5. `ADMIN_BROWSER_AUTH_MODE=api_key` または未設定のとき、既存の API キーログイン動作は変わらない。
6. `access` モードで Access の team domain または audience が未設定のとき、Worker は設定エラーとして閉じ、API キーログインを許可しない。
7. スタッフが停止・降格・削除された後のAPIリクエストで、既存 middleware は最新のDB状態を反映して拒否または新しいroleを適用する。
8. SDK・MCP・CLI が Bearer API キーを送ると、従来どおり認証できる。

## 導入とロールバック

1. コードを既定 `api_key` のまま配備する。
2. 独自ドメイン、Access OTP、許可メール、Worker の team domain / audience を設定する。
3. `staff_members` に owner のメールを登録する。
4. `hybrid` でメール認証を確認する。
5. `access` へ切り替えてブラウザの API キー入力を停止する。
6. 障害時は設定を `hybrid` または `api_key` へ明示的に戻す。

## 承認

2026-09-09、APIキー入力をなくす独自ドメインのメール認証案に対して、ユーザーが「任せる」と承認。
