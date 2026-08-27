-- auto_replies に2通目を追加。NULL / 空なら従来どおり1通だけ送る
ALTER TABLE auto_replies ADD COLUMN response_type_2 TEXT;
ALTER TABLE auto_replies ADD COLUMN response_content_2 TEXT;
