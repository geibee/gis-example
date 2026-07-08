# 悪意入力に対する取込防御の回帰テスト (issue #19)。
# VRT を含む zip・zip 爆弾・偽装拡張子・パストラバーサル zip・許可外形式が
# 「取込前に拒否され、failed + 理由が記録される」ことを GDAL + PostGIS 実体で検証する。
# DB スキーマの準備 (conn フィクスチャ) は conftest.py が持つ
import subprocess
import zipfile
from pathlib import Path
from typing import Any

import pytest

from src.worker import claim_import_job, run_import_job

pytestmark = pytest.mark.integration

PROJECT_ID = "00000000-0000-0000-0000-000000000000"
REPO_ROOT = Path(__file__).resolve().parents[4]
SAMPLE_GEOJSON = REPO_ROOT / "samples" / "geojson" / "parcels.geojson"


def make_zip(path: Path, entries: dict[str, bytes]) -> Path:
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for name, data in entries.items():
            archive.writestr(name, data)
    return path


def enqueue_and_run(conn: Any, upload_path: Path, import_format: str) -> dict[str, Any]:
    with conn.transaction():
        conn.execute(
            """
            INSERT INTO app.import_jobs (project_id, filename, format, source_srid, upload_path, layer_role)
            VALUES (%s::uuid, %s, %s, 4326, %s, 'generic')
            """,
            (PROJECT_ID, upload_path.name, import_format, str(upload_path)),
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


def test_zip_containing_vrt_is_rejected_by_driver_allowlist(conn: Any, tmp_path: Path) -> None:
    # VRT はローカルファイル読取・外部フェッチの起点になる。-if 'ESRI Shapefile' により
    # VRT ドライバは選択されず、shapefile の実体が無い zip は開けずに failed になる
    vrt = (
        '<OGRVRTDataSource><OGRVRTLayer name="pw">'
        "<SrcDataSource>/etc/passwd</SrcDataSource>"
        "</OGRVRTLayer></OGRVRTDataSource>"
    )
    path = make_zip(tmp_path / "evil-vrt.zip", {"evil.vrt": vrt.encode()})
    row = enqueue_and_run(conn, path, "shapefile")
    assert row["status"] == "failed"
    assert "ogr2ogr failed" in (row["error_message"] or ""), f"error: {row['error_message']}"
    assert row["layer_id"] is None


def test_zip_bomb_is_rejected_before_ogr2ogr(conn: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    # 高圧縮率 (数 MB の zero 埋め → 数 KB) でも宣言展開サイズで拒否する
    monkeypatch.setenv("IMPORT_ZIP_MAX_TOTAL_BYTES", str(1024 * 1024))
    path = make_zip(tmp_path / "bomb.zip", {"zeros.shp": b"\0" * (4 * 1024 * 1024)})
    assert path.stat().st_size < 64 * 1024, "テスト前提: 圧縮後は小さい zip 爆弾であること"
    row = enqueue_and_run(conn, path, "shapefile")
    assert row["status"] == "failed"
    assert "合計展開サイズが上限" in (row["error_message"] or "")


def test_zip_with_too_many_entries_is_rejected(conn: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("IMPORT_ZIP_MAX_ENTRIES", "3")
    path = make_zip(tmp_path / "many.zip", {f"f{i}.dat": b"x" for i in range(5)})
    row = enqueue_and_run(conn, path, "shapefile")
    assert row["status"] == "failed"
    assert "エントリ数が上限" in (row["error_message"] or "")


def test_path_traversal_zip_is_rejected(conn: Any, tmp_path: Path) -> None:
    path = make_zip(tmp_path / "traversal.zip", {"../../outside.shp": b"x"})
    row = enqueue_and_run(conn, path, "shapefile")
    assert row["status"] == "failed"
    assert "パストラバーサル" in (row["error_message"] or "")


def test_nested_zip_is_rejected(conn: Any, tmp_path: Path) -> None:
    inner = make_zip(tmp_path / "inner.zip", {"a.shp": b"x"})
    path = make_zip(tmp_path / "nested.zip", {"inner.zip": inner.read_bytes()})
    row = enqueue_and_run(conn, path, "shapefile")
    assert row["status"] == "failed"
    assert "ネストされた zip" in (row["error_message"] or "")


def test_disguised_geojson_with_zip_content_fails(conn: Any, tmp_path: Path) -> None:
    # api のマジックバイト検査をすり抜けた想定 (直接 DB 投入)。-if GeoJSON により
    # zip 実体は GeoJSON として開けず failed になる (別ドライバへのフォールバックをしない)
    disguised = tmp_path / "disguised.geojson"
    make_zip(disguised, {"a.shp": b"x" * 16})
    row = enqueue_and_run(conn, disguised, "geojson")
    assert row["status"] == "failed"
    assert "ogr2ogr failed" in (row["error_message"] or "")


def test_format_outside_allowlist_fails_before_download(conn: Any, tmp_path: Path) -> None:
    # DB に直接投入された許可外形式 (api は 400 で拒否するが、多層防御として worker も拒否)
    kml = tmp_path / "doc.kml"
    kml.write_text('<?xml version="1.0"?><kml xmlns="http://www.opengis.net/kml/2.2"></kml>')
    row = enqueue_and_run(conn, kml, "kml")
    assert row["status"] == "failed"
    assert "許可されていない取込形式" in (row["error_message"] or "")


def test_legitimate_shapefile_zip_still_imports(conn: Any, tmp_path: Path) -> None:
    # -if 'ESRI Shapefile' と zip 検査が正当な取込を壊さないこと (回帰ガード)
    shp_dir = tmp_path / "shp"
    shp_dir.mkdir()
    subprocess.run(
        ["ogr2ogr", "-f", "ESRI Shapefile", str(shp_dir / "parcels.shp"), str(SAMPLE_GEOJSON)],
        check=True,
        capture_output=True,
    )
    entries = {member.name: member.read_bytes() for member in shp_dir.iterdir()}
    assert any(name.endswith(".shp") for name in entries)
    path = make_zip(tmp_path / "parcels.zip", entries)
    row = enqueue_and_run(conn, path, "shapefile")
    assert row["status"] == "succeeded", f"error: {row['error_message']}"
    assert row["layer_id"] is not None
