from __future__ import annotations

import json
import os
import re
import subprocess
import time
import traceback
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from uuid import uuid4

import psycopg
from psycopg.rows import dict_row


ALLOWED_ATTRIBUTE_OPERATORS = {"=", "!=", "<", "<=", ">", ">=", "LIKE", "IN", "IS NULL"}
ALLOWED_SPATIAL_OPERATORS = {"intersects", "contains", "within", "dwithin"}


@dataclass(frozen=True)
class LayerMeta:
    id: str
    project_id: str
    name: str
    schema_name: str
    table_name: str
    geometry_column: str
    geometry_type: str
    feature_id_column: str
    attributes: set[str]


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

                analysis_job = claim_analysis_job(conn)
                if analysis_job is not None:
                    did_work = True
                    run_analysis_job(conn, analysis_job)
        except Exception:
            traceback.print_exc()

        if not did_work:
            time.sleep(poll_interval)


def connect() -> psycopg.Connection:
    return psycopg.connect(
        host=os.getenv("PGHOST", "localhost"),
        port=int(os.getenv("PGPORT", "5432")),
        dbname=os.getenv("PGDATABASE", "gis"),
        user=os.getenv("PGUSER", "gis"),
        password=os.getenv("PGPASSWORD", "gis"),
        row_factory=dict_row,
    )


def claim_import_job(conn: psycopg.Connection) -> dict[str, Any] | None:
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
            RETURNING id::text, project_id::text, filename, format, source_srid, upload_path
            """
        ).fetchone()
    return row


def claim_analysis_job(conn: psycopg.Connection) -> dict[str, Any] | None:
    with conn.transaction():
        row = conn.execute(
            """
            UPDATE app.analysis_jobs
            SET status = 'running', started_at = now(), error_message = NULL
            WHERE id = (
                SELECT id
                FROM app.analysis_jobs
                WHERE status = 'pending'
                ORDER BY created_at
                FOR UPDATE SKIP LOCKED
                LIMIT 1
            )
            RETURNING id::text, project_id::text, name, criteria
            """
        ).fetchone()
    return row


def run_import_job(conn: psycopg.Connection, job: dict[str, Any]) -> None:
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
            )
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
        f"password={os.getenv('PGPASSWORD', 'gis')}"
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


def normalize_imported_table(conn: psycopg.Connection, table_name: str) -> None:
    table_ref = qtable("gis_data", table_name)
    index_name = quote_ident(f"{table_name[:48]}_geom_gix")
    conn.execute(f"UPDATE {table_ref} SET geom = ST_MakeValid(geom) WHERE geom IS NOT NULL AND NOT ST_IsValid(geom)")
    conn.execute(f"DELETE FROM {table_ref} WHERE geom IS NULL")
    conn.execute(f"CREATE INDEX IF NOT EXISTS {index_name} ON {table_ref} USING GIST ({quote_ident('geom')})")
    conn.execute(f"ANALYZE {table_ref}")


def insert_layer_metadata(
    conn: psycopg.Connection,
    project_id: str,
    name: str,
    table_name: str,
    source_srid: int | None,
    is_result: bool,
) -> str:
    stats = table_stats(conn, table_name)
    layer_id = conn.execute(
        """
        INSERT INTO app.layers (
            project_id, name, schema_name, table_name, geometry_column, geometry_type,
            source_srid, display_srid, feature_id_column, bbox_4326, row_count,
            is_result, tile_source_id
        )
        VALUES (%s::uuid, %s, 'gis_data', %s, 'geom', %s, %s, 3857, 'fid', %s::jsonb, %s, %s, %s)
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
            table_name,
        ),
    ).fetchone()["id"]
    insert_layer_attributes(conn, layer_id, table_name)
    return layer_id


def table_stats(conn: psycopg.Connection, table_name: str) -> dict[str, Any]:
    table_ref = qtable("gis_data", table_name)
    row = conn.execute(
        f"""
        WITH stats AS (
            SELECT
                count(*)::bigint AS row_count,
                (array_agg(GeometryType(geom) ORDER BY GeometryType(geom)) FILTER (WHERE geom IS NOT NULL))[1] AS geometry_type,
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
    return {
        "row_count": row["row_count"],
        "geometry_type": row["geometry_type"],
        "bbox": row["bbox"],
    }


def insert_layer_attributes(conn: psycopg.Connection, layer_id: str, table_name: str) -> None:
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


def run_analysis_job(conn: psycopg.Connection, job: dict[str, Any]) -> None:
    try:
        criteria = job["criteria"]
        if isinstance(criteria, str):
            criteria = json.loads(criteria)

        with conn.transaction():
            result_table = f"result_{job['id'].replace('-', '')[:24]}"
            result_layer_id, count = execute_analysis(conn, job, criteria, result_table)
            conn.execute(
                """
                UPDATE app.analysis_jobs
                SET status = 'succeeded',
                    result_layer_id = %s::uuid,
                    result_count = %s,
                    finished_at = now()
                WHERE id = %s::uuid
                """,
                (result_layer_id, count, job["id"]),
            )
        print(f"Analysis job {job['id']} succeeded as layer {result_layer_id}", flush=True)
    except Exception as exc:
        mark_analysis_failed(conn, job["id"], exc)


def execute_analysis(
    conn: psycopg.Connection,
    job: dict[str, Any],
    criteria: dict[str, Any],
    result_table: str,
) -> tuple[str, int]:
    project_id = criteria.get("projectId") or job["project_id"]
    target = load_layer(conn, criteria["targetLayerId"])
    if target.project_id != project_id:
        raise ValueError("Target layer does not belong to analysis project")

    referenced_ids = {target.id}
    referenced_ids.update(cond["layerId"] for cond in criteria.get("attributeConditions", []))
    referenced_ids.update(cond["layerId"] for cond in criteria.get("spatialConditions", []))
    layers = {layer_id: load_layer(conn, layer_id) for layer_id in referenced_ids}
    for layer in layers.values():
        if layer.project_id != project_id:
            raise ValueError(f"Layer {layer.id} does not belong to analysis project")

    validate_analysis_criteria(target, layers, criteria)
    where_sql, params = build_where_clause(target, layers, criteria)

    result_ref = qtable("gis_data", result_table)
    target_ref = qtable(target.schema_name, target.table_name)
    conn.execute(f"DROP TABLE IF EXISTS {result_ref}")
    conn.execute(
        f"""
        CREATE TABLE {result_ref} AS
        SELECT t.*
        FROM {target_ref} AS t
        WHERE {where_sql}
        """,
        params,
    )
    normalize_imported_table(conn, result_table)
    count = conn.execute(f"SELECT count(*)::int AS count FROM {result_ref}").fetchone()["count"]
    layer_id = insert_layer_metadata(
        conn=conn,
        project_id=project_id,
        name=job["name"],
        table_name=result_table,
        source_srid=3857,
        is_result=True,
    )
    return layer_id, count


def validate_analysis_criteria(target: LayerMeta, layers: dict[str, LayerMeta], criteria: dict[str, Any]) -> None:
    for condition in criteria.get("attributeConditions", []):
        layer = layers[condition["layerId"]]
        operator = condition["operator"].upper()
        if operator not in ALLOWED_ATTRIBUTE_OPERATORS:
            raise ValueError(f"Unsupported attribute operator: {condition['operator']}")
        if condition["field"] not in layer.attributes:
            raise ValueError(f"Unknown attribute {condition['field']} for layer {layer.name}")
        if operator == "IN" and not condition.get("values"):
            raise ValueError("IN operator requires values")
        if operator not in {"IN", "IS NULL"} and "value" not in condition:
            raise ValueError(f"{operator} operator requires value")

    for condition in criteria.get("spatialConditions", []):
        operator = condition["operator"].lower()
        if operator not in ALLOWED_SPATIAL_OPERATORS:
            raise ValueError(f"Unsupported spatial operator: {condition['operator']}")
        if condition["layerId"] == target.id:
            raise ValueError("Spatial condition layer must differ from target layer")
        if operator == "dwithin" and float(condition.get("distanceMeters") or 0) <= 0:
            raise ValueError("dwithin requires positive distanceMeters")


def build_where_clause(
    target: LayerMeta,
    layers: dict[str, LayerMeta],
    criteria: dict[str, Any],
) -> tuple[str, list[Any]]:
    clauses: list[str] = []
    params: list[Any] = []

    attribute_conditions = criteria.get("attributeConditions", [])
    spatial_conditions = criteria.get("spatialConditions", [])

    for condition in attribute_conditions:
        if condition["layerId"] == target.id:
            clauses.append(attribute_predicate("t", condition, params))

    non_target_layer_ids = {
        cond["layerId"] for cond in attribute_conditions if cond["layerId"] != target.id
    } | {cond["layerId"] for cond in spatial_conditions}

    for layer_id in sorted(non_target_layer_ids):
        layer = layers[layer_id]
        inner_clauses: list[str] = []
        for spatial in [cond for cond in spatial_conditions if cond["layerId"] == layer_id]:
            inner_clauses.append(spatial_predicate(target, layer, spatial, params))
        for attr in [cond for cond in attribute_conditions if cond["layerId"] == layer_id]:
            inner_clauses.append(attribute_predicate("o", attr, params))
        if not inner_clauses:
            inner_clauses.append("TRUE")
        clauses.append(
            "EXISTS ("
            f"SELECT 1 FROM {qtable(layer.schema_name, layer.table_name)} AS o "
            f"WHERE {' AND '.join(inner_clauses)}"
            ")"
        )

    return (" AND ".join(clauses) if clauses else "TRUE"), params


def attribute_predicate(alias: str, condition: dict[str, Any], params: list[Any]) -> str:
    column = f"{alias}.{quote_ident(condition['field'])}"
    operator = condition["operator"].upper()
    if operator == "!=":
        operator = "<>"
    if operator == "IS NULL":
        return f"{column} IS NULL"
    if operator == "LIKE":
        params.append(str(condition["value"]))
        return f"{column}::text LIKE %s"
    if operator == "IN":
        params.append([str(value) for value in condition["values"]])
        return f"{column}::text = ANY(%s)"
    params.append(condition["value"])
    return f"{column} {operator} %s"


def spatial_predicate(
    target: LayerMeta,
    other: LayerMeta,
    condition: dict[str, Any],
    params: list[Any],
) -> str:
    left = f"t.{quote_ident(target.geometry_column)}"
    right = f"o.{quote_ident(other.geometry_column)}"
    operator = condition["operator"].lower()
    if operator == "intersects":
        return f"ST_Intersects({left}, {right})"
    if operator == "contains":
        return f"ST_Contains({left}, {right})"
    if operator == "within":
        return f"ST_Within({left}, {right})"
    if operator == "dwithin":
        params.append(float(condition["distanceMeters"]))
        return f"ST_DWithin({left}, {right}, %s)"
    raise ValueError(f"Unsupported spatial operator: {condition['operator']}")


def load_layer(conn: psycopg.Connection, layer_id: str) -> LayerMeta:
    row = conn.execute(
        """
        SELECT id::text, project_id::text, name, schema_name, table_name,
               geometry_column, geometry_type, feature_id_column
        FROM app.layers
        WHERE id = %s::uuid
        """,
        (layer_id,),
    ).fetchone()
    if row is None:
        raise ValueError(f"Layer not found: {layer_id}")

    attrs = {
        attr["name"]
        for attr in conn.execute(
            """
            SELECT name
            FROM app.layer_attributes
            WHERE layer_id = %s::uuid AND is_geometry = false
            """,
            (layer_id,),
        ).fetchall()
    }
    return LayerMeta(
        id=row["id"],
        project_id=row["project_id"],
        name=row["name"],
        schema_name=row["schema_name"],
        table_name=row["table_name"],
        geometry_column=row["geometry_column"],
        geometry_type=row["geometry_type"],
        feature_id_column=row["feature_id_column"],
        attributes=attrs,
    )


def mark_import_failed(conn: psycopg.Connection, job_id: str, exc: Exception) -> None:
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


def mark_analysis_failed(conn: psycopg.Connection, job_id: str, exc: Exception) -> None:
    message = str(exc)[:4000]
    with conn.transaction():
        conn.execute(
            """
            UPDATE app.analysis_jobs
            SET status = 'failed', error_message = %s, finished_at = now()
            WHERE id = %s::uuid
            """,
            (message, job_id),
        )
    print(f"Analysis job {job_id} failed: {message}", flush=True)


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


if __name__ == "__main__":
    main()
