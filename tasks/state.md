# state — 特典→オートウェビナー→無料相談 自動導線

最終更新: 2026-08-27 / フェーズ: **Phase 1 実装中（F-7 完了・予約基盤の改修へ）**

## 何をしているか

AI顧問アカウント（`tatsuki | AI顧問` @288pnjfn / accountId `db3ca401-29e5-4c36-9720-6fec783703ef`）で、
「特典を受け取った人にオートウェビナーを案内し、無料相談の予約まで自動化する」導線を作る。

- 要件定義書（正本）: `tasks/requirements-auto-webinar-funnel.md`（commit d1f704e）
- 本番: `https://ai-komon.nobel824.workers.dev`

## 完了（2026-08-27）

**F-7 の素材側 — 動画 HLS 化と R2 配置**
- 元動画 `~/Documents/Zoom/2026-08-27 16.54.00 達貴 奥田のZoomミーティング/video1125579345.mp4`
  （3449.088秒 / 1920x1080 / 25fps / h264 133kbps + aac 81kbps / 89MB）
- **再エンコードせず `-c copy`** で HLS 化。理由: 元が既に高圧縮でスライド中心の画面共有のため、
  再エンコードすると文字が劣化する。副作用としてキーフレーム間隔が36秒 → **セグメントも36秒刻み・97本**
- R2 `line-harness-images` の `webinars/ai-x-webinar/` へ **98ファイル（master.m3u8 + seg 97本）投入済み・失敗0**
- ローカル検証: プレイリスト合計 3449.08秒 / 中間セグメント・先頭30秒のデコード OK
- ウェビナー更新済み: `slug` test→**ai-x-webinar** / `durationSeconds` 3600→**3449** /
  `videoPrefix`→**webinars/ai-x-webinar** / `showAtSeconds` 2700→**2880**（実尺の83.5%）
- **`status` はまだ `draft`**（AC-7-4 未達）。CTA を Spir から内製フォームへ切り替えてから active にする

**認証まわり**
- `npx wrangler@4 login` で OAuth 認可済み（R2 / D1 が CLI から触れる）
- 管理APIは **`Authorization: Bearer <LINE_HARNESS_OWNER_API_KEY_AIKOMON>`**。`X-API-Key` では 401
- Keychain の `R2_ACCESS_KEY_ID` は `buzz-clips` 専用で line-harness-images は 403。
  `CLOUDFLARE_API_TOKEN_CLAUDE_CODE_LP` は **無効**（token verify が Invalid API Token）

## 本番の実データ（調査で確定・2026-08-27）

- **内製予約は土台がゼロ**: 予約メニュー 0件 / 予約スタッフ 0件（`staff` に 奥田達貴 はいるが
  `line_account_id` が当アカウントでないため booking からは見えない）/ Google Calendar 未接続
- フォームは2本: `245aba60-…` 友だち追加アンケート / `a6c98719-…` 副業アンケート（事前ヒアリング）
- タグ6個。`webinar-0627` `アンケート回答済み` `クラファン_Spirクリック` `クラファン_資料請求` `先行利用` `配信除外`
- 既存 auto_reply に `ウェビナー`（完全一致・Peatix の別イベント案内）がある。今回の `特典` とは別物

## 決まったこと（ユーザー決定）

| 論点 | 決定 |
|---|---|
| Workers のプラン | Paid。cron の CPU 10ms 問題は解消 |
| 対象の特典キーワード | `特典` の完全一致1本のみ |
| 対象の特定方法 | 今後受け取る人だけ自動タグ（バックフィルしない） |
| ウェビナーの器 | 既存の `AI × 𝕏攻略ウェビナー` を使い回す。slug は変更済み |
| 追客本文の持ち方 | DB に本文列を追加して管理画面から編集（Phase 2） |
| リリース順序 | Phase 1 で導線を先に流し、管理画面は Phase 2 |
| ウェビナー案内の出し方 | 特典 reply に同梱（0通）＋ 未クリック者に翌日 push |
| R2 書き込み経路 | **wrangler login で認可**（2026-08-27 実施済み） |
| **予約の空き判定** | **複数カレンダー対応をコードに入れる**（2026-08-27 決定） |

### 複数カレンダー対応が必要になった理由

ユーザーは Google アカウントを **プライベート用と仕事用の2つ**持っている。
現状の実装は **1スタッフ＝1カレンダー**（`uq_google_calendar_connections_active_staff` が `staff_id` に UNIQUE）で、
空き判定も **単一カレンダー**（`google-calendar.ts:34-38` の `items: [{ id: calendarId }]`）。
仕事用だけ繋ぐとプライベートの予定が「空き」扱いになり **ダブルブッキングする**。

Spir に寄せる案も検討したが、追客6通のうち **④フォーム送信→相談未予約の2通が誤爆**し
（未予約判定が内製 `bookings` / `meet_consultations` を見るため・`webinar-followups.ts:303-310`）、
**予約後の LINE リマインド2通も送れない**（`meet_consultations` に行が立たないため）。
そのため内製予約を維持し、freeBusy の `items` を複数にする方針を選んだ。

### 実装方針（次にやること）

1. additive migration: `google_calendar_connections` に **`busy_calendar_ids TEXT`**（JSON配列）を追加。
   **イベント作成の書き込み先は従来どおり `calendar_id` の1本だけ**にする
2. `GoogleCalendarConfig` に `busyCalendarIds?: string[]` を足し、`getFreeBusy` の `items` を
   `[calendar_id, ...busyCalendarIds]` にして **返ってきた全カレンダーの busy をマージ**して返す
   （現状は `data.calendars?.[this.config.calendarId]` しか見ていない）
3. `booking-calendar-sync.ts` の `getStaffCalendarConnection` の SELECT に列を追加し `clientForConnection` へ渡す
4. `routes/booking.ts` の `GET/PUT /api/booking/admin/staff/:id/google-calendar` に読み書きを通す
   （**CORS の allowHeaders は既存のままでよい。新ヘッダは足さない**）
5. 前提: プライベートのカレンダーを**仕事用アカウントに共有**する設定はユーザーが Google 側で行う

その後、予約基盤のセットアップ（booking staff 登録 → Google Calendar OAuth → シフト → 予約メニュー）
→ CTA を内製フォームへ差し替え → 追客6通の本文修正 → ウェビナー active 化。

## 実装時に踏みやすい罠

- `is_active` を 0→1 に戻すと `stage_enabled_at` が古いままで**過去の離脱者に毎分50件ずつバースト送信**される
- `submitted_no_booking_*` は `booking_menu_id` と `booking_url` の**両方**が必要（片方だけだと沈黙）
- 予約は2経路あり、**Meet が付くのは「ウェビナー個別相談」経路だけ**。一般予約経路はリマインド2通目が2時間前
- シナリオ本文に**生URLを書かない**（`auto:` リンクが量産され、タグもシナリオも紐付かない）
- 視聴画面の実体は `apps/worker/src/client/webinar/main.tsx`。`apps/liff/` 側は**未デプロイの旧実装**
- ローカルの `~/repos/ai-komon-line-harness` は2026-04の古いクローン。**本番の実体はこの OSS repo 側**
- このワークツリーに **node_modules が無い**。ローカル検証前に `npm install` が要る

## 未決（着手は止めない）

- 訴求文言の確定（Q-4。LINE ガイドラインの条文当てが要る → `line-step-consult` を通す）
- 追客6通の本文（`webinar-followups.ts:67-109`）は「21分」「AI導入診断」「15分枠」が残っており、
  実尺57分29秒・相談枠・実フォーム名に合わせて書き直す必要がある（AC-5-7）
- 段別転換率の実測後に追客の段数・遅延分数を調整（Q-3）
