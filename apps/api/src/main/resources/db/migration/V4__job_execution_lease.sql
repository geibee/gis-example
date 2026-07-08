-- issue #24: ジョブ実行の SQS 化に伴う実行リース管理列。
--
-- heartbeat_at: 実行中ワーカーが定期更新するハートビート。時刻閾値 (started_at) による
--   stale 判定は「閾値を超える正常実行」を誤って再キューする問題があったため、
--   生存判定はハートビート途絶へ置き換える (既存行は NULL = started_at で判定にフォールバック)。
-- attempt_count: claim (実行開始) のたびにインクリメントする試行回数。SQS の
--   ApproximateReceiveCount は補完スキャンの再 enqueue でリセットされ収束保証に使えないため、
--   「有限回で failed に収束する」ためのカウンタは DB 側に持つ (docs/jobs-architecture.md)。
ALTER TABLE app.analysis_jobs
    ADD COLUMN heartbeat_at timestamptz,
    ADD COLUMN attempt_count integer NOT NULL DEFAULT 0;

ALTER TABLE app.import_jobs
    ADD COLUMN heartbeat_at timestamptz,
    ADD COLUMN attempt_count integer NOT NULL DEFAULT 0;
