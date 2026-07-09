# worker の純粋関数に対する Level 1 (決定的) テスト。
# DB / GDAL 不要で実行できるものだけをここに置く
import json
import logging
import zipfile
from pathlib import Path

import pytest

from src.worker import (
    DEFAULT_ZIP_MAX_ENTRIES,
    DEFAULT_ZIP_MAX_TOTAL_BYTES,
    JsonLinesFormatter,
    configure_logging,
    decode_job_message,
    fetch_upload,
    input_driver,
    inspect_zip_archive,
    is_s3_uri,
    job_queue_mode,
    make_table_name,
    normalize_layer_role,
    ogr_source,
    parse_s3_uri,
    qtable,
    quote_ident,
    zip_limits,
)


class TestJobQueueMessage:
    # メッセージ本文は api 側 (JobQueue.kt の encodeJobQueueMessage / JobQueueTest) と
    # 共有する契約。形を変えるときは両側のテストを更新すること

    def test_decodes_job_id(self) -> None:
        assert decode_job_message('{"jobId":"6b1f0000-0000-0000-0000-000000000024"}') == (
            "6b1f0000-0000-0000-0000-000000000024"
        )

    def test_ignores_unknown_fields(self) -> None:
        assert decode_job_message('{"jobId":"abc","futureField":1}') == "abc"

    def test_malformed_body_returns_none(self) -> None:
        # 解釈できない毒メッセージは None (consumer が削除して収束させる)
        assert decode_job_message("not-json") is None
        assert decode_job_message("{}") is None
        assert decode_job_message('{"jobId":""}') is None
        assert decode_job_message("[1,2,3]") is None


class TestJobQueueMode:
    def test_defaults_to_polling(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.delenv("JOB_QUEUE_MODE", raising=False)
        assert job_queue_mode() == "polling"

    def test_accepts_sqs(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("JOB_QUEUE_MODE", "sqs")
        assert job_queue_mode() == "sqs"

    def test_rejects_unknown_mode(self, monkeypatch: pytest.MonkeyPatch) -> None:
        # 不正値で黙って polling へ落ちると片肺構成になり得るため fail fast
        monkeypatch.setenv("JOB_QUEUE_MODE", "kafka")
        with pytest.raises(RuntimeError):
            job_queue_mode()


class TestQuoteIdent:
    def test_plain_identifier(self) -> None:
        assert quote_ident("geom") == '"geom"'

    def test_embedded_double_quote_is_escaped(self) -> None:
        # 識別子経由の SQL インジェクションを防ぐ核心の仕様
        assert quote_ident('x"; DROP TABLE app.layers; --') == '"x""; DROP TABLE app.layers; --"'

    def test_empty_identifier_rejected(self) -> None:
        with pytest.raises(ValueError):
            quote_ident("")

    def test_qtable_quotes_both_parts(self) -> None:
        assert qtable("gis_data", 'evil"t') == '"gis_data"."evil""t"'


class TestMakeTableName:
    def test_normalizes_filename(self) -> None:
        name = make_table_name("Tokyo Parcels (2023).geojson", "12345678-abcd-efgh-ijkl-000000000000")
        assert name == "layer_12345678abcd_tokyo_parcels_2023"

    def test_falls_back_when_stem_has_no_ascii(self) -> None:
        name = make_table_name("東京都.geojson", "12345678-abcd-efgh-ijkl-000000000000")
        assert name == "layer_12345678abcd_layer"

    def test_result_is_valid_lowercase_identifier(self) -> None:
        name = make_table_name("A-B_c.1.SHP.zip", "deadbeef-0000-0000-0000-000000000000")
        assert name == name.lower()
        assert " " not in name and '"' not in name


class TestOgrSource:
    def test_shapefile_uses_vsizip(self) -> None:
        assert ogr_source("/data/uploads/a.zip", "shapefile") == "/vsizip//data/uploads/a.zip"

    def test_other_formats_pass_through(self) -> None:
        assert ogr_source("/data/uploads/a.geojson", "geojson") == "/data/uploads/a.geojson"


class TestS3Uri:
    def test_is_s3_uri(self) -> None:
        assert is_s3_uri("s3://gis-uploads/uploads/a.zip")
        assert not is_s3_uri("/data/uploads/a.zip")

    def test_parse_splits_bucket_and_key(self) -> None:
        assert parse_s3_uri("s3://gis-uploads/uploads/abc-a.zip") == ("gis-uploads", "uploads/abc-a.zip")

    def test_parse_rejects_non_s3_reference(self) -> None:
        with pytest.raises(ValueError):
            parse_s3_uri("/data/uploads/a.zip")

    def test_parse_rejects_bucket_without_key(self) -> None:
        with pytest.raises(ValueError):
            parse_s3_uri("s3://bucket-only")


class TestFetchUpload:
    def test_local_path_passes_through_without_temp_dir(self) -> None:
        # ローカル参照は S3 に触れず、後始末すべき一時ディレクトリも無い
        local, temp_dir = fetch_upload("/data/uploads/a.geojson")
        assert local == "/data/uploads/a.geojson"
        assert temp_dir is None

    def test_s3_download_failure_cleans_up_temp_dir(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        created: list[str] = []
        real_mkdtemp = __import__("tempfile").mkdtemp

        def tracking_mkdtemp(prefix: str) -> str:
            path = real_mkdtemp(prefix=prefix, dir=tmp_path)
            created.append(path)
            return path

        class FailingClient:
            def download_file(self, bucket: str, key: str, local_path: str) -> None:
                raise RuntimeError("simulated download failure")

        monkeypatch.setattr("src.worker.tempfile", type("T", (), {"mkdtemp": staticmethod(tracking_mkdtemp)}))
        monkeypatch.setattr("src.worker.s3_client", lambda: FailingClient())
        with pytest.raises(RuntimeError):
            fetch_upload("s3://bucket/uploads/a.zip")
        assert created, "一時ディレクトリが作られるはず"
        assert not Path(created[0]).exists(), "ダウンロード失敗時は一時ディレクトリを残さない"


class TestInputDriver:
    def test_maps_accepted_formats_to_allowlisted_drivers(self) -> None:
        # 受付形式と 1:1 の allowlist (GeoJSON / ESRI Shapefile のみ)
        assert input_driver("geojson") == "GeoJSON"
        assert input_driver("shapefile") == "ESRI Shapefile"

    @pytest.mark.parametrize("fmt", ["vrt", "csv", "gml", "kml", "gpx", "", "GeoJSON"])
    def test_rejects_formats_outside_allowlist(self, fmt: str) -> None:
        # VRT 等の危険ドライバはもちろん、allowlist 外はすべて取込前に拒否する
        with pytest.raises(ValueError, match="許可されていない取込形式"):
            input_driver(fmt)


def make_zip(path: Path, entries: dict[str, bytes]) -> str:
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for name, data in entries.items():
            archive.writestr(name, data)
    return str(path)


class TestInspectZipArchive:
    def test_accepts_ordinary_shapefile_zip(self, tmp_path: Path) -> None:
        path = make_zip(tmp_path / "ok.zip", {"a.shp": b"x" * 10, "a.dbf": b"y" * 10, "folder/a.prj": b"z"})
        inspect_zip_archive(path, max_entries=100, max_total_bytes=1024)

    def test_rejects_non_zip_content(self, tmp_path: Path) -> None:
        fake = tmp_path / "fake.zip"
        fake.write_text('{"type": "FeatureCollection"}')
        with pytest.raises(ValueError, match="zip アーカイブとして読み込めません"):
            inspect_zip_archive(str(fake), max_entries=100, max_total_bytes=1024)

    def test_rejects_too_many_entries(self, tmp_path: Path) -> None:
        path = make_zip(tmp_path / "many.zip", {f"f{i}.dat": b"x" for i in range(5)})
        with pytest.raises(ValueError, match="エントリ数が上限"):
            inspect_zip_archive(path, max_entries=4, max_total_bytes=1024)

    def test_rejects_total_uncompressed_size_over_limit(self, tmp_path: Path) -> None:
        # 高圧縮率の zip 爆弾: 圧縮後は小さくても宣言展開サイズで拒否する
        path = make_zip(tmp_path / "bomb.zip", {"zeros.shp": b"\0" * (1024 * 1024)})
        assert Path(path).stat().st_size < 16 * 1024, "テスト前提: 圧縮後は小さい"
        with pytest.raises(ValueError, match="合計展開サイズが上限"):
            inspect_zip_archive(path, max_entries=100, max_total_bytes=1024 * 512)

    def test_rejects_nested_zip(self, tmp_path: Path) -> None:
        path = make_zip(tmp_path / "nested.zip", {"inner.ZIP": b"PK\x03\x04junk"})
        with pytest.raises(ValueError, match="ネストされた zip"):
            inspect_zip_archive(path, max_entries=100, max_total_bytes=1024)

    @pytest.mark.parametrize(
        "name",
        [
            "../evil.shp",
            "dir/../../evil.shp",
            "/etc/passwd",
            "\\\\server\\share\\evil.shp",
            "..\\evil.shp",
            "C:/windows/evil.shp",
        ],
    )
    def test_rejects_path_traversal_entries(self, tmp_path: Path, name: str) -> None:
        path = make_zip(tmp_path / "traversal.zip", {name: b"x"})
        with pytest.raises(ValueError, match="パストラバーサル"):
            inspect_zip_archive(path, max_entries=100, max_total_bytes=1024)


class TestRunOgr2ogrCommand:
    def test_password_stays_out_of_argv_and_driver_is_pinned(self, monkeypatch: pytest.MonkeyPatch) -> None:
        # DB パスワードはプロセス引数 (ps で他プロセスから可視) に乗せず、
        # サブプロセスの PGPASSWORD 環境変数でのみ渡す。入力ドライバは -if で明示する
        from src.worker import run_ogr2ogr

        monkeypatch.setenv("PGPASSWORD", "s3cr3t-value")
        captured: dict[str, object] = {}

        def fake_run(command: list[str], **kwargs: object) -> object:
            captured["command"] = command
            captured["env"] = kwargs.get("env")
            return type("R", (), {"returncode": 0, "stderr": "", "stdout": ""})()

        monkeypatch.setattr("src.worker.subprocess", type("S", (), {"run": staticmethod(fake_run)}))
        run_ogr2ogr("/tmp/a.geojson", "layer_x", 4326, "GeoJSON")

        command = captured["command"]
        assert isinstance(command, list)
        assert all("s3cr3t-value" not in arg for arg in command), "パスワードが引数に漏れている"
        assert all("password" not in arg for arg in command), "接続文字列に password キーを含めない"
        index = command.index("-if")
        assert command[index + 1] == "GeoJSON"
        env = captured["env"]
        assert isinstance(env, dict)
        assert env["PGPASSWORD"] == "s3cr3t-value"
        assert env["PG_USE_COPY"] == "YES"


class TestZipLimits:
    def test_defaults(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.delenv("IMPORT_ZIP_MAX_ENTRIES", raising=False)
        monkeypatch.delenv("IMPORT_ZIP_MAX_TOTAL_BYTES", raising=False)
        assert zip_limits() == (DEFAULT_ZIP_MAX_ENTRIES, DEFAULT_ZIP_MAX_TOTAL_BYTES)
        assert DEFAULT_ZIP_MAX_ENTRIES == 100
        assert DEFAULT_ZIP_MAX_TOTAL_BYTES == 2 * 1024**3

    def test_env_overrides(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("IMPORT_ZIP_MAX_ENTRIES", "7")
        monkeypatch.setenv("IMPORT_ZIP_MAX_TOTAL_BYTES", "12345")
        assert zip_limits() == (7, 12345)


class TestNormalizeLayerRole:
    def test_defaults_to_generic(self) -> None:
        assert normalize_layer_role(None) == "generic"
        assert normalize_layer_role("  ") == "generic"

    def test_accepts_known_roles_case_insensitively(self) -> None:
        assert normalize_layer_role("Zone") == "zone"

    def test_rejects_unknown_role(self) -> None:
        with pytest.raises(ValueError):
            normalize_layer_role("admin")


class TestJsonLinesLogging:
    def _record(self, **extra: str) -> logging.LogRecord:
        record = logging.LogRecord(
            name="worker-gis",
            level=logging.INFO,
            pathname=__file__,
            lineno=1,
            msg="Import job %s succeeded",
            args=("job-1",),
            exc_info=None,
        )
        for key, value in extra.items():
            setattr(record, key, value)
        return record

    def test_emits_structured_fields_and_extras(self) -> None:
        line = JsonLinesFormatter().format(self._record(job_id="job-1"))
        payload = json.loads(line)
        assert payload["level"] == "INFO"
        assert payload["logger_name"] == "worker-gis"
        assert payload["message"] == "Import job job-1 succeeded"
        assert payload["job_id"] == "job-1"
        assert payload["@timestamp"].endswith("+00:00")

    def test_includes_stack_trace_on_exception(self) -> None:
        try:
            raise RuntimeError("simulated failure")
        except RuntimeError:
            import sys

            record = self._record()
            record.exc_info = sys.exc_info()
        payload = json.loads(JsonLinesFormatter().format(record))
        assert "simulated failure" in payload["stack_trace"]

    def test_rejects_unknown_log_format(self, monkeypatch: pytest.MonkeyPatch) -> None:
        # 不正値で黙って text に落とすと本番で構造化クエリが静かに壊れるため fail fast
        monkeypatch.setenv("LOG_FORMAT", "yaml")
        with pytest.raises(RuntimeError):
            configure_logging()
