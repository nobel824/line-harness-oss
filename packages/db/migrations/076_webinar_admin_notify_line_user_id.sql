-- ウェビナー単位の無料相談予約通知先。NULL は未設定を表し、
-- 予約処理側で既存の ADMIN_NOTIFY_LINE_USER_ID にフォールバックする。
ALTER TABLE webinar_followup_configs
  ADD COLUMN admin_notify_line_user_id TEXT;
