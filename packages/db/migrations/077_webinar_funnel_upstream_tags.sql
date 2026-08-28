-- ウェビナー導線の上流2段を分析に出すためのタグ参照。ウェビナー側が付ける
-- タグ (tag_on_attend / tag_on_cta_click) と違い、ここは別システムが付けた
-- タグを「分母」として読むだけの参照。NULL は未設定 (その段を出さない)。
ALTER TABLE webinars ADD COLUMN funnel_entry_tag_id TEXT;
ALTER TABLE webinars ADD COLUMN funnel_invite_tag_id TEXT;
