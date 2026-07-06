# worker の純粋関数に対する Level 1 (決定的) テスト。
# DB / GDAL 不要で実行できるものだけをここに置く
import pytest

from src.worker import make_table_name, normalize_layer_role, ogr_source, qtable, quote_ident


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


class TestNormalizeLayerRole:
    def test_defaults_to_generic(self) -> None:
        assert normalize_layer_role(None) == "generic"
        assert normalize_layer_role("  ") == "generic"

    def test_accepts_known_roles_case_insensitively(self) -> None:
        assert normalize_layer_role("Zone") == "zone"

    def test_rejects_unknown_role(self) -> None:
        with pytest.raises(ValueError):
            normalize_layer_role("admin")
