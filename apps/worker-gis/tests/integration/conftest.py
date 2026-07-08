# 統合テスト共通フィクスチャ (pytest -m integration)。
# 実行には PG* 環境変数で接続できる PostGIS と ogr2ogr が必要。
# fail-closed: 前提が無ければスキップではなく失敗する
import shutil
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest

from src.worker import connect

REPO_ROOT = Path(__file__).resolve().parents[4]
# テーブル DDL の SSoT は api 側の Flyway マイグレーション (docs/db-migrations.md)。
# worker のテストは同じ V*.sql をバージョン順に適用してスキーマを作る
MIGRATIONS_DIR = REPO_ROOT / "apps" / "api" / "src" / "main" / "resources" / "db" / "migration"


def _migration_version(path: Path) -> tuple[int, ...]:
    # "V12__name.sql" -> (12,) / "V1_2__name.sql" -> (1, 2) (Flyway と同じ数値順)
    version = path.name[1:].split("__", 1)[0]
    return tuple(int(part) for part in version.replace("_", ".").split("."))


def _apply_migrations(connection: Any) -> None:
    files = sorted(MIGRATIONS_DIR.glob("V*.sql"), key=_migration_version)
    assert files, f"マイグレーションが見つかりません: {MIGRATIONS_DIR}"
    for sql_file in files:
        with connection.transaction():
            connection.execute(sql_file.read_text())


@pytest.fixture(scope="module")
def conn() -> Iterator[Any]:
    assert shutil.which("ogr2ogr"), "ogr2ogr が必要です (fail-closed: apt install gdal-bin)"
    connection = connect()
    # スキーマを作り直して決定的な状態から始める
    with connection.transaction():
        connection.execute("DROP SCHEMA IF EXISTS app CASCADE")
        connection.execute("DROP SCHEMA IF EXISTS gis_data CASCADE")
    init_sql = (REPO_ROOT / "infra" / "postgres" / "init.sql").read_text()
    with connection.transaction():
        connection.execute(init_sql)
    # init.sql は拡張・スキーマ作成のみ。テーブル定義は Flyway の V*.sql が持つ
    _apply_migrations(connection)
    yield connection
    connection.close()
