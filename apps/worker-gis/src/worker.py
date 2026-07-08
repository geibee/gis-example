from __future__ import annotations

import json
import logging
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import zipfile
from datetime import UTC, datetime
from pathlib import Path
from types import TracebackType
from typing import Any

import boto3
import psycopg
from psycopg.rows import DictRow, dict_row

logger = logging.getLogger("worker-gis")

# 受付形式 → GDAL 入力ドライバの allowlist (issue #19)。
# ogr2ogr へ -if で明示し、拡張子偽装や VRT 等による別ドライバの自動選択
# (ローカルファイル読取・外部フェッチの起点) を封じる。api 側の受付形式
# (JobRoutes.kt の validateImportFormat) より狭く、ここに無い形式は取込前に failed にする
INPUT_DRIVERS: dict[str, str] = {
    "geojson": "GeoJSON",
    "shapefile": "ESRI Shapefile",
}

# zip 展開前検査の既定値 (env で上書き可能 — docs/environment-variables.md)
DEFAULT_ZIP_MAX_ENTRIES = 100
DEFAULT_ZIP_MAX_TOTAL_BYTES = 2 * 1024**3  # 2GiB

# logging.LogRecord の組込み属性名。これ以外 (extra= で渡した job_id 等) を JSON フィールドとして出力する
_BUILTIN_LOG_ATTRS = frozenset(vars(logging.makeLogRecord({})).keys()) | {"taskName", "message", "asctime"}


class JsonLinesFormatter(logging.Formatter):
    """CloudWatch Logs Insights でフィールド検索するための JSON lines (api の LOG_FORMAT=json と対で保つ)。

    @timestamp / level / logger_name / message に加え、extra= で渡された属性 (job_id 等) と
    例外の stack_trace を出力する。フィールド名は api (logstash-logback-encoder) に揃える。
    """

    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, Any] = {
            "@timestamp": datetime.fromtimestamp(record.created, tz=UTC).isoformat(timespec="milliseconds"),
            "level": record.levelname,
            "logger_name": record.name,
            "message": record.getMessage(),
        }
        for key, value in record.__dict__.items():
            if key not in _BUILTIN_LOG_ATTRS and not key.startswith("_"):
                payload[key] = value
        if record.exc_info:
            payload["stack_trace"] = self.formatException(record.exc_info)
        return json.dumps(payload, ensure_ascii=False, default=str)


def configure_logging() -> None:
    # LOG_FORMAT=json で JSON lines、既定 text は dev 向けの人間可読 (docs/observability.md)。
    # 不正値は黙って text に落とさず起動を失敗させる (api の validateLogFormatEnv と同じ fail fast)
    log_format = os.getenv("LOG_FORMAT", "text")
    if log_format not in {"text", "json"}:
        raise RuntimeError(f"LOG_FORMAT は text | json のいずれかを指定してください: {log_format}")
    handler = logging.StreamHandler(sys.stdout)
    if log_format == "json":
        handler.setFormatter(JsonLinesFormatter())
    else:
        handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)-5s %(name)s - %(message)s"))
    root = logging.getLogger()
    root.handlers.clear()
    root.addHandler(handler)
    root.setLevel(logging.INFO)


def main() -> None:
    configure_logging()
    if job_queue_mode() == "sqs":
        sqs_main()
    else:
        polling_main()


def job_queue_mode() -> str:
    # 不正値で黙って polling へ落ちると「api は SQS へ enqueue するのに consumer は DB を見ない」
    # 片肺構成になり得るため起動を失敗させる (LOG_FORMAT と同じ fail fast)
    mode = os.getenv("JOB_QUEUE_MODE", "polling")
    if mode not in {"polling", "sqs"}:
        raise RuntimeError(f"JOB_QUEUE_MODE は polling | sqs のいずれかを指定してください: {mode}")
    return mode


def polling_main() -> None:
    # 従来動作 (dev / 単一ホスト構成の既定): app.import_jobs を DB ポーリングする
    poll_interval = float(os.getenv("POLL_INTERVAL_SECONDS", "2"))
    logger.info("GIS worker started (polling mode)")
    while True:
        did_work = False
        try:
            with connect() as conn:
                sweep_import_jobs_if_due(conn, sqs=None, queue_url=None)
                import_job = claim_import_job(conn)
                if import_job is not None:
                    did_work = True
                    run_import_job_with_heartbeat(conn, import_job)
        except Exception:
            logger.exception("Import job polling loop failed")

        if not did_work:
            time.sleep(poll_interval)


def sqs_main() -> None:
    # SQS 起動通知の consumer (JOB_QUEUE_MODE=sqs)。ジョブの正本は DB のジョブ行であり、
    # メッセージは「pending 行ができた」の通知に限定する。実行保証の設計は docs/jobs-architecture.md
    queue_url = os.getenv("SQS_IMPORT_QUEUE_URL")
    if not queue_url:
        raise RuntimeError("JOB_QUEUE_MODE=sqs では SQS_IMPORT_QUEUE_URL が必須です")
    poll_interval = float(os.getenv("POLL_INTERVAL_SECONDS", "2"))
    sqs = sqs_client()
    logger.info("GIS worker started (sqs mode, queue=%s)", queue_url)
    while True:
        try:
            with connect() as conn:
                sweep_import_jobs_if_due(conn, sqs=sqs, queue_url=queue_url)
                poll_sqs_once(conn, sqs, queue_url)
        except Exception:
            logger.exception("Import job SQS loop failed")
            time.sleep(poll_interval)


def poll_sqs_once(conn: psycopg.Connection[DictRow], sqs: Any, queue_url: str) -> int:
    """1 回の receive → claim → 実行。統合テストが決定的に駆動できるよう独立させている。

    戻り値は処理を試みたメッセージ数 (claim 失敗の破棄を含む)
    """
    wait_seconds = int(os.getenv("SQS_RECEIVE_WAIT_SECONDS", "10"))
    response = sqs.receive_message(
        QueueUrl=queue_url,
        MaxNumberOfMessages=1,
        WaitTimeSeconds=wait_seconds,
        AttributeNames=["ApproximateReceiveCount"],
    )
    messages = response.get("Messages", [])
    for message in messages:
        handle_import_message(conn, sqs, queue_url, message)
    return len(messages)


def handle_import_message(conn: psycopg.Connection[DictRow], sqs: Any, queue_url: str, message: dict[str, Any]) -> None:
    receipt_handle = message["ReceiptHandle"]
    job_id = decode_job_message(message.get("Body", ""))
    if job_id is None:
        # 解釈できない毒メッセージ。ジョブ行と対応しないため削除して終わり
        logger.warning("Dropping malformed import queue message: %.200s", message.get("Body", ""))
        delete_message(sqs, queue_url, receipt_handle)
        return
    job = claim_import_job_by_id(conn, job_id)
    if job is None:
        # at-least-once の重複配信 or 実行済み。DB のジョブ台帳が正であり、claim できない
        # メッセージは削除するだけで無害 (二重実行は起きない — issue #24 の第 2 層)
        logger.info("Import job %s is not claimable (duplicate delivery?) — dropping message", job_id)
        delete_message(sqs, queue_url, receipt_handle)
        return
    hold_seconds = float(os.getenv("IMPORT_TEST_CLAIM_HOLD_SECONDS", "0"))
    if hold_seconds > 0:
        # テスト専用フック: 実行中クラッシュ (kill 回復) の統合テストが claim 後の実行を保留するために使う
        time.sleep(hold_seconds)

    def extend_visibility() -> None:
        # ハートビートと対で visibility timeout を延長し、処理中の再配信を抑える。
        # 延長に失敗しても再配信 → claim 失敗で無害 (claim が二重実行を防ぐ)
        try:
            sqs.change_message_visibility(
                QueueUrl=queue_url,
                ReceiptHandle=receipt_handle,
                VisibilityTimeout=int(os.getenv("IMPORT_VISIBILITY_EXTENSION_SECONDS", "120")),
            )
        except Exception:
            logger.warning("Failed to extend message visibility for import job %s", job_id, exc_info=True)

    run_import_job_with_heartbeat(conn, job, on_heartbeat=extend_visibility)
    # succeeded でも failed でもジョブは終端状態に収束済み。メッセージの役目は終わり
    delete_message(sqs, queue_url, receipt_handle)


def delete_message(sqs: Any, queue_url: str, receipt_handle: str) -> None:
    try:
        sqs.delete_message(QueueUrl=queue_url, ReceiptHandle=receipt_handle)
    except Exception:
        # 削除失敗は再配信 → claim 失敗 → 削除リトライで収束する
        logger.warning("Failed to delete import queue message", exc_info=True)


def decode_job_message(body: str) -> str | None:
    """メッセージ本文 (api 側 JobQueue.kt の encodeJobQueueMessage と対) から jobId を取り出す"""
    try:
        payload = json.loads(body)
    except (json.JSONDecodeError, TypeError):
        return None
    if not isinstance(payload, dict):
        return None
    job_id = payload.get("jobId")
    if not isinstance(job_id, str) or not job_id.strip():
        return None
    return job_id


def sqs_client() -> Any:
    # 認証は boto3 の既定チェーン (本番: ECS タスクロール / dev: AWS_ACCESS_KEY_ID 等)。
    # SQS_ENDPOINT_URL は ElasticMQ 等の dev 用 (本番では設定しない)。
    # region は AWS_REGION も明示的に読む (botocore の既定チェーンは AWS_DEFAULT_REGION
    # しか見ないが、ECS が自動注入するのは AWS_REGION — docs/environment-variables.md)
    endpoint = os.getenv("SQS_ENDPOINT_URL") or None
    region = os.getenv("SQS_REGION") or os.getenv("AWS_REGION") or None
    return boto3.client("sqs", endpoint_url=endpoint, region_name=region)


_next_sweep_at = 0.0


def sweep_import_jobs_if_due(conn: psycopg.Connection[DictRow], sqs: Any, queue_url: str | None) -> None:
    # ポーリングごとでは無駄が多いので一定間隔でだけ回収スイープを回す
    global _next_sweep_at
    now = time.monotonic()
    if now < _next_sweep_at:
        return
    _next_sweep_at = now + float(os.getenv("SWEEP_INTERVAL_SECONDS", "60"))
    sweep_import_jobs(conn, sqs, queue_url)


def sweep_import_jobs(conn: psycopg.Connection[DictRow], sqs: Any, queue_url: str | None) -> None:
    """running / pending の滞留を回収し、全ジョブを有限時間で終端状態へ収束させるスイープ。

    - ハートビート途絶の running 行: 試行上限未満は pending へ戻し、上限以上は failed 化 (第 3・5 層)
    - pending のまま滞留した行 (sqs モードのみ): 起動通知を再 enqueue する補完スキャン (第 1 層)。
      enqueue の取りこぼし・DLQ 落ち後の再 pending 化を回収する。重複通知は claim が無害化する
    """
    stale_seconds = float(os.getenv("IMPORT_JOB_STALE_SECONDS", "1800"))
    max_attempts = int(os.getenv("IMPORT_JOB_MAX_ATTEMPTS", "5"))
    requeued, failed = sweep_stale_import_jobs(conn, stale_seconds, max_attempts)
    if requeued or failed:
        logger.warning("Swept stale import jobs: requeued=%d failed=%d", requeued, failed)
    if sqs is None or not queue_url:
        return
    reenqueue_seconds = float(os.getenv("IMPORT_JOB_REENQUEUE_SECONDS", "300"))
    job_ids = list_stale_pending_import_job_ids(conn, reenqueue_seconds, limit=100)
    for job_id in job_ids:
        try:
            sqs.send_message(QueueUrl=queue_url, MessageBody=json.dumps({"jobId": job_id}))
        except Exception:
            logger.warning("Failed to re-enqueue stale pending import job %s", job_id, exc_info=True)
    if job_ids:
        logger.warning("Re-enqueued %d stale pending import job(s)", len(job_ids))


def require_pgpassword() -> str:
    # 既定パスワードへのフォールバックはしない (本番で弱い資格情報のまま起動させない)
    password = os.getenv("PGPASSWORD")
    if not password:
        raise RuntimeError("PGPASSWORD が未設定です")
    return password


def connect() -> psycopg.Connection[DictRow]:
    return psycopg.connect(
        host=os.getenv("PGHOST", "localhost"),
        port=int(os.getenv("PGPORT", "5432")),
        dbname=os.getenv("PGDATABASE", "gis"),
        user=os.getenv("PGUSER", "gis"),
        password=require_pgpassword(),
        row_factory=dict_row,
    )


# claim (UPDATE ... RETURNING) が返すジョブ列。id 指定 claim と共通
_CLAIM_RETURNING = "RETURNING id::text, project_id::text, filename, format, source_srid, upload_path, layer_role"


def sweep_stale_import_jobs(
    conn: psycopg.Connection[DictRow], heartbeat_timeout_seconds: float, max_attempts: int
) -> tuple[int, int]:
    """ハートビート途絶の running 行を回収する。戻り値は (pending へ戻した数, failed 化した数)。

    ワーカーがジョブ実行中に落ちると running のまま残るため、heartbeat_at (実行中に定期更新。
    heartbeat_at 列導入前の既存行は started_at) が閾値を超えた行を対象に:
    - 試行回数 (attempt_count) が上限未満: pending へ戻す (再実行)
    - 上限以上: failed 化 (毒ジョブを有限回で収束させる)
    実行中はハートビートが更新され続けるため、閾値を超える長時間の正常実行を誤回収しない
    """
    stale_predicate = """
        status = 'running'
          AND COALESCE(heartbeat_at, started_at) < now() - make_interval(secs => %s)
    """
    with conn.transaction():
        failed = conn.execute(
            f"""
            UPDATE app.import_jobs
            SET status = 'failed', finished_at = now(),
                error_message =
                    concat('ハートビート途絶 (試行 ', attempt_count::text, ' 回) が上限に達したため打ち切り')
            WHERE {stale_predicate}
              AND attempt_count >= %s
            """,
            (heartbeat_timeout_seconds, max_attempts),
        ).rowcount
        requeued = conn.execute(
            f"""
            UPDATE app.import_jobs
            SET status = 'pending', started_at = NULL, heartbeat_at = NULL,
                error_message = concat('ハートビートが ', %s::text, ' 秒途絶したため再キュー')
            WHERE {stale_predicate}
            """,
            (heartbeat_timeout_seconds, heartbeat_timeout_seconds),
        ).rowcount
    return requeued, failed


def list_stale_pending_import_job_ids(
    conn: psycopg.Connection[DictRow], min_age_seconds: float, limit: int
) -> list[str]:
    # 読み取りも明示トランザクションで閉じる。psycopg は素の execute で暗黙トランザクションを
    # 開いたままにするため、放置すると後続の conn.transaction() が SAVEPOINT になり
    # claim のコミットが接続クローズまで外部から見えなくなる (ハートビート・他ワーカーが破綻する)
    with conn.transaction():
        rows = conn.execute(
            """
            SELECT id::text AS id
            FROM app.import_jobs
            WHERE status = 'pending'
              AND created_at < now() - make_interval(secs => %s)
            ORDER BY created_at
            LIMIT %s
            """,
            (min_age_seconds, limit),
        ).fetchall()
    return [row["id"] for row in rows]


def claim_import_job(conn: psycopg.Connection[DictRow]) -> dict[str, Any] | None:
    # claim は独立トランザクションで確定する。実行開始と同時にハートビートを開始し、
    # attempt_count (収束保証の試行カウンタ) を進める
    with conn.transaction():
        row = conn.execute(
            f"""
            UPDATE app.import_jobs
            SET status = 'running', started_at = now(), heartbeat_at = now(),
                attempt_count = attempt_count + 1, error_message = NULL
            WHERE id = (
                SELECT id
                FROM app.import_jobs
                WHERE status = 'pending'
                ORDER BY created_at
                FOR UPDATE SKIP LOCKED
                LIMIT 1
            )
            {_CLAIM_RETURNING}
            """
        ).fetchone()
    return row


def claim_import_job_by_id(conn: psycopg.Connection[DictRow], job_id: str) -> dict[str, Any] | None:
    # SQS 起動通知が指す特定ジョブの claim。重複配信されたメッセージはここで claim に失敗する
    # (= 実行済み or 実行中) ため二重実行は起きない (効果としての exactly-once を DB で担保)
    with conn.transaction():
        row = conn.execute(
            f"""
            UPDATE app.import_jobs
            SET status = 'running', started_at = now(), heartbeat_at = now(),
                attempt_count = attempt_count + 1, error_message = NULL
            WHERE id = (
                SELECT id
                FROM app.import_jobs
                WHERE id = %s::uuid AND status = 'pending'
                FOR UPDATE SKIP LOCKED
            )
            {_CLAIM_RETURNING}
            """,
            (job_id,),
        ).fetchone()
    return row


def heartbeat_import_job(conn: psycopg.Connection[DictRow], job_id: str) -> None:
    with conn.transaction():
        conn.execute(
            "UPDATE app.import_jobs SET heartbeat_at = now() WHERE id = %s::uuid AND status = 'running'",
            (job_id,),
        )


class JobHeartbeat:
    """実行中ジョブの生存通知スレッド。

    メイン接続はジョブ実行トランザクションが使うため、ハートビートは打つたびに専用接続を
    開いて heartbeat_at を更新する (psycopg の接続はスレッド間で共有できない)。
    on_beat は SQS consumer が ChangeMessageVisibility の延長を重ねるためのフック
    """

    def __init__(self, job_id: str, interval_seconds: float, on_beat: Any = None) -> None:
        self._job_id = job_id
        self._interval = interval_seconds
        self._on_beat = on_beat
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._loop, name="import-job-heartbeat", daemon=True)

    def __enter__(self) -> JobHeartbeat:
        self._thread.start()
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        self._stop.set()
        self._thread.join(timeout=self._interval + 5)

    def _loop(self) -> None:
        while not self._stop.wait(self._interval):
            try:
                with connect() as conn:
                    heartbeat_import_job(conn, self._job_id)
                if self._on_beat is not None:
                    self._on_beat()
            except Exception:
                logger.warning("Failed to heartbeat import job %s", self._job_id, exc_info=True)


def run_import_job_with_heartbeat(
    conn: psycopg.Connection[DictRow], job: dict[str, Any], on_heartbeat: Any = None
) -> None:
    # ハートビートが途絶した running 行はスイープ (sweep_stale_import_jobs) が回収するため、
    # 「実行中クラッシュ = 有限時間で再実行 or failed」が保証される (issue #24 の第 3 層)
    interval = float(os.getenv("IMPORT_JOB_HEARTBEAT_SECONDS", "15"))
    with JobHeartbeat(job["id"], interval, on_beat=on_heartbeat):
        run_import_job(conn, job)


def run_import_job(conn: psycopg.Connection[DictRow], job: dict[str, Any]) -> None:
    temp_dir: str | None = None
    try:
        table_name = make_table_name(job["filename"], job["id"])
        source_srid = int(job["source_srid"] or 4326)
        # 許可外形式はダウンロードや ogr2ogr 実行より前に拒否する (failed + 理由)
        driver = input_driver(job["format"])
        # upload_path が s3:// 参照なら一時ファイルへダウンロードして従来どおりローカルとして扱う
        local_path, temp_dir = fetch_upload(job["upload_path"])
        if job["format"] == "shapefile":
            max_entries, max_total_bytes = zip_limits()
            inspect_zip_archive(local_path, max_entries=max_entries, max_total_bytes=max_total_bytes)
        source = ogr_source(local_path, job["format"])

        run_ogr2ogr(source, table_name, source_srid, driver)

        with conn.transaction():
            normalize_imported_table(conn, table_name)
            layer_id = insert_layer_metadata(
                conn=conn,
                project_id=job["project_id"],
                name=Path(job["filename"]).stem,
                table_name=table_name,
                source_srid=source_srid,
                is_result=False,
                layer_role=job.get("layer_role") or "generic",
            )
            if (job.get("layer_role") or "generic") == "zone":
                sync_zones_for_layer(conn, layer_id, job["project_id"], table_name)
            conn.execute(
                """
                UPDATE app.import_jobs
                SET status = 'succeeded', layer_id = %s::uuid, finished_at = now()
                WHERE id = %s::uuid
                """,
                (layer_id, job["id"]),
            )
        logger.info(
            "Import job %s succeeded as layer %s",
            job["id"],
            layer_id,
            extra={"job_id": job["id"], "layer_id": layer_id, "project_id": job["project_id"]},
        )
    except Exception as exc:
        mark_import_failed(conn, job["id"], exc)
    finally:
        # S3 からのダウンロード一時ファイルだけを片付ける。アップロード本体は成功/失敗に
        # かかわらず削除しない (ローカル volume 時代からの踏襲。S3 側の失効は
        # ライフサイクルルールに委譲する — docs/backup-restore.md)
        if temp_dir is not None:
            shutil.rmtree(temp_dir, ignore_errors=True)


def run_ogr2ogr(source: str, table_name: str, source_srid: int, input_driver_name: str) -> None:
    # 接続文字列に password を含めない (プロセス引数は ps 等で同一ホストの他プロセスから
    # 見えるため)。libpq 標準の PGPASSWORD 環境変数でサブプロセスにだけ渡す
    pg_conn = (
        f"PG:host={os.getenv('PGHOST', 'localhost')} "
        f"port={os.getenv('PGPORT', '5432')} "
        f"dbname={os.getenv('PGDATABASE', 'gis')} "
        f"user={os.getenv('PGUSER', 'gis')}"
    )
    command = [
        "ogr2ogr",
        "-overwrite",
        # 入力ドライバを明示 (-if は GDAL 3.2+。worker イメージは gdal 3.9.2)。
        # 自動判別に任せると VRT / CSV 等の意図しないドライバが選択され得る
        "-if",
        input_driver_name,
        "-f",
        "PostgreSQL",
        pg_conn,
        source,
        "-nln",
        f"gis_data.{table_name}",
        "-lco",
        "GEOMETRY_NAME=geom",
        "-lco",
        "FID=fid",
        "-lco",
        "PRECISION=NO",
        "-nlt",
        "PROMOTE_TO_MULTI",
        "-s_srs",
        f"EPSG:{source_srid}",
        "-t_srs",
        "EPSG:3857",
    ]
    env = os.environ.copy()
    env["PG_USE_COPY"] = "YES"
    env["PGPASSWORD"] = require_pgpassword()
    result = subprocess.run(command, capture_output=True, text=True, env=env)
    if result.returncode != 0:
        raise RuntimeError(f"ogr2ogr failed: {result.stderr.strip() or result.stdout.strip()}")


def normalize_imported_table(conn: psycopg.Connection[DictRow], table_name: str) -> None:
    table_ref = qtable("gis_data", table_name)
    index_name = quote_ident(f"{table_name[:48]}_geom_gix")
    conn.execute(f"UPDATE {table_ref} SET geom = ST_MakeValid(geom) WHERE geom IS NOT NULL AND NOT ST_IsValid(geom)")
    conn.execute(f"DELETE FROM {table_ref} WHERE geom IS NULL")
    conn.execute(f"CREATE INDEX IF NOT EXISTS {index_name} ON {table_ref} USING GIST ({quote_ident('geom')})")
    conn.execute(f"ANALYZE {table_ref}")


def insert_layer_metadata(
    conn: psycopg.Connection[DictRow],
    project_id: str,
    name: str,
    table_name: str,
    source_srid: int | None,
    is_result: bool,
    layer_role: str = "generic",
    result_set_id: str | None = None,
    source_layer_id: str | None = None,
) -> str:
    stats = table_stats(conn, table_name)
    row = conn.execute(
        """
        INSERT INTO app.layers (
            project_id, name, schema_name, table_name, geometry_column, geometry_type,
            source_srid, display_srid, feature_id_column, bbox_4326, row_count,
            is_result, layer_role, result_set_id, source_layer_id, tile_source_id
        )
        VALUES (%s::uuid, %s, 'gis_data', %s, 'geom', %s, %s, 3857, 'fid',
                %s::jsonb, %s, %s, %s, %s::uuid, %s::uuid, %s)
        RETURNING id::text
        """,
        (
            project_id,
            name,
            table_name,
            stats["geometry_type"],
            source_srid,
            json.dumps(stats["bbox"]) if stats["bbox"] is not None else None,
            stats["row_count"],
            is_result,
            normalize_layer_role(layer_role),
            result_set_id,
            source_layer_id,
            table_name,
        ),
    ).fetchone()
    if row is None:
        raise RuntimeError(f"Layer metadata insert returned no row for {table_name}")
    layer_id: str = row["id"]
    insert_layer_attributes(conn, layer_id, table_name)
    return layer_id


def sync_zones_for_layer(conn: psycopg.Connection[DictRow], layer_id: str, project_id: str, table_name: str) -> None:
    columns = {
        row["column_name"]
        for row in conn.execute(
            """
            SELECT column_name
            FROM information_schema.columns
            WHERE table_schema = 'gis_data' AND table_name = %s
            """,
            (table_name,),
        ).fetchall()
    }
    candidates = [column for column in ["name", "区域名", "title", "zone_name", "Name", "NAME"] if column in columns]
    name_expr = ", ".join(f"NULLIF(t.{quote_ident(column)}::text, '')" for column in candidates) or "NULL"
    table_ref = qtable("gis_data", table_name)
    conn.execute(
        f"""
        INSERT INTO app.zones (
            id, project_id, name, zone_type, status, memo,
            zone_layer_id, zone_feature_id, source_layer_id, source_feature_id
        )
        SELECT
            concat('Z-', replace(%s::text, '-', ''), '-', t.{quote_ident("fid")}::text) AS id,
            %s::uuid AS project_id,
            COALESCE({name_expr}, concat('区域 ', t.{quote_ident("fid")}::text)) AS name,
            NULL::text AS zone_type,
            '有効'::text AS status,
            NULL::text AS memo,
            %s::uuid AS zone_layer_id,
            t.{quote_ident("fid")}::text AS zone_feature_id,
            %s::uuid AS source_layer_id,
            t.{quote_ident("fid")}::text AS source_feature_id
        FROM {table_ref} AS t
        WHERE t.{quote_ident("geom")} IS NOT NULL
          AND GeometryType(t.{quote_ident("geom")}) ILIKE '%%POLYGON%%'
        ON CONFLICT (zone_layer_id, zone_feature_id) DO UPDATE
        SET name = EXCLUDED.name,
            source_layer_id = EXCLUDED.source_layer_id,
            source_feature_id = EXCLUDED.source_feature_id,
            updated_at = now()
        """,
        (layer_id, project_id, layer_id, layer_id),
    )


def table_stats(conn: psycopg.Connection[DictRow], table_name: str) -> dict[str, Any]:
    table_ref = qtable("gis_data", table_name)
    row = conn.execute(
        f"""
        WITH stats AS (
            SELECT
                count(*)::bigint AS row_count,
                (array_agg(GeometryType(geom) ORDER BY GeometryType(geom))
                    FILTER (WHERE geom IS NOT NULL))[1] AS geometry_type,
                ST_Extent(ST_Transform(geom, 4326)) AS bbox
            FROM {table_ref}
        )
        SELECT
            row_count,
            COALESCE(geometry_type, 'GEOMETRY') AS geometry_type,
            CASE
                WHEN bbox IS NULL THEN NULL
                ELSE json_build_array(ST_XMin(bbox), ST_YMin(bbox), ST_XMax(bbox), ST_YMax(bbox))
            END AS bbox
        FROM stats
        """
    ).fetchone()
    if row is None:
        raise RuntimeError(f"table_stats returned no row for {table_name}")
    return {
        "row_count": row["row_count"],
        "geometry_type": row["geometry_type"],
        "bbox": row["bbox"],
    }


def insert_layer_attributes(conn: psycopg.Connection[DictRow], layer_id: str, table_name: str) -> None:
    rows = conn.execute(
        """
        SELECT column_name, data_type, udt_name, ordinal_position
        FROM information_schema.columns
        WHERE table_schema = 'gis_data' AND table_name = %s
        ORDER BY ordinal_position
        """,
        (table_name,),
    ).fetchall()
    for row in rows:
        is_geometry = row["column_name"] == "geom" or row["udt_name"] == "geometry"
        data_type = "geometry" if is_geometry else row["data_type"]
        conn.execute(
            """
            INSERT INTO app.layer_attributes (layer_id, name, data_type, ordinal_position, is_geometry)
            VALUES (%s::uuid, %s, %s, %s, %s)
            ON CONFLICT (layer_id, name) DO UPDATE
            SET data_type = EXCLUDED.data_type,
                ordinal_position = EXCLUDED.ordinal_position,
                is_geometry = EXCLUDED.is_geometry
            """,
            (layer_id, row["column_name"], data_type, row["ordinal_position"], is_geometry),
        )


def mark_import_failed(conn: psycopg.Connection[DictRow], job_id: str, exc: Exception) -> None:
    message = str(exc)[:4000]
    with conn.transaction():
        conn.execute(
            """
            UPDATE app.import_jobs
            SET status = 'failed', error_message = %s, finished_at = now()
            WHERE id = %s::uuid
            """,
            (message, job_id),
        )
    logger.warning("Import job %s failed: %s", job_id, message, extra={"job_id": job_id})


def is_s3_uri(reference: str) -> bool:
    # api 側 (UploadStorage.kt の isS3Reference) と対で保つ
    return reference.startswith("s3://")


def parse_s3_uri(reference: str) -> tuple[str, str]:
    """`s3://bucket/key` を (bucket, key) に分解する"""
    if not is_s3_uri(reference):
        raise ValueError(f"Not an s3:// reference: {reference}")
    bucket, _, key = reference.removeprefix("s3://").partition("/")
    if not bucket or not key:
        raise ValueError(f"Malformed s3:// reference: {reference}")
    return bucket, key


def s3_client() -> Any:
    # 認証は boto3 の既定チェーン (本番: ECS タスクロール / dev: AWS_ACCESS_KEY_ID 等)。
    # S3_ENDPOINT_URL は MinIO 等の dev 用 (compose は未設定を空文字で渡すため or None)
    endpoint = os.getenv("S3_ENDPOINT_URL") or None
    return boto3.client("s3", endpoint_url=endpoint)


def fetch_upload(upload_path: str) -> tuple[str, str | None]:
    """アップロード参照をローカルパスへ解決する。戻り値は (ローカルパス, 後始末する一時ディレクトリ | None)。

    S3 参照は GDAL /vsis3 の直読みではなく一時ファイルへのダウンロードで扱う:
    - 取込前のアーカイブ検査 (zip 展開検査、issue #19 予定) はローカル実体が前提になる
    - shapefile (/vsizip) は zip 内の複数メンバーを繰り返し読むため、1 回のダウンロードの方が
      HTTP レンジアクセスより単純で決定的
    - MinIO 向けの endpoint / path-style 設定を boto3 に一元化できる (GDAL の AWS_* 環境変数と
      二重管理しない)
    """
    if not is_s3_uri(upload_path):
        return upload_path, None
    bucket, key = parse_s3_uri(upload_path)
    temp_dir = tempfile.mkdtemp(prefix="import-s3-")
    local_path = os.path.join(temp_dir, os.path.basename(key) or "upload.dat")
    try:
        s3_client().download_file(bucket, key, local_path)
    except Exception:
        shutil.rmtree(temp_dir, ignore_errors=True)
        raise
    return local_path, temp_dir


def input_driver(import_format: str) -> str:
    """受付形式に対応する GDAL 入力ドライバを返す。allowlist 外は取込前に拒否する"""
    driver = INPUT_DRIVERS.get(import_format)
    if driver is None:
        allowed = ", ".join(sorted(INPUT_DRIVERS))
        raise ValueError(f"許可されていない取込形式です: {import_format} (許可: {allowed})")
    return driver


def zip_limits() -> tuple[int, int]:
    # 呼び出し時に読む (プロセス生存中の env 変更をテストで扱いやすくするのと、起動順序に依存しない)
    return (
        int(os.getenv("IMPORT_ZIP_MAX_ENTRIES", str(DEFAULT_ZIP_MAX_ENTRIES))),
        int(os.getenv("IMPORT_ZIP_MAX_TOTAL_BYTES", str(DEFAULT_ZIP_MAX_TOTAL_BYTES))),
    )


def inspect_zip_archive(path: str, *, max_entries: int, max_total_bytes: int) -> None:
    """ogr2ogr (/vsizip) へ渡す前の zip 検査。違反は ValueError → import ジョブ failed + 理由。

    - zip として読めないものを拒否する (拡張子偽装)
    - エントリ数上限 (IMPORT_ZIP_MAX_ENTRIES)
    - 合計展開サイズ上限 (IMPORT_ZIP_MAX_TOTAL_BYTES)。セントラルディレクトリの宣言値で
      判定する (zipfile は宣言超過の伸長を許さないため、宣言を偽っても実体は取り出せない)
    - ネストされた zip の拒否 (再帰展開型の zip 爆弾)
    - パストラバーサル (絶対パス・ドライブレター・`..` セグメント) の拒否
    """
    try:
        with zipfile.ZipFile(path) as archive:
            entries = archive.infolist()
    except zipfile.BadZipFile as exc:
        raise ValueError(f"zip アーカイブとして読み込めません: {exc}") from exc

    if len(entries) > max_entries:
        raise ValueError(f"zip のエントリ数が上限を超えています: {len(entries)} > {max_entries}")

    total_bytes = 0
    for entry in entries:
        name = entry.filename
        segments = re.split(r"[\\/]+", name)
        if name.startswith(("/", "\\")) or re.match(r"^[A-Za-z]:", name) or ".." in segments:
            raise ValueError(f"zip エントリのパスが不正です (パストラバーサル): {name}")
        if name.lower().endswith(".zip"):
            raise ValueError(f"ネストされた zip は許可されていません: {name}")
        total_bytes += entry.file_size
        if total_bytes > max_total_bytes:
            raise ValueError(f"zip の合計展開サイズが上限を超えています: {total_bytes} > {max_total_bytes} バイト")


def ogr_source(upload_path: str, import_format: str) -> str:
    if import_format == "shapefile":
        return f"/vsizip/{upload_path}"
    return upload_path


def make_table_name(filename: str, job_id: str) -> str:
    stem = Path(filename).stem.lower()
    stem = re.sub(r"[^a-z0-9]+", "_", stem).strip("_") or "layer"
    return f"layer_{job_id.replace('-', '')[:12]}_{stem[:32]}"


def qtable(schema: str, table: str) -> str:
    return f"{quote_ident(schema)}.{quote_ident(table)}"


def quote_ident(value: str) -> str:
    if not value:
        raise ValueError("Identifier must not be empty")
    return '"' + value.replace('"', '""') + '"'


def normalize_layer_role(value: str | None) -> str:
    role = (value or "generic").strip().lower() or "generic"
    if role not in {"generic", "zone"}:
        raise ValueError("layerRole must be generic or zone")
    return role


if __name__ == "__main__":
    main()
