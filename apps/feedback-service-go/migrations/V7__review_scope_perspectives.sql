ALTER TABLE feedback.review_scopes
    ADD COLUMN perspective_codes text[] NOT NULL DEFAULT '{}'::text[];

ALTER TABLE feedback.review_scopes
    ADD CONSTRAINT review_scopes_perspective_codes_limit
    CHECK (cardinality(perspective_codes) <= 100);
