# Web GIS MVP

PostGIS を正本データストアにした OSS ベースの Web GIS MVP です。初期版は GIS ファイル取込、MapLibre/Martin による表示、複数レイヤを使った AND 条件抽出、結果レイヤ保存に絞っています。

## Stack

- Web: React + TypeScript + MapLibre GL JS
- API: Ktor + PostgreSQL JDBC
- GIS worker: Python + GDAL/OGR + psycopg
- Tile server: API dynamic MVT endpoint for newly created layers, with Martin included in the stack for PostGIS tile serving
- DB: PostgreSQL + PostGIS
- Local runtime: Docker Compose

## Run

```bash
docker compose -f infra/docker-compose.yml up --build
```

Services:

- Web: http://localhost:5173
- API health: http://localhost:8080/health
- Martin: http://localhost:3000
- PostgreSQL: localhost:5432 (`gis` / `gis`)

Uploaded files and generated runtime data are stored under `./data`.

## Bundled Tokyo Sample Data

Fresh PostgreSQL volumes are seeded automatically during `docker compose up` from the SQL dumps under `infra/postgres`.
The Web UI is immediately usable with these Tokyo layers:

- `地価公示 2023 東京`
- `行政区域 2023 東京`
- `小地域（町丁・字等）2020 東京`
- `公示地価 坪単価100万円以上 2023 東京`
- `公示地価 坪単価200万円以上 2023 東京`
- `坪単価200万以上の小地域`

The seed data is stored as compressed PostGIS SQL, not as the original source ZIP files. Source datasets:

- 国土数値情報 地価公示データ L01 2023 東京都
- 国土数値情報 行政区域データ N03 2023 東京都
- e-Stat 国勢調査 2020 小地域（町丁・字等）境界 東京都

PostgreSQL entrypoint seed scripts run only when the `postgres-data` volume is created. If you need to recreate the bundled sample state from scratch, remove the existing Compose volume first.

## Import Workflow

Use the left panel in the Web UI or call the API directly:

```bash
curl -F projectId=<project-id> \
  -F format=geojson \
  -F sourceSrid=4326 \
  -F file=@samples/geojson/parcels.geojson \
  http://localhost:8080/api/import-jobs
```

Supported initial formats are Shapefile zip, GML, KML, GPX, and GeoJSON. The worker loads data through GDAL/OGR into `gis_data.<layer_table>` and records metadata in the `app.layers` and `app.layer_attributes` tables.

`GET /api/tilejson/{layerId}` returns vector tile URLs backed by `GET /api/tiles/{layerId}/{z}/{x}/{y}`. This keeps imported and analysis-result layers visible immediately without restarting Martin. Martin remains available in the Compose stack for direct PostGIS tile serving and later production tuning.

## Analysis Criteria

`POST /api/analysis-jobs` accepts a target layer plus attribute and spatial conditions. Conditions are joined with AND. Non-target layer attribute conditions are evaluated inside the same layer existence predicate used for spatial filtering.

```json
{
  "projectId": "00000000-0000-0000-0000-000000000000",
  "name": "住宅かつ道路に接する筆",
  "targetLayerId": "target-layer-uuid",
  "attributeConditions": [
    { "layerId": "target-layer-uuid", "field": "landuse", "operator": "=", "value": "residential" },
    { "layerId": "road-layer-uuid", "field": "class", "operator": "IN", "values": ["primary", "secondary"] }
  ],
  "spatialConditions": [
    { "layerId": "road-layer-uuid", "operator": "intersects" }
  ]
}
```

Allowed spatial operators: `intersects`, `contains`, `within`, `dwithin`.

Allowed attribute operators: `=`, `!=`, `<`, `<=`, `>`, `>=`, `LIKE`, `IN`, `IS NULL`.

## Notes

- Initial authentication/authorization is intentionally omitted for single-admin use.
- Imported and result geometries are stored in EPSG:3857 for Martin tile serving. Bboxes are exposed in EPSG:4326.
- Layer IDs, table names, geometry columns, attribute names, and operators are validated against DB metadata before jobs are accepted or executed.
