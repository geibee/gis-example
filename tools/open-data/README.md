# Tokyo Core Open Data Staging

This folder contains the configurable fetch step for the dense central Tokyo demo.
The bundled database seed is deterministic so the app works offline, while this
tool keeps the source-data workflow reproducible when direct download URLs are
available.

Sources:

- Ministry of Justice registry office map data announcement:
  https://www.moj.go.jp/MINJI/minji05_00494.html
- Digital Agency map XML to GeoJSON converter notes:
  https://www.digital.go.jp/news/4b7250a3-3fcf-4b83-8d52-4bb131e1ba9d
- PLATEAU open-data portal:
  https://www.mlit.go.jp/plateau/open-data/

Usage:

```bash
python3 tools/open-data/fetch_tokyo_core_open_data.py
```

By default the script uses `data/open-data-cache/tokyo-core`. If the local
`data` directory is owned by Docker, pass a writable cache directory:

```bash
python3 tools/open-data/fetch_tokyo_core_open_data.py --cache-dir /tmp/tokyo-core-open-data
```

To download real inputs, edit `tokyo-core-sources.json` and set each
`downloadUrl` to the current G空間情報センター file URL. Then run:

```bash
python3 tools/open-data/fetch_tokyo_core_open_data.py --convert
```

`--convert` requires GDAL `ogr2ogr`; it clips matching inputs to the configured
central Tokyo bbox and writes GeoJSON outputs into the cache directory.
