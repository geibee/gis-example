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
    layer_role: str
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
            RETURNING id::text, project_id::text, filename, format, source_srid, upload_path, layer_role
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
    layer_role: str = "generic",
    result_set_id: str | None = None,
    source_layer_id: str | None = None,
) -> str:
    stats = table_stats(conn, table_name)
    layer_id = conn.execute(
        """
        INSERT INTO app.layers (
            project_id, name, schema_name, table_name, geometry_column, geometry_type,
            source_srid, display_srid, feature_id_column, bbox_4326, row_count,
            is_result, layer_role, result_set_id, source_layer_id, tile_source_id
        )
        VALUES (%s::uuid, %s, 'gis_data', %s, 'geom', %s, %s, 3857, 'fid', %s::jsonb, %s, %s, %s, %s::uuid, %s::uuid, %s)
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
    ).fetchone()["id"]
    insert_layer_attributes(conn, layer_id, table_name)
    return layer_id


def sync_zones_for_layer(conn: psycopg.Connection, layer_id: str, project_id: str, table_name: str) -> None:
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
            concat('Z-', replace(%s::text, '-', ''), '-', t.{quote_ident('fid')}::text) AS id,
            %s::uuid AS project_id,
            COALESCE({name_expr}, concat('区域 ', t.{quote_ident('fid')}::text)) AS name,
            NULL::text AS zone_type,
            '有効'::text AS status,
            NULL::text AS memo,
            %s::uuid AS zone_layer_id,
            t.{quote_ident('fid')}::text AS zone_feature_id,
            %s::uuid AS source_layer_id,
            t.{quote_ident('fid')}::text AS source_feature_id
        FROM {table_ref} AS t
        WHERE t.{quote_ident('geom')} IS NOT NULL
          AND GeometryType(t.{quote_ident('geom')}) ILIKE '%%POLYGON%%'
        ON CONFLICT (zone_layer_id, zone_feature_id) DO UPDATE
        SET name = EXCLUDED.name,
            source_layer_id = EXCLUDED.source_layer_id,
            source_feature_id = EXCLUDED.source_feature_id,
            updated_at = now()
        """,
        (layer_id, project_id, layer_id, layer_id),
    )


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
            result_layer_id, result_set_id, count = execute_analysis(conn, job, criteria, result_table)
            conn.execute(
                """
                UPDATE app.analysis_jobs
                SET status = 'succeeded',
                    result_layer_id = %s::uuid,
                    result_set_id = %s::uuid,
                    result_count = %s,
                    finished_at = now()
                WHERE id = %s::uuid
                """,
                (result_layer_id, result_set_id, count, job["id"]),
            )
        print(f"Analysis job {job['id']} succeeded as layer {result_layer_id}", flush=True)
    except Exception as exc:
        mark_analysis_failed(conn, job["id"], exc)


def execute_analysis(
    conn: psycopg.Connection,
    job: dict[str, Any],
    criteria: dict[str, Any],
    result_table: str,
) -> tuple[str | None, str | None, int]:
    project_id = criteria.get("projectId") or job["project_id"]

    operation = (criteria.get("operation") or "and_filter").lower()
    if operation == "condition_search":
        return execute_condition_search_analysis(conn, job, criteria, result_table, project_id)

    target = load_layer(conn, criteria["targetLayerId"])
    if target.project_id != project_id:
        raise ValueError("Target layer does not belong to analysis project")

    if operation != "and_filter":
        raise ValueError(f"Unsupported analysis operation: {criteria.get('operation')}")

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
    return layer_id, None, count


def execute_condition_search_analysis(
    conn: psycopg.Connection,
    job: dict[str, Any],
    criteria: dict[str, Any],
    result_table: str,
    project_id: str,
) -> tuple[str | None, str | None, int]:
    condition_query = criteria.get("conditionQuery") or {}
    query_project_id = condition_query.get("projectId") or project_id
    if query_project_id != project_id:
        raise ValueError("Condition query project does not match analysis project")

    target_layer_ids = [
        layer_id
        for layer_id in dict.fromkeys(str(value).strip() for value in condition_query.get("targetLayerIds", []))
        if layer_id
    ]
    if not target_layer_ids:
        raise ValueError("conditionQuery.targetLayerIds is required")

    targets = [load_layer(conn, layer_id) for layer_id in target_layer_ids]
    for target in targets:
        if target.project_id != project_id:
            raise ValueError(f"Layer {target.id} does not belong to analysis project")

    referenced_ids = set(target_layer_ids)
    for condition in condition_query.get("conditions", []):
        layer_id = condition.get("layerId")
        if layer_id:
            referenced_ids.add(layer_id)
    layers = {layer_id: load_layer(conn, layer_id) for layer_id in referenced_ids}
    for layer in layers.values():
        if layer.project_id != project_id:
            raise ValueError(f"Layer {layer.id} does not belong to analysis project")

    source_layers = list_layers_for_project(conn, project_id)
    result_set_id = insert_result_set(conn, project_id, job["name"], condition_query)
    summary = condition_search_summary(condition_query)
    empty_business_links = json.dumps({"lands": [], "buildings": []}, ensure_ascii=False)

    representative_layer_id: str | None = None
    total_count = 0
    for index, target in enumerate(targets, start=1):
        child_table = f"{result_table}_{index:02d}"
        result_ref = qtable("gis_data", child_table)
        target_ref = qtable(target.schema_name, target.table_name)
        where_sql, params = build_condition_search_where_clause(target, layers, source_layers, project_id, condition_query)
        source_columns = selectable_source_columns(conn, target)
        source_select = ",\n            ".join(f"t.{quote_ident(column)}" for column in source_columns)

        conn.execute(f"DROP TABLE IF EXISTS {result_ref}")
        conn.execute(
            f"""
            CREATE TABLE {result_ref} AS
            SELECT
                {source_select},
                %s::uuid AS source_layer_id,
                t.{quote_ident(target.feature_id_column)}::text AS source_feature_id,
                %s::text AS matched_condition_summary,
                %s::jsonb AS matched_business_links
            FROM {target_ref} AS t
            WHERE {where_sql}
            """,
            [target.id, summary, empty_business_links, *params],
        )
        normalize_imported_table(conn, child_table)
        count = conn.execute(f"SELECT count(*)::int AS count FROM {result_ref}").fetchone()["count"]
        total_count += count
        layer_id = insert_layer_metadata(
            conn=conn,
            project_id=project_id,
            name=f"{target.name} {count}件",
            table_name=child_table,
            source_srid=3857,
            is_result=True,
            result_set_id=result_set_id,
            source_layer_id=target.id,
        )
        if representative_layer_id is None:
            representative_layer_id = layer_id

    return representative_layer_id, result_set_id, total_count


def insert_result_set(
    conn: psycopg.Connection,
    project_id: str,
    name: str,
    condition_query: dict[str, Any],
) -> str:
    return conn.execute(
        """
        INSERT INTO app.result_sets (project_id, name, criteria)
        VALUES (%s::uuid, %s, %s::jsonb)
        RETURNING id::text
        """,
        (project_id, name, json.dumps(condition_query, ensure_ascii=False)),
    ).fetchone()["id"]


def selectable_source_columns(conn: psycopg.Connection, layer: LayerMeta) -> list[str]:
    metadata_columns = {"source_layer_id", "source_feature_id", "matched_condition_summary", "matched_business_links"}
    rows = conn.execute(
        """
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = %s AND table_name = %s
        ORDER BY ordinal_position
        """,
        (layer.schema_name, layer.table_name),
    ).fetchall()
    columns = [row["column_name"] for row in rows if row["column_name"] not in metadata_columns]
    if not columns:
        raise ValueError(f"Layer {layer.id} has no selectable columns")
    return columns


def build_condition_search_where_clause(
    target: LayerMeta,
    layers: dict[str, LayerMeta],
    source_layers: list[LayerMeta],
    project_id: str,
    condition_query: dict[str, Any],
) -> tuple[str, list[Any]]:
    clauses: list[str] = []
    params: list[Any] = []
    keyword = str(condition_query.get("keyword") or "").strip()
    if keyword:
        clauses.append(
            "("
            f"t.{quote_ident(target.feature_id_column)}::text ILIKE %s "
            f"OR (to_jsonb(t) - %s)::text ILIKE %s"
            ")"
        )
        params.extend([f"%{keyword}%", target.geometry_column, f"%{keyword}%"])

    conditions = condition_query.get("conditions", [])
    attribute_conditions = [condition for condition in conditions if str(condition.get("type", "")).lower() == "attribute"]
    spatial_conditions = [condition for condition in conditions if str(condition.get("type", "")).lower() == "spatial"]
    business_conditions = [condition for condition in conditions if str(condition.get("type", "")).lower() == "business"]

    for condition in attribute_conditions:
        layer_id = condition_layer_id(condition)
        if layer_id is None or layer_id == target.id:
            clauses.append(condition_attribute_predicate("t", target, condition, params))

    non_target_layer_ids = {
        layer_id
        for layer_id in [
            condition_layer_id(condition)
            for condition in [
                *attribute_conditions,
                *[condition for condition in spatial_conditions if spatial_comparison_target(condition) == "layer"],
            ]
        ]
        if layer_id and layer_id != target.id
    }
    for layer_id in sorted(non_target_layer_ids):
        layer = layers[layer_id]
        inner_clauses: list[str] = []
        for condition in [condition for condition in attribute_conditions if condition_layer_id(condition) == layer_id]:
            inner_clauses.append(condition_attribute_predicate("o", layer, condition, params))
        for condition in [condition for condition in spatial_conditions if condition_layer_id(condition) == layer_id]:
            inner_clauses.append(
                spatial_condition_predicate(
                    f"t.{quote_ident(target.geometry_column)}",
                    f"o.{quote_ident(layer.geometry_column)}",
                    str(condition.get("spatialOperator") or condition.get("operator") or "intersects"),
                    params,
                    condition.get("distanceMeters"),
                )
            )
        if not inner_clauses:
            inner_clauses.append("TRUE")
        clauses.append(
            "EXISTS ("
            f"SELECT 1 FROM {qtable(layer.schema_name, layer.table_name)} AS o "
            f"WHERE {' AND '.join(inner_clauses)}"
            ")"
        )

    business_spatial_conditions = [
        condition for condition in spatial_conditions if spatial_comparison_target(condition) == "business"
    ]
    if not business_spatial_conditions:
        for condition in business_conditions:
            business_sql, business_params = business_link_predicate_sql(target, project_id, condition)
            clauses.append(business_sql)
            params.extend(business_params)

    for condition in business_spatial_conditions:
        business_filter = merged_business_condition(business_conditions)
        source_types = business_source_types(business_filter)
        business_sql, business_params = business_geometry_sql(source_layers, project_id, source_types, business_filter or {})
        if not business_sql:
            clauses.append("FALSE")
            continue
        params.extend(business_params)
        spatial_params: list[Any] = []
        spatial_sql = spatial_condition_predicate(
            f"t.{quote_ident(target.geometry_column)}",
            "bg.geom",
            str(condition.get("spatialOperator") or condition.get("operator") or "intersects"),
            spatial_params,
            condition.get("distanceMeters"),
        )
        params.extend(spatial_params)
        clauses.append(
            "EXISTS ("
            f"SELECT 1 FROM ({business_sql}) AS bg "
            f"WHERE {spatial_sql}"
            ")"
        )

    return (" AND ".join(clauses) if clauses else "TRUE"), params


def condition_layer_id(condition: dict[str, Any]) -> str | None:
    value = condition.get("layerId")
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def spatial_comparison_target(condition: dict[str, Any]) -> str:
    value = str(condition.get("comparisonTarget") or "").strip().lower()
    if value:
        return value
    return "business" if str(condition.get("type", "")).lower() == "spatial" and condition_layer_id(condition) is None else "layer"


def merged_business_condition(conditions: list[dict[str, Any]]) -> dict[str, Any] | None:
    return conditions[0] if conditions else None


def business_source_types(condition: dict[str, Any] | None) -> set[str]:
    source_types = {
        str(value).strip().lower()
        for value in ((condition or {}).get("sourceTypes") or ["land", "building"])
        if str(value).strip()
    } or {"land", "building"}
    invalid_source_types = source_types - {"land", "building"}
    if invalid_source_types:
        raise ValueError(f"Unsupported business source type(s): {', '.join(sorted(invalid_source_types))}")
    return source_types


def business_link_predicate_sql(
    target: LayerMeta,
    project_id: str,
    condition: dict[str, Any],
) -> tuple[str, list[Any]]:
    source_types = business_source_types(condition)
    clauses: list[str] = []
    params: list[Any] = []
    feature_id_ref = f"t.{quote_ident(target.feature_id_column)}"
    if "land" in source_types:
        filters = [
            "l.project_id = %s::uuid",
            "l.source_layer_id = %s::uuid",
            f"l.source_feature_id = {feature_id_ref}::text",
        ]
        land_params: list[Any] = [project_id, target.id]
        add_business_query_filter(
            condition.get("businessQuery"),
            "concat_ws(' ', l.id, l.lot_number, l.address, l.land_use, l.status, l.memo)",
            filters,
            land_params,
        )
        add_party_relationship_filter("land", "l.id", "l.project_id", condition, filters, land_params)
        clauses.append(f"EXISTS (SELECT 1 FROM app.lands AS l WHERE {' AND '.join(filters)})")
        params.extend(land_params)
    if "building" in source_types:
        filters = [
            "b.project_id = %s::uuid",
            "b.source_layer_id = %s::uuid",
            f"b.source_feature_id = {feature_id_ref}::text",
        ]
        building_params: list[Any] = [project_id, target.id]
        add_business_query_filter(
            condition.get("businessQuery"),
            "concat_ws(' ', b.id, b.name, b.building_use, b.structure, b.status, b.memo, l.lot_number, l.address)",
            filters,
            building_params,
        )
        add_party_relationship_filter("building", "b.id", "b.project_id", condition, filters, building_params)
        clauses.append(
            "EXISTS ("
            "SELECT 1 FROM app.buildings AS b "
            "LEFT JOIN app.lands AS l ON l.id = b.land_id "
            f"WHERE {' AND '.join(filters)}"
            ")"
        )
        params.extend(building_params)
    return (f"({' OR '.join(clauses)})" if clauses else "FALSE"), params


def condition_attribute_predicate(alias: str, layer: LayerMeta, condition: dict[str, Any], params: list[Any]) -> str:
    field = str(condition.get("field") or "").strip()
    if not field:
        raise ValueError("Attribute condition field is required")
    if field not in layer.attributes:
        raise ValueError(f"Unknown attribute {field} for layer {layer.name}")
    column = f"{alias}.{quote_ident(field)}"
    operator = str(condition.get("operator") or "=").upper()
    if operator == "!=":
        operator = "<>"
    if operator == "IS NULL":
        return f"{column} IS NULL"
    if operator == "LIKE":
        params.append(f"%{condition_value_text(condition)}%")
        return f"{column}::text ILIKE %s"
    if operator == "IN":
        values = [str(value).strip() for value in condition.get("values") or [] if str(value).strip()]
        if not values:
            raise ValueError("IN operator requires values")
        params.append(values)
        return f"{column}::text = ANY(%s)"
    if operator not in {"=", "<>", "<", "<=", ">", ">="}:
        raise ValueError(f"Unsupported attribute operator: {condition.get('operator')}")
    params.append(condition_value_text(condition))
    return f"{column}::text {operator} %s"


def condition_value_text(condition: dict[str, Any]) -> str:
    value = condition.get("value")
    if value is None:
        raise ValueError(f"{condition.get('operator') or '='} operator requires value")
    text = str(value).strip()
    if not text:
        raise ValueError(f"{condition.get('operator') or '='} operator requires value")
    return text


def spatial_condition_predicate(
    left: str,
    right: str,
    operator: str,
    params: list[Any],
    distance_meters: Any,
) -> str:
    normalized = operator.lower()
    if normalized == "contains":
        return f"{left} && {right} AND ST_Contains({left}, {right})"
    if normalized == "within":
        return f"{left} && {right} AND ST_Within({left}, {right})"
    if normalized == "dwithin":
        distance = float(distance_meters or 0)
        if distance <= 0:
            raise ValueError("dwithin requires positive distanceMeters")
        params.append(distance)
        return f"ST_DWithin({left}, {right}, %s)"
    if normalized != "intersects":
        raise ValueError(f"Unsupported spatial operator: {operator}")
    return f"{left} && {right} AND ST_Intersects({left}, {right})"


def business_geometry_sql(
    source_layers: list[LayerMeta],
    project_id: str,
    source_types: set[str],
    condition: dict[str, Any],
) -> tuple[str, list[Any]]:
    selects: list[str] = []
    params: list[Any] = []
    for source_layer in source_layers:
        table_ref = qtable(source_layer.schema_name, source_layer.table_name)
        feature_id_ref = f"src.{quote_ident(source_layer.feature_id_column)}"
        geometry_ref = f"src.{quote_ident(source_layer.geometry_column)}"
        if "land" in source_types:
            filters = [
                "l.project_id = %s::uuid",
                "l.source_layer_id = %s::uuid",
                "l.source_feature_id IS NOT NULL",
                f"{geometry_ref} IS NOT NULL",
            ]
            land_params: list[Any] = [project_id, source_layer.id]
            add_business_query_filter(
                condition.get("businessQuery"),
                "concat_ws(' ', l.id, l.lot_number, l.address, l.land_use, l.status, l.memo)",
                filters,
                land_params,
            )
            add_party_relationship_filter("land", "l.id", "l.project_id", condition, filters, land_params)
            selects.append(
                f"""
                SELECT
                    'land' AS business_type,
                    l.id AS business_id,
                    concat(l.lot_number, ' · ', l.address) AS business_label,
                    {geometry_ref} AS geom
                FROM app.lands AS l
                JOIN {table_ref} AS src ON l.source_feature_id = {feature_id_ref}::text
                WHERE {' AND '.join(filters)}
                """.strip()
            )
            params.extend(land_params)
        if "building" in source_types:
            filters = [
                "b.project_id = %s::uuid",
                "b.source_layer_id = %s::uuid",
                "b.source_feature_id IS NOT NULL",
                f"{geometry_ref} IS NOT NULL",
            ]
            building_params: list[Any] = [project_id, source_layer.id]
            add_business_query_filter(
                condition.get("businessQuery"),
                "concat_ws(' ', b.id, b.name, b.building_use, b.structure, b.status, b.memo, l.lot_number, l.address)",
                filters,
                building_params,
            )
            add_party_relationship_filter("building", "b.id", "b.project_id", condition, filters, building_params)
            selects.append(
                f"""
                SELECT
                    'building' AS business_type,
                    b.id AS business_id,
                    b.name AS business_label,
                    {geometry_ref} AS geom
                FROM app.buildings AS b
                LEFT JOIN app.lands AS l ON l.id = b.land_id
                JOIN {table_ref} AS src ON b.source_feature_id = {feature_id_ref}::text
                WHERE {' AND '.join(filters)}
                """.strip()
            )
            params.extend(building_params)
    return "\nUNION ALL\n".join(selects), params


def add_business_query_filter(
    query: Any,
    text_expression: str,
    filters: list[str],
    params: list[Any],
) -> None:
    value = str(query or "").strip()
    if not value:
        return
    filters.append(f"lower({text_expression}) LIKE lower(%s)")
    params.append(f"%{value}%")


def add_party_relationship_filter(
    target_type: str,
    target_id_expression: str,
    project_id_expression: str,
    condition: dict[str, Any],
    filters: list[str],
    params: list[Any],
) -> None:
    party_query = str(condition.get("partyQuery") or "").strip()
    party_type = str(condition.get("partyType") or "").strip()
    relation_type = str(condition.get("relationType") or "").strip()
    if not party_query and not party_type and not relation_type:
        return
    relationship_filters = [
        f"r.project_id = {project_id_expression}",
        f"r.target_type = '{target_type}'",
        f"r.target_id = {target_id_expression}",
    ]
    if party_query:
        relationship_filters.append("lower(concat_ws(' ', p.id, p.name, p.party_type, p.contact, p.address, p.memo)) LIKE lower(%s)")
        params.append(f"%{party_query}%")
    if party_type:
        relationship_filters.append("p.party_type ILIKE %s")
        params.append(f"%{party_type}%")
    if relation_type:
        relationship_filters.append("r.relation_type ILIKE %s")
        params.append(f"%{relation_type}%")
    filters.append(
        "EXISTS ("
        "SELECT 1 FROM app.party_relationships AS r "
        "JOIN app.parties AS p ON p.id = r.party_id "
        f"WHERE {' AND '.join(relationship_filters)}"
        ")"
    )


def list_layers_for_project(conn: psycopg.Connection, project_id: str) -> list[LayerMeta]:
    rows = conn.execute(
        """
        SELECT id::text
        FROM app.layers
        WHERE project_id = %s::uuid AND layer_role <> 'zone'
        ORDER BY created_at
        """,
        (project_id,),
    ).fetchall()
    return [load_layer(conn, row["id"]) for row in rows]


def condition_search_summary(condition_query: dict[str, Any]) -> str:
    parts: list[str] = []
    keyword = str(condition_query.get("keyword") or "").strip()
    if keyword:
        parts.append(f"キーワード: {keyword}")
    labels = []
    for condition in condition_query.get("conditions", []):
        condition_type = str(condition.get("type") or "").lower()
        if condition_type == "attribute":
            labels.append("属性条件")
        elif condition_type == "spatial":
            labels.append("空間条件")
        elif condition_type == "business":
            labels.append("業務条件")
    parts.extend(dict.fromkeys(labels))
    return " AND ".join(parts) if parts else "条件なし"


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


def is_polygon_layer(layer: LayerMeta) -> bool:
    return "POLYGON" in layer.geometry_type.upper()


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
               geometry_column, geometry_type, feature_id_column, layer_role
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
        layer_role=row["layer_role"],
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
    try:
        with conn.transaction():
            conn.execute(
                """
                UPDATE app.analysis_jobs
                SET status = 'failed', error_message = %s, finished_at = now()
                WHERE id = %s::uuid
                """,
                (message, job_id),
            )
    except Exception:
        for _ in range(5):
            try:
                with connect() as retry_conn:
                    with retry_conn.transaction():
                        retry_conn.execute(
                            """
                            UPDATE app.analysis_jobs
                            SET status = 'failed', error_message = %s, finished_at = now()
                            WHERE id = %s::uuid
                            """,
                            (message, job_id),
                        )
                break
            except Exception:
                time.sleep(1)
        else:
            traceback.print_exc()
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


def normalize_layer_role(value: str | None) -> str:
    role = (value or "generic").strip().lower() or "generic"
    if role not in {"generic", "zone"}:
        raise ValueError("layerRole must be generic or zone")
    return role


if __name__ == "__main__":
    main()
