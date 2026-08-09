-- 対象画面を「画面種別の安定 ID」と「具体的なルート」に分離する。
-- 例: page_id = 'zones.detail', route = '/zones/<zone-id>'。
-- 同じ詳細画面種別から複数の業務オブジェクトをレビュー対象にできるようにする。
ALTER TABLE app.review_scopes
    ADD COLUMN route text;

-- 旧クライアントは page_id にルートを保存していた。読み取り互換のため具体ルートにも複製する。
UPDATE app.review_scopes
SET route = page_id
WHERE page_id LIKE '/%';

ALTER TABLE app.review_scopes
    DROP CONSTRAINT review_scopes_review_session_id_page_id_key;

CREATE UNIQUE INDEX review_scopes_session_page_route_key
    ON app.review_scopes (review_session_id, page_id, COALESCE(route, ''));
