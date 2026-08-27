# state — 特典→オートウェビナー→無料相談 自動導線

最終更新: 2026-08-27 / フェーズ: **Phase 1 の結線ほぼ完了。残りは PR #38 の merge → active 化 → E2E**

## 次にやること（この順で・順序が重要）

1. **[ユーザー操作] PR #38 を squash merge する** → GitHub Actions が worker をデプロイ。
   **merge は Claude Code の classifier にブロックされるので必ずユーザーが実行する**（gh / GitHub MCP とも不可）
   https://github.com/nobel824/line-harness-oss/pull/38
2. **デプロイ完了を確認してから** ウェビナーを `active` に（`PUT /api/webinars/:id` に `{"status":"active"}`）
3. 同時にシナリオ `5202064a-af9b-4c39-ba4a-af35e1301225` を `isActive: true` に
4. E2E 疎通（下記「残りの検証」）

**順序を守る理由**: いま本番 worker は**旧文言の追客6通**を持っている。追客設定は既に `is_active=1` で
投入済みなので、先に active 化すると旧文言（「※21分」「AI導入診断」「15分枠」）が飛ぶ。
draft の間は `webinars.ts:118` の `status !== 'active'` で視聴が塞がれており候補が発生しないため、
**merge → デプロイ → active 化** の順なら無風。

## 何をしているか

AI顧問アカウント（`tatsuki | AI顧問` @288pnjfn / accountId `db3ca401-29e5-4c36-9720-6fec783703ef`）で、
「特典を受け取った人にオートウェビナーを案内し、無料相談の予約まで自動化する」導線を作る。

- 要件定義書（正本）: `tasks/requirements-auto-webinar-funnel.md`（commit d1f704e）
- 本番: `https://ai-komon.nobel824.workers.dev`
- **ウェビナー台本の正本**: `~/repos/nowave/tasks/_review/auto-webinar-full-script.html`
  ＋ 申込設計は `auto-webinar-funnel-design.html` の §5

## 今セッションで完了（2026-08-27）

### F-2 Automation（完了）
- 新規タグ **`特典請求` = `cf7c7a78-cd02-4b86-9f1f-bb1f6031a9cf`**（要件正本 AC-2-2 の名前を採用。
  旧 state の「特典受け取り」は表記ゆれ）
- 新規タグ **`ウェビナー案内クリック` = `d780e7e7-6335-49b3-9490-ddaa338b83bc`**
- Automation **`b3c926e8-33b2-4317-bdea-89aa7db6b2ea`**（`keyword_exact: 特典` → `add_tag` のみ）。
  本文送信は既存 auto_reply に任せ二重送信を防ぐ。**conditions の永続化を再取得で照合済み**

### F-3 ウェビナー案内（完了・シナリオのみ無効で待機）
- tracked_link **`https://ai-komon.nobel824.workers.dev/t/qFMW0SK`**（id `269ea305`）。
  クリックで `ウェビナー案内クリック` タグ付与。飛び先は
  `https://liff.line.me/2010362657-WJzlPLEK/?page=webinar&slug=ai-x-webinar&liffId=2010362657-WJzlPLEK`
- **既定 LIFF ID は `2010362657-WJzlPLEK`**（env `LIFF_URL` 由来。アカウント行の `liff_id` は null だが
  フォールバックが効く）。`https://ai-komon.nobel824.workers.dev/auth/line` の HTML から抽出できる
- 特典 auto_reply `d8f05c9e` の本文を更新。**「全部、コピペでそのまま使える形にまとめました」を削除**
  （＝「簡単に始められる」の謳い文句。ここにウェビナー案内を同梱すると条文の両翼が1通で揃う）
- シナリオ **`5202064a-af9b-4c39-ba4a-af35e1301225`**（`tag_added: 特典請求` / `absolute_time` /
  翌日 **18:30** に1通 / step 条件 **`tag_not_exists` = ウェビナー案内クリック**）。**いまは `isActive: false`**

### AC-5-6 CTA の差し替え（完了）
- フォーム **`95a1355f-8f5d-4ffb-b0a0-4900c13bc6ee`**「無料相談 事前ヒアリング」。**3項目だけ**
  （XアカウントURL / 何をやっていて何を売っているか / 一番詰まっているところ）。
  funnel-design §5 の決定に従い、投資可能額・月商・フォロワー数・投稿頻度・自走/伴走希望は**聞かない**
  （9項目フォームは自社実測で77%が落ちた導線）
- webinar_ctas **`024a9f4e`**（`kind=form` / `at_seconds=2997` / `autoOpen=false` /
  buttonLabel **「無料相談を予約する」**）
- **`main.tsx:473` の `cards.length === 0 &&` により、カードが1枚でもあると legacy の Spir ボタンは
  表示されない。** 差し替えは webinar_ctas への1行追加だけで完結する

### AC-5-7 追客6通の本文（完了・コミット 483f2cb）
- 旧文言（「※21分」「AI導入診断」「15分枠」「年商」「30分間隔」）を全廃
- 台本の「言わない言葉」を機械チェックで排除。4ステージ全部を走査する回帰テストを追加

### 追客設定9項目（投入済み）
`webinar_followup_configs` に INSERT 済み（API が存在しないので D1 直）:
`enabled_at` / `stage_enabled_at` = **2026-08-27T20:26:47+09:00**（現在時刻で明示＝AC-5-8 のバースト防壁）/
`is_active=1` / first 30 / second 1440 / picker 60 / no_show 90 / booking 30 / booking_second 1440 /
`booking_menu_id = fe30f094-0831-44cd-a38d-5377b1478067` / **`booking_url = NULL`（意図的）**

### F-8 段別カウント（完了・コミット 275cb9e）
`GET /api/webinars/:id/analytics` に `journey` ブロックを追加。kind×status は**全組み合わせ0埋め**。
UI は failed を赤、0件を「未到達」の黄。既存レスポンス形状は不変。

### ウェビナー本体
- `accountId` を **`db3ca401-...` に設定**（後述の 503 障害の修正）
- `status` はまだ **`draft`**

## 今セッションで分かった重要な事実

### ① ウェビナーの `account_id` が null だと相談予約が全滅する
`webinar-consultation-booking.ts:96` が `if (!input.accountId) throw ... 503 calendar_not_configured`。
`accountId` は `webinars.account_id` から来る。**null のままだと F-4（AC-4-3〜4-5）が丸ごと動かない。**
2026-08-27 に設定済み。新しいウェビナーを作るときも必ず入れる。

### ② `booking_menu_id` は追客用ではなく、相談枠取得そのものの必須設定
`webinar-consultation-booking.ts:106` が `if (!config?.booking_menu_id) throw 404`。
`webinar_followup_configs` の行が無いと**相談枠が1つも出ない**。追客を使わなくても必要。

### ③ フォーム送信済みの人が相談枠に戻る導線が構造的に存在しない
相談枠ピッカーはウェビナー視聴画面の中にしかなく、**単体のディープリンクが無い**
（`consultation-slots` は視聴セッション認証が前提）。単体で開ける予約URLは一般予約経路
（`page=salon-book`）だけだが、こちらは **`syncConfirmedBookingToGoogle` を `addGoogleMeet` なしで
呼ぶので Meet が付かず**、リマインド2通目も1時間前でなく2時間前になる。
**録画の 57:06 で「通話のリンクは自動で発行されて、事前にLINEでリマインドが届きます」と明言している**
ため、この経路に流すと本人が動画で言ったことと食い違う。
→ **ユーザー決定（2026-08-27）: `submitted_no_booking_*` の2通は今回出さない。**
`booking_url` を NULL のままにして発火させない（`webinar-followups.ts:314` が両方 NOT NULL を要求）。
F-8 の段別カウントで 0 件として見えるので「黙って死んでいる」とは区別できる。
Phase 2 でディープリンクを作ってから有効化する。
なお `addGoogleMeet` を一般予約経路で一律 ON にする手は、**同じ worker に載っている他2アカウント
（クラファン／サガリ藤）の予約全部に波及する**ので採れない。

### ④ 台本と実録が乖離している
台本（`auto-webinar-full-script.html`）は**想定30〜35分・最終CTAは「X戦略診断」**だが、
**実録は57分29秒で、実際の発話は「画面の"無料相談予約する"を押してみてください」（56:57）**。
台本が禁じた「申し込む義務はもちろんありません」も実際には話されている（53:16）。
→ **視聴者が耳で聞く言葉に合わせ、全面的に「無料相談」で統一した。**
CTA の `at_seconds=2997` は、**49:57 に「無料のX戦略相談を用意しております」と正式告知する実時刻**から
決めた（実尺の86.9%＝AC-7-3 の 2,760〜3,000秒 レンジ内）。台本の比率から推定した値ではない。

### ⑤ LINE 規約の条文当て（vault 参照）
禁止の型は〈「儲かる」or「◯◯するだけ」の謳い文句〉＋〈メルマガ登録・動画販売・**セミナー開催等へ誘導**〉
`[公式]`（`2026-0803-guideline-bans-the-pitch-not-the-business`）。
**この導線は誘導側の翼が構造上すでに立っているので、逃げ場は文言側にしかない。**
別メッセージに分けても実質のリスクは下がらない（条文が見るのはアカウントの訴求であって1通の中身ではない）。
条文は「一例であり記載のないケースでもお断りすることがある」「理由を説明する義務を負わない」。
**ユーザー決定: 安全側に寄せる**（収入額・「稼げる」「〜するだけ」「誰でも」「簡単に」を全文言から排除）。

### ⑥ 配信タイミングは統計で決めない
「21時台が最適」系は一次統計に到達できず、Braze が自社データで反証済み `[観察]`
（`2026-0803-send-time-optimum-is-refuted`）。1,002人では A/B の下限（5,000）に届かず評価手段も無い。
→ 翌日 push を **18:30** にしたのは**動線上の理由**（ウェビナー枠19-23時の直前＝当日枠へ直行できる）で、
最適時刻の主張ではない。

### ⑦ 1人が受ける最大通数は4通
4ステージは排他なので6通全部を踏む人は存在しない。
翌日フォロー1 ＋ 入場リンク1 ＋（追客 最大2 または リマインド2）＝ **最大4通**。
ブロック理由1位は「配信頻度が多すぎる」26.5% `[実証]` だが、この段数なら頻度リスクは小さい。
**通数の支配項は翌日フォロー1本**で、分母の「月間の新規特典請求者数」は**まだ測っていない**
（vault の Open Thread #2 と同じ穴）。リリース後に最初に埋める数字。残枠は約2,000通 `[実測]`。

## 残りの検証（active 化の後）

- **T-A**: `特典です` のような部分一致でタグが付かないこと（`keyword_exact` の誤爆確認・AC-2-4）
- **T-B**: `特典` 送信後、`GET /api/chats/:friendId` の outgoing が**1件だけ**であること（AC-2-5）
- **T-E**: 案内本文から `auto:` リンクが生成されていないこと（tracked_link を使っているので出ないはず）
- **T-D**: `npx wrangler@4 tail ai-komon --format json` で `event.cron` の `outcome` が
  `exceededCpu` でないこと（Paid なので出ないはずだが1度確認する）
- **T-I**: CTAクリック後フォーム未送信の追客が実際に届くこと（第4ステージ・AC-5-5）
- **AC-4-3〜4-5**: フォーム送信 → 同一画面に空き枠 → 確定 → Meet 発行 → LINE 通知
- **AC-3-3/3-4**: 翌日 push が未クリック者にだけ届くこと

## 前セッションまでの到達点（維持）

- **F-7 素材**: HLS 98ファイルを R2 `line-harness-images` の `webinars/ai-x-webinar/` に投入済み。
  `-c copy` で再エンコードなし（スライド中心のため文字が劣化する）。セグメントは36秒刻み・97本
- **予約基盤**: 予約スタッフ `63ffc2a6-d223-4ed7-85c2-c9e6f4a7420d` /
  メニュー `fe30f094-0831-44cd-a38d-5377b1478067`「無料個別相談（30分）」/ 平日10:00〜18:00 /
  シフトは 2026-08-28 から13週・65日分（**期限が来たら再生成が要る**。切れると枠が黙って出なくなる）
- **Google OAuth**: 接続 `3d3c1513-9676-4ff8-9422-324b83cbfedf` / `calendar_id=primary`。
  承認したのは**仕事用**アカウント。**プライベート `nobel824@gmail.com` は `busy_calendar_ids` に入れて
  空き判定にだけ使う**。実測で空き枠が 41 → 37 に減ることを確認済み（これが唯一の判定材料。
  枠数が戻ったら共有切れを疑う）
- **複数カレンダー対応**（PR #37）はデプロイ済み。新エンドポイントは
  `PUT /api/booking/admin/staff/:id/google-calendar/busy-calendars`。
  **既存の PUT google-calendar は使わない**（auth_type を service_account に固定しトークンを消す）
- 管理APIは **`Authorization: Bearer <LINE_HARNESS_OWNER_API_KEY_AIKOMON>`**。`X-API-Key` では 401

## 実装時に踏みやすい罠

- `is_active` を 0→1 に戻すと `stage_enabled_at` が古いままで**過去の離脱者に毎分50件ずつバースト送信**
- **PR は `--repo nobel824/line-harness-oss` を明示する**（フォークなので gh は既定で本体 Shudesu を向く）
- **Codex に委譲するときは `claude` / `opus-pm` を呼ぶなと明示する。** sandbox から Keychain が
  見えず "Not logged in" で実装ゼロのまま終わる（今セッションで1回踏んだ）
- シナリオ本文に**生URLを書かない**（`auto:` リンクが量産され、タグもシナリオも紐付かない）
- `absolute_time` モードのステップは **`offsetDays` + `deliveryTime` だけ**しか受け付けない
  （`delayMinutes` を混ぜると 400）
- 視聴画面の実体は `apps/worker/src/client/webinar/main.tsx`。`apps/liff/` 側は**未デプロイの旧実装**
- ローカルの `~/repos/ai-komon-line-harness` は2026-04の古いクローン。**本番の実体はこの OSS repo 側**

## 未決（Phase 2 / 実測待ち）

- `submitted_no_booking_*` 2通の有効化（＝相談枠へのディープリンク実装。上記③）
- 段別転換率の実測後に追客の段数・遅延分数を調整（Q-3）
- 管理画面への引き上げ（F-1 / 本文テンプレート列の additive migration / 読み書き API）
