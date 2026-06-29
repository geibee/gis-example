# Web GIS MVP

PostGIS を正本データストアにした OSS ベースの Web GIS MVP です。初期版は GIS ファイル取込、MapLibre/Martin による表示、複数レイヤを使った条件検索、結果レイヤ保存に絞っています。

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
- `小地域（町丁・字等）2020 東京`
- `坪単価200万以上の小地域`
- `商業地域・近隣商業地域 東京`

The same fresh seed also includes business-domain records for the condition-search UI:

- Lands: `L-0001` to `L-0003`
- Buildings: `B-0001` to `B-0002`
- Parties and relationships for owner, manager, and sales-party filters, including `銀座開発株式会社`
- Dense central Tokyo demo layers:
  - `登記所備付地図 土地筆（都心サンプル）`
  - `PLATEAU 建物（都心サンプル）`
  - `都心業務区域v1`
- Dense demo business records:
  - Lands: `L-DENSE-001` to `L-DENSE-036`
  - Buildings: `B-DENSE-001` to `B-DENSE-036`
  - Zones: `Z-DENSE-001` to `Z-DENSE-004`, each containing multiple linked lands and buildings
  - Parties: `P-DENSE-001` to `P-DENSE-011`, with generated relationships for zone party summaries and ranking

The GIS seed data is stored as PostGIS SQL dumps, not as the original source ZIP files. Source datasets:

- 国土数値情報 地価公示データ L01 2023 東京都
- 国土数値情報 用途地域データ A29 2019 東京都
- e-Stat 国勢調査 2020 小地域（町丁・字等）境界 東京都
- 法務省 登記所備付地図データ（G空間情報センターで公開）
- PLATEAU 3D都市モデル 建築物モデル

PostgreSQL entrypoint seed scripts run only when the `postgres-data` volume is created. If you need to recreate the bundled sample state from scratch, remove the existing Compose volume first.

Open-data fetch settings for the dense Tokyo demo live under `tools/open-data`.
The direct G空間情報センター download URLs are configuration values because they can change by release year and may require a logged-in session:

```bash
python3 tools/open-data/fetch_tokyo_core_open_data.py --cache-dir /tmp/tokyo-core-open-data
```

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

`POST /api/features/condition-search` accepts a `ConditionQuery` and returns temporary feature matches grouped by `layerId`/`layerName` for UI review and map highlighting. `POST /api/analysis-jobs` also accepts `operation: "condition_search"` with the same `ConditionQuery`; the worker saves a result set and child result layers per source layer. Conditions are joined with AND in v1.

```json
{
  "projectId": "00000000-0000-0000-0000-000000000000",
  "targetLayerIds": ["a6dbb70e-1999-578f-904d-8f5c68513085"],
  "keyword": "商業地域",
  "conditions": [
    { "type": "attribute", "layerId": "a6dbb70e-1999-578f-904d-8f5c68513085", "field": "zoning_name", "operator": "LIKE", "value": "商業" },
    { "type": "spatial", "comparisonTarget": "business", "spatialOperator": "intersects" },
    { "type": "business", "sourceTypes": ["land"], "partyQuery": "銀座開発", "relationType": "売買事業者" }
  ],
  "limit": 100
}
```

Allowed spatial operators: `intersects`, `contains`, `within`, `dwithin`.

Allowed attribute operators: `=`, `!=`, `<`, `<=`, `>`, `>=`, `LIKE`, `IN`, `IS NULL`.

## Notes

- Initial authentication/authorization is intentionally omitted for single-admin use.
- Imported and result geometries are stored in EPSG:3857 for Martin tile serving. Bboxes are exposed in EPSG:4326.
- Layer IDs, table names, geometry columns, attribute names, and operators are validated against DB metadata before jobs are accepted or executed.
