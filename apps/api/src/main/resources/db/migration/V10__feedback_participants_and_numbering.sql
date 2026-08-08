-- 共通OIDCアカウントを使うプロトタイプレビューでも、端末ごとの自己申告名を追跡する。
-- 認証主体 (created_by / author_id / edited_by) とは分離し、認可には使用しない。

ALTER TABLE app.feedback_threads
    ADD COLUMN reporter_name text
        CHECK (reporter_name IS NULL OR (btrim(reporter_name) <> '' AND char_length(reporter_name) <= 100)),
    ADD COLUMN page_route text,
    ADD COLUMN display_number integer;

ALTER TABLE app.feedback_messages
    ADD COLUMN participant_name text
        CHECK (participant_name IS NULL OR (btrim(participant_name) <> '' AND char_length(participant_name) <= 100));

ALTER TABLE app.feedback_message_versions
    ADD COLUMN edited_by_participant_name text
        CHECK (
            edited_by_participant_name IS NULL OR
            (btrim(edited_by_participant_name) <> '' AND char_length(edited_by_participant_name) <= 100)
        );

-- 既存ピンは作成順で採番し、以後の追加で番号がずれないよう永続化する。
WITH numbered AS (
    SELECT id,
           row_number() OVER (PARTITION BY review_session_id ORDER BY created_at, id)::integer AS display_number
    FROM app.feedback_threads
)
UPDATE app.feedback_threads AS thread
SET display_number = numbered.display_number
FROM numbered
WHERE numbered.id = thread.id;

-- V10以前の証跡つき投稿は、証跡に保持していた具体URLをスレッドへ戻す。
UPDATE app.feedback_threads AS thread
SET page_route = evidence.route
FROM app.review_evidence AS evidence
WHERE evidence.id = thread.evidence_id;

ALTER TABLE app.feedback_threads
    ALTER COLUMN display_number SET NOT NULL,
    ADD CONSTRAINT feedback_threads_display_number_positive CHECK (display_number > 0),
    ADD CONSTRAINT feedback_threads_session_display_number_unique
        UNIQUE (review_session_id, display_number);
