# 管理画面メール認証 実装計画

1. `staff_members` に正規化メールで有効スタッフを一意に解決するDB helperを追加する。重複時は認証失敗にする。
2. Cloudflare Access JWT検証 helperを追加する。`jose` の remote JWKS を用い、RS256・issuer・audience・期限を検証する。
3. `/admin/access` を追加する。認証モードと設定を fail closed で検証し、スタッフ権限の既存Cookieセッションへ交換して固定URLへリダイレクトする。
4. `/api/auth/config` を追加し、管理画面へ公開可能な認証モードとAccess入口URLだけを返す。
5. `/api/auth/login` をモードに応じて制限し、`access` モードではAPIキーログインを拒否する。
6. 管理画面ログインページを `api_key` / `hybrid` / `access` に対応させる。
7. Worker・DB・Webのテストを追加し、対象テスト、typecheck、buildを実行する。
8. `docs/ADMIN-AUTH.md` と設定例へ独自ドメイン + Access OTP の導入・ロールバック手順を追記する。

## レビュー観点

- 認証（Access）から認可（staff role）への権限昇格がないこと。
- Access未設定・迂回アクセス・JWT検証失敗がすべて fail closed になること。
- 既存のAPIキー利用者と未移行環境を壊さないこと。
