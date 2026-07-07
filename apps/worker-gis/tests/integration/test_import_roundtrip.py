# GDAL (ogr2ogr) + PostGIS 実体に対する取込ラウンドトリップ統合テスト。
# 実行には PG* 環境変数で接続できる PostGIS と ogr2ogr が必要 (pytest -m integration)。
# fail-closed: 前提が無ければスキップではなく失敗する
import shutil
from pathlib import Path
from typing import Any

import pytest

from src.worker import claim_import_job, connect, qtable, run_import_job

pytestmark = pytest.mark.integration

PROJECT_ID = "00000000-0000-0000-0000-000000000000"
REPO_ROOT = Path(__file__).resolve().parents[4]
SAMPLE_GEOJSON = REPO_ROOT / "samples" / "geojson" / "parcels.geojson"


@pytest.fixture(scope="module")
def conn() -> Any:
    assert shutil.which("ogr2ogr"), "ogr2ogr が必要です (fail-closed: apt install gdal-bin)"
    connection = connect()
    # スキーマを作り直して決定的な状態から始める
    with connection.transaction():
        connection.execute("DROP SCHEMA IF EXISTS app CASCADE")
        connection.execute("DROP SCHEMA IF EXISTS gis_data CASCADE")
    init_sql = (REPO_ROOT / "infra" / "postgres" / "init.sql").read_text()
    with connection.transaction():
        connection.execute(init_sql)
    yield connection
    connection.close()


def enqueue_and_run(conn: Any, layer_role: str) -> dict[str, Any]:
    with conn.transaction():
        conn.execute(
            """
            INSERT INTO app.import_jobs (project_id, filename, format, source_srid, upload_path, layer_role)
            VALUES (%s::uuid, %s, 'geojson', 4326, %s, %s)
            """,
            (PROJECT_ID, SAMPLE_GEOJSON.name, str(SAMPLE_GEOJSON), layer_role),
        )
    job = claim_import_job(conn)
    assert job is not None, "投入した取込ジョブが claim できるはず"
    run_import_job(conn, job)
    row = conn.execute(
        "SELECT status, error_message, layer_id::text FROM app.import_jobs WHERE id = %s::uuid",
        (job["id"],),
    ).fetchone()
    assert row is not None
    return row


def test_geojson_import_satisfies_layer_contract(conn: Any) -> None:
    job = enqueue_and_run(conn, "generic")
    assert job["status"] == "succeeded", f"error: {job['error_message']}"

    layer = conn.execute(
        """
        SELECT table_name, geometry_type, row_count, bbox_4326
        FROM app.layers WHERE id = %s::uuid
        """,
        (job["layer_id"],),
    ).fetchone()
    assert layer is not None

    # レイヤ契約: 3857 格納・valid・行数一致・GiST インデックス・属性登録・bbox は 4326
    stats = conn.execute(
        f"""
        SELECT
            count(*) AS cnt,
            bool_and(ST_SRID(geom) = 3857) AS srid_ok,
            bool_and(ST_IsValid(geom)) AS valid_ok,
            bool_and(GeometryType(geom) = 'MULTIPOLYGON') AS multi_ok
        FROM {qtable("gis_data", layer["table_name"])}
        """
    ).fetchone()
    assert stats is not None
    assert stats["cnt"] == 2, "parcels.geojson は 2 フィーチャ"
    assert stats["srid_ok"], "格納 SRID は 3857"
    assert stats["valid_ok"], "全ジオメトリが ST_IsValid"
    assert stats["multi_ok"], "PROMOTE_TO_MULTI により MultiPolygon"
    assert layer["row_count"] == 2

    bbox = layer["bbox_4326"]
    assert bbox is not None and len(bbox) == 4
    # 東京駅近辺の座標が 4326 のまま公開されていること (3857 のメートル値なら桁が大きく異なる)
    assert 139.0 < bbox[0] < 140.0 and 35.0 < bbox[1] < 36.0

    index_count = conn.execute(
        """
        SELECT count(*) FROM pg_indexes
        WHERE schemaname = 'gis_data' AND tablename = %s AND indexdef LIKE '%%USING gist%%'
        """,
        (layer["table_name"],),
    ).fetchone()
    assert index_count is not None and index_count["count"] >= 1, "GiST インデックスが必要"

    attributes = {
        row["name"]
        for row in conn.execute(
            "SELECT name FROM app.layer_attributes WHERE layer_id = %s::uuid AND NOT is_geometry",
            (job["layer_id"],),
        ).fetchall()
    }
    assert {"parcel_no", "landuse", "area_m2"} <= attributes, "元 GeoJSON の属性が登録されるはず"


def test_zone_role_import_syncs_zones(conn: Any) -> None:
    job = enqueue_and_run(conn, "zone")
    assert job["status"] == "succeeded", f"error: {job['error_message']}"

    zones = conn.execute(
        "SELECT count(*) FROM app.zones WHERE zone_layer_id = %s::uuid",
        (job["layer_id"],),
    ).fetchone()
    assert zones is not None and zones["count"] == 2, "ポリゴン 2 件ぶんの区域が同期されるはず"


def test_broken_input_marks_job_failed(conn: Any, tmp_path: Path) -> None:
    broken = tmp_path / "broken.geojson"
    broken.write_text('{"type": "FeatureCollection", "features": [{')
    with conn.transaction():
        conn.execute(
            """
            INSERT INTO app.import_jobs (project_id, filename, format, source_srid, upload_path, layer_role)
            VALUES (%s::uuid, %s, 'geojson', 4326, %s, 'generic')
            """,
            (
                PROJECT_ID,
                broken.name,
                str(broken),
            ),
        )
    job = claim_import_job(conn)
    assert job is not None
    run_import_job(conn, job)
    row = conn.execute(
        "SELECT status, error_message FROM app.import_jobs WHERE id = %s::uuid",
        (job["id"],),
    ).fetchone()
    assert row is not None
    assert row["status"] == "failed"
    assert row["error_message"], "失敗理由が記録されるはず"
