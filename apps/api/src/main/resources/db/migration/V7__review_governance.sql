-- プロトタイプレビュー管理基盤 Phase 6 (docs/prototype-review.md)。
-- コメント編集を上書きだけで終わらせず全版を保存し、証跡にはプロジェクト既定・
-- セッション上書きの保存期間を持たせる。

-- NULL は「自動削除しない」。既存プロジェクトへ暗黙の削除期限を導入しないため、
-- 運用者が明示的に設定するまで従来どおり保持する。
ALTER TABLE app.projects
    ADD COLUMN review_evidence_retention_days integer
        CHECK (review_evidence_retention_days BETWEEN 1 AND 3650);

-- NULL はプロジェクト既定を継承する。
ALTER TABLE app.review_sessions
    ADD COLUMN evidence_retention_days integer
        CHECK (evidence_retention_days BETWEEN 1 AND 3650);

-- 期限を証跡行へ固定しておくことで、取得のたびにポリシーテーブルを結合せず
-- fail-closed に期限切れを隠せる。ポリシー変更時は API が既存行も再計算する。
ALTER TABLE app.review_evidence
    ADD COLUMN expires_at timestamptz;

CREATE INDEX review_evidence_expiry_idx
    ON app.review_evidence(expires_at)
    WHERE expires_at IS NOT NULL;

-- Evidence は 1 Thread 専用。保存期間の異なる複数セッションから同じ証跡を参照させない。
CREATE UNIQUE INDEX feedback_threads_evidence_unique_idx
    ON app.feedback_threads(evidence_id)
    WHERE evidence_id IS NOT NULL;

-- メッセージの全版。app.feedback_messages は現在版を高速に読む投影として残す。
CREATE TABLE app.feedback_message_versions (
    message_id uuid NOT NULL REFERENCES app.feedback_messages(id) ON DELETE CASCADE,
    version integer NOT NULL CHECK (version >= 1),
    body text NOT NULL,
    edited_by uuid REFERENCES app.users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (message_id, version)
);

CREATE INDEX feedback_message_versions_created_idx
    ON app.feedback_message_versions(message_id, created_at);

-- Phase 2〜5 で作成済みのメッセージも初版として履歴へ取り込む。
INSERT INTO app.feedback_message_versions (message_id, version, body, edited_by, created_at)
SELECT id, 1, body, author_id, created_at
FROM app.feedback_messages;
