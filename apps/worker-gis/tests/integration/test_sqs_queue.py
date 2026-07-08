# SQS 経路 (JOB_QUEUE_MODE=sqs) の統合テスト (issue #24)。
# PostGIS + ogr2ogr に加え、SQS はテストプロセス内の moto server で立てる
# (CI の worker-integration ジョブは PostGIS しか持たないため自己完結させる)。
#
# 検証対象は実行保証の各層:
#   - enqueue → consume → claim → succeeded の基本経路
#   - 同一メッセージの二重配信が claim の冪等ガードで無害なこと (第 2 層)
#   - 実行中の強制 kill から再配信 + スイープで二重実行なしに収束すること (第 3 層)
#   - 試行上限超過の failed 化と pending 滞留の再 enqueue (第 1・5 層)
import json
import os
import signal
import subprocess
import sys
import time
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any

import boto3
import pytest
from moto.server import ThreadedMotoServer

from src.worker import make_table_name, poll_sqs_once, sweep_import_jobs, sweep_stale_import_jobs

pytestmark = pytest.mark.integration

PROJECT_ID = "00000000-0000-0000-0000-000000000000"
REPO_ROOT = Path(__file__).resolve().parents[4]
WORKER_DIR = REPO_ROOT / "apps" / "worker-gis"
SAMPLE_GEOJSON = REPO_ROOT / "samples" / "geojson" / "parcels.geojson"


@pytest.fixture(scope="module")
def sqs_endpoint() -> Iterator[str]:
    # moto は資格情報を検証しないが boto3 の既定チェーンは解決可能な値を要求する
    os.environ.setdefault("AWS_ACCESS_KEY_ID", "test")
    os.environ.setdefault("AWS_SECRET_ACCESS_KEY", "test")
    os.environ.setdefault("AWS_DEFAULT_REGION", "us-east-1")
    server = ThreadedMotoServer(port=0, verbose=False)
    server.start()
    host, port = server.get_host_and_port()
    yield f"http://{host}:{port}"
    server.stop()


@pytest.fixture()
def sqs(sqs_endpoint: str) -> Any:
    return boto3.client("sqs", endpoint_url=sqs_endpoint, region_name="us-east-1")


@pytest.fixture()
def queue_url(sqs: Any, request: pytest.FixtureRequest) -> str:
    # テストごとに独立したキュー (visibility timeout は再配信テストを速く回すため 2 秒)
    name = f"import-jobs-{request.node.name.replace('_', '-')[:50]}"
    response = sqs.create_queue(QueueName=name, Attributes={"VisibilityTimeout": "2"})
    url: str = response["QueueUrl"]
    return url


@pytest.fixture(autouse=True)
def fast_receive(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SQS_RECEIVE_WAIT_SECONDS", "1")


def insert_import_job(conn: Any, upload_path: Path = SAMPLE_GEOJSON) -> str:
    with conn.transaction():
        row = conn.execute(
            """
            INSERT INTO app.import_jobs (project_id, filename, format, source_srid, upload_path, layer_role)
            VALUES (%s::uuid, %s, 'geojson', 4326, %s, 'generic')
            RETURNING id::text AS id
            """,
            (PROJECT_ID, upload_path.name, str(upload_path)),
        ).fetchone()
    assert row is not None
    job_id: str = row["id"]
    return job_id


def send_notification(sqs: Any, queue_url: str, job_id: str) -> None:
    sqs.send_message(QueueUrl=queue_url, MessageBody=json.dumps({"jobId": job_id}))


def fetch_job(conn: Any, job_id: str) -> dict[str, Any]:
    # 読み取りも明示トランザクションで閉じる (暗黙トランザクションを残すと、以降の
    # conn.transaction() が SAVEPOINT になり INSERT が別プロセスのワーカーから見えなくなる)
    with conn.transaction():
        row = conn.execute(
            """
            SELECT status, error_message, attempt_count, heartbeat_at, layer_id::text AS layer_id, filename
            FROM app.import_jobs WHERE id = %s::uuid
            """,
            (job_id,),
        ).fetchone()
    assert row is not None
    return dict(row)


def count_registered_layers(conn: Any, job_id: str, filename: str) -> int:
    # 取込テーブル名はジョブ ID から決定的に決まる。二重実行されると app.layers に同じ
    # table_name の行が 2 件登録されるため、1 件であることが「二重実行なし」の証跡になる
    with conn.transaction():
        row = conn.execute(
            "SELECT count(*) FROM app.layers WHERE table_name = %s",
            (make_table_name(filename, job_id),),
        ).fetchone()
    assert row is not None
    return int(row["count"])


def wait_for(predicate: Callable[[], bool], timeout_seconds: float, message: str | Callable[[], str]) -> None:
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.2)
    detail = message() if callable(message) else message
    raise AssertionError(f"タイムアウト ({timeout_seconds}s): {detail}")


def queue_is_empty(sqs: Any, queue_url: str) -> bool:
    attrs = sqs.get_queue_attributes(
        QueueUrl=queue_url,
        AttributeNames=["ApproximateNumberOfMessages", "ApproximateNumberOfMessagesNotVisible"],
    )["Attributes"]
    return attrs["ApproximateNumberOfMessages"] == "0" and attrs["ApproximateNumberOfMessagesNotVisible"] == "0"


# ---------------------------------------------------------------- 基本経路


def test_enqueue_consume_claim_completes_job(conn: Any, sqs: Any, queue_url: str) -> None:
    job_id = insert_import_job(conn)
    send_notification(sqs, queue_url, job_id)

    handled = poll_sqs_once(conn, sqs, queue_url)

    assert handled == 1
    job = fetch_job(conn, job_id)
    assert job["status"] == "succeeded", f"error: {job['error_message']}"
    assert job["attempt_count"] == 1
    assert job["layer_id"] is not None
    assert queue_is_empty(sqs, queue_url), "処理完了後はメッセージが削除されるはず"


def test_malformed_message_is_dropped(conn: Any, sqs: Any, queue_url: str) -> None:
    sqs.send_message(QueueUrl=queue_url, MessageBody="not-json")
    handled = poll_sqs_once(conn, sqs, queue_url)
    assert handled == 1
    assert queue_is_empty(sqs, queue_url), "毒メッセージは削除されて収束するはず"


# ---------------------------------------------------------------- 二重配信 (第 2 層)


def test_duplicate_delivery_does_not_run_job_twice(conn: Any, sqs: Any, queue_url: str) -> None:
    job_id = insert_import_job(conn)
    # 同一ジョブの起動通知を 2 通配信する (at-least-once の重複配信を再現)
    send_notification(sqs, queue_url, job_id)
    send_notification(sqs, queue_url, job_id)

    assert poll_sqs_once(conn, sqs, queue_url) == 1
    assert poll_sqs_once(conn, sqs, queue_url) == 1

    job = fetch_job(conn, job_id)
    assert job["status"] == "succeeded", f"error: {job['error_message']}"
    assert job["attempt_count"] == 1, "2 通目は claim に失敗して破棄されるはず (二重実行なし)"
    assert count_registered_layers(conn, job_id, job["filename"]) == 1
    assert queue_is_empty(sqs, queue_url)


# ---------------------------------------------------------------- 強制 kill からの回復 (第 3 層)


def spawn_worker(
    queue_url: str, sqs_endpoint: str, extra_env: dict[str, str], log_path: Path
) -> subprocess.Popen[bytes]:
    env = os.environ.copy()
    env.update(
        {
            "JOB_QUEUE_MODE": "sqs",
            "SQS_IMPORT_QUEUE_URL": queue_url,
            "SQS_ENDPOINT_URL": sqs_endpoint,
            "AWS_ACCESS_KEY_ID": "test",
            "AWS_SECRET_ACCESS_KEY": "test",
            "AWS_DEFAULT_REGION": "us-east-1",
            "SQS_RECEIVE_WAIT_SECONDS": "1",
            "SWEEP_INTERVAL_SECONDS": "1",
        }
    )
    env.update(extra_env)
    with log_path.open("wb") as log_file:
        return subprocess.Popen(
            [sys.executable, "-m", "src.worker"],
            cwd=WORKER_DIR,
            env=env,
            stdout=log_file,
            stderr=subprocess.STDOUT,
        )


def test_killed_worker_job_is_recovered_by_another_worker(
    conn: Any, sqs: Any, queue_url: str, sqs_endpoint: str, tmp_path: Path
) -> None:
    job_id = insert_import_job(conn)
    send_notification(sqs, queue_url, job_id)

    # worker A: claim 直後にテスト専用フックで実行を保留させ、その間に SIGKILL する
    # (claim 済み running 行 + 未削除メッセージが残る = 実行中クラッシュの再現)
    worker_a_log = tmp_path / "worker-a.log"
    worker_a = spawn_worker(
        queue_url,
        sqs_endpoint,
        {
            "IMPORT_TEST_CLAIM_HOLD_SECONDS": "120",
            "IMPORT_VISIBILITY_EXTENSION_SECONDS": "3",
        },
        worker_a_log,
    )
    try:
        wait_for(
            lambda: fetch_job(conn, job_id)["status"] == "running",
            timeout_seconds=30,
            message=lambda: f"worker A がジョブを claim するはず (worker log: {worker_a_log.read_text()!r})",
        )
        assert fetch_job(conn, job_id)["attempt_count"] == 1
    finally:
        worker_a.kill()
        worker_a.wait(timeout=10)

    # worker B: 短いハートビート途絶閾値と補完スキャンで回収し、最後まで実行する
    worker_b_log = tmp_path / "worker-b.log"
    worker_b = spawn_worker(
        queue_url,
        sqs_endpoint,
        {
            "IMPORT_JOB_STALE_SECONDS": "2",
            "IMPORT_JOB_REENQUEUE_SECONDS": "1",
        },
        worker_b_log,
    )
    try:
        wait_for(
            lambda: fetch_job(conn, job_id)["status"] in {"succeeded", "failed"},
            timeout_seconds=60,
            message=lambda: f"worker B が回収して収束させるはず (worker log: {worker_b_log.read_text()!r})",
        )
    finally:
        worker_b.send_signal(signal.SIGTERM)
        try:
            worker_b.wait(timeout=10)
        except subprocess.TimeoutExpired:
            worker_b.kill()
            worker_b.wait(timeout=10)

    job = fetch_job(conn, job_id)
    assert job["status"] == "succeeded", f"error: {job['error_message']}"
    assert job["attempt_count"] == 2, "kill 後の再実行で claim は 2 回目になるはず"
    assert count_registered_layers(conn, job_id, job["filename"]) == 1, "レイヤ登録は 1 回だけ (二重実行なし)"


# ---------------------------------------------------------------- 収束と補完スキャン (第 1・5 層)


def test_sweep_fails_job_after_attempt_limit(conn: Any) -> None:
    job_id = insert_import_job(conn)
    # 試行上限まで claim 済みでハートビートが途絶した running 行を再現する
    with conn.transaction():
        conn.execute(
            """
            UPDATE app.import_jobs
            SET status = 'running', started_at = now() - interval '10 minutes',
                heartbeat_at = now() - interval '10 minutes', attempt_count = 5
            WHERE id = %s::uuid
            """,
            (job_id,),
        )

    requeued, failed = sweep_stale_import_jobs(conn, heartbeat_timeout_seconds=60, max_attempts=5)

    assert failed == 1 and requeued == 0
    job = fetch_job(conn, job_id)
    assert job["status"] == "failed", "試行上限超過のジョブは failed へ収束するはず"
    assert job["error_message"]


def test_sweep_reenqueues_stale_pending_job(conn: Any, sqs: Any, queue_url: str) -> None:
    job_id = insert_import_job(conn)
    # enqueue が取りこぼされたまま滞留した pending 行を再現する
    with conn.transaction():
        conn.execute(
            "UPDATE app.import_jobs SET created_at = now() - interval '10 minutes' WHERE id = %s::uuid",
            (job_id,),
        )

    sweep_import_jobs(conn, sqs, queue_url)

    # 補完スキャンが送った通知だけでジョブが完走する (enqueue 消失からの回収)
    assert poll_sqs_once(conn, sqs, queue_url) == 1
    job = fetch_job(conn, job_id)
    assert job["status"] == "succeeded", f"error: {job['error_message']}"
