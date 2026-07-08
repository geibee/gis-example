-- issue #18: 監査ログにリクエスト ID (callId) を記録し、CloudWatch Logs 上の
-- アプリログ (MDC callId) と app.audit_logs を 1 リクエスト単位で突合できるようにする。
-- 既存行は NULL のまま (導入前のログには対応する callId が存在しない)
ALTER TABLE app.audit_logs
    ADD COLUMN call_id text;
