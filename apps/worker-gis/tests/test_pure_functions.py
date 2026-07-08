# worker の純粋関数に対する Level 1 (決定的) テスト。
# DB / GDAL 不要で実行できるものだけをここに置く
import json
import logging
from pathlib import Path

import pytest

from src.worker import (
    JsonLinesFormatter,
    configure_logging,
    fetch_upload,
    is_s3_uri,
    make_table_name,
    normalize_layer_role,
    ogr_source,
    parse_s3_uri,
    qtable,
    quote_ident,
)


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
