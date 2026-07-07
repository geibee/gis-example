from __future__ import annotations

import json
import os
import re
import subprocess
import time
import traceback
from pathlib import Path
from typing import Any

import psycopg
from psycopg.rows import DictRow, dict_row


def main() -> None:
    poll_interval = float(os.getenv("POLL_INTERVAL_SECONDS", "2"))
    print("GIS worker started", flush=True)
    while True:
        did_work = False
        try:
            with connect() as conn:
                import_job = claim_import_job(conn)
                if import_job is not None:
                    did_work = True
                    run_import_job(conn, import_job)
        except Exception:
            traceback.print_exc()

        if not did_work:
            time.sleep(poll_interval)


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


def claim_import_job(conn: psycopg.Connection[DictRow]) -> dict[str, Any] | None:
    with conn.transaction():
        row = conn.execute(
            """
            UPDATE app.import_jobs
            SET status = 'running', started_at = now(), error_message = NULL
            WHERE id = (
                SELECT id
                FROM app.import_jobs
                WHERE status = 'pending'
                ORDER BY created_at
                FOR UPDATE SKIP LOCKED
                LIMIT 1
            )
            RETURNING id::text, project_id::text, filename, format, source_srid, upload_path, layer_role
            """
        ).fetchone()
    return row


def run_import_job(conn: psycopg.Connection[DictRow], job: dict[str, Any]) -> None:
    try:
        table_name = make_table_name(job["filename"], job["id"])
        source_srid = int(job["source_srid"] or 4326)
        source = ogr_source(job["upload_path"], job["format"])

        run_ogr2ogr(source, table_name, source_srid)

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
        print(f"Import job {job['id']} succeeded as layer {layer_id}", flush=True)
    except Exception as exc:
        mark_import_failed(conn, job["id"], exc)


def run_ogr2ogr(source: str, table_name: str, source_srid: int) -> None:
    pg_conn = (
        f"PG:host={os.getenv('PGHOST', 'localhost')} "
        f"port={os.getenv('PGPORT', '5432')} "
        f"dbname={os.getenv('PGDATABASE', 'gis')} "
        f"user={os.getenv('PGUSER', 'gis')} "
        f"password={require_pgpassword()}"
    )
    command = [
        "ogr2ogr",
        "-overwrite",
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
    print(f"Import job {job_id} failed: {message}", flush=True)


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
