#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import subprocess
import sys
import tempfile
import urllib.parse
import urllib.request
import zipfile
from pathlib import Path
from typing import Any


def main() -> int:
    parser = argparse.ArgumentParser(description="Fetch and stage dense Tokyo open data inputs.")
    parser.add_argument("--config", default="tools/open-data/tokyo-core-sources.json")
    parser.add_argument("--cache-dir", default=None)
    parser.add_argument("--convert", action="store_true", help="Run ogr2ogr to clip staged files to GeoJSON.")
    parser.add_argument("--require-download-urls", action="store_true", help="Fail when a configured artifact has no downloadUrl.")
    args = parser.parse_args()

    repo_root = Path(__file__).resolve().parents[2]
    config_path = (repo_root / args.config).resolve()
    config = json.loads(config_path.read_text(encoding="utf-8"))
    cache_dir = Path(args.cache_dir or config["cacheDir"])
    if not cache_dir.is_absolute():
        cache_dir = repo_root / cache_dir
    cache_dir.mkdir(parents=True, exist_ok=True)

    bbox = config["bbox4326"]
    manifest: dict[str, Any] = {"config": str(config_path), "bbox4326": bbox, "sources": []}
    skipped_urls = 0

    for source in config["sources"]:
        source_dir = cache_dir / source["id"]
        source_dir.mkdir(parents=True, exist_ok=True)
        source_manifest: dict[str, Any] = {
            "id": source["id"],
            "label": source["label"],
            "sourcePageUrl": source.get("sourcePageUrl"),
            "downloadPageUrl": source.get("downloadPageUrl"),
            "datasetPageUrls": source.get("datasetPageUrls", []),
            "files": [],
            "converted": []
        }

        for artifact in source.get("artifacts", []):
            url = (artifact.get("downloadUrl") or "").strip()
            if not url:
                skipped_urls += 1
                message = f"skip {source['id']}:{artifact['name']} because downloadUrl is blank"
                if args.require_download_urls:
                    print(message, file=sys.stderr)
                    return 2
                print(message)
                continue

            file_name = artifact.get("fileName") or Path(urllib.parse.urlparse(url).path).name
            if not file_name:
                print(f"artifact {source['id']}:{artifact['name']} needs fileName", file=sys.stderr)
                return 2
            target = source_dir / file_name
            download(url, target)
            entry = {
                "name": artifact["name"],
                "url": url,
                "path": str(target),
                "sha256": sha256(target),
                "bytes": target.stat().st_size
            }
            source_manifest["files"].append(entry)

            if artifact.get("extract") and zipfile.is_zipfile(target):
                extracted_dir = source_dir / f"{target.stem}-extracted"
                extracted_dir.mkdir(parents=True, exist_ok=True)
                with zipfile.ZipFile(target) as archive:
                    archive.extractall(extracted_dir)
                entry["extractedTo"] = str(extracted_dir)

        if args.convert:
            converted = convert_source(source, source_dir, cache_dir, bbox)
            source_manifest["converted"].extend(str(path) for path in converted)

        manifest["sources"].append(source_manifest)

    manifest_path = cache_dir / "manifest.json"
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {manifest_path}")
    if skipped_urls:
        print(f"{skipped_urls} artifact(s) had blank downloadUrl; edit {config_path} to enable fetching.")
    return 0


def download(url: str, target: Path) -> None:
    if target.exists() and target.stat().st_size > 0:
        print(f"reuse {target}")
        return
    print(f"download {url} -> {target}")
    request = urllib.request.Request(url, headers={"User-Agent": "gis-example-open-data-fetch/1.0"})
    with urllib.request.urlopen(request) as response, target.open("wb") as out:
        shutil.copyfileobj(response, out)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def convert_source(source: dict[str, Any], source_dir: Path, cache_dir: Path, bbox: list[float]) -> list[Path]:
    ogr2ogr = shutil.which("ogr2ogr")
    if ogr2ogr is None:
        print("skip conversion because ogr2ogr was not found", file=sys.stderr)
        return []

    conversion = source.get("conversion") or {}
    output_name = conversion.get("outputGeojson")
    if not output_name:
        return []

    candidates: list[Path] = []
    for pattern in conversion.get("inputGlobs", []):
        candidates.extend(path for path in source_dir.glob(pattern) if path.is_file())
    candidates = sorted(set(candidates))
    if not candidates:
        print(f"skip conversion for {source['id']} because no input files matched")
        return []

    output = cache_dir / output_name
    clipped_files: list[Path] = []
    with tempfile.TemporaryDirectory(prefix=f"{source['id']}-", dir=cache_dir) as tmp:
        tmp_dir = Path(tmp)
        for index, candidate in enumerate(candidates, start=1):
            clipped = tmp_dir / f"{source['id']}-{index:04d}.geojson"
            command = [
                ogr2ogr,
                "-f",
                "GeoJSON",
                str(clipped),
                str(candidate),
                "-t_srs",
                "EPSG:4326",
                "-clipsrc",
                str(bbox[0]),
                str(bbox[1]),
                str(bbox[2]),
                str(bbox[3]),
                "-nlt",
                "PROMOTE_TO_MULTI",
                "-dim",
                "XY",
                "-skipfailures"
            ]
            ogr_layer = conversion.get("ogrLayer")
            if ogr_layer:
                command.append(str(ogr_layer))
            result = subprocess.run(command, text=True, capture_output=True)
            if result.returncode != 0:
                print(result.stderr.strip() or result.stdout.strip(), file=sys.stderr)
                continue
            clipped_files.append(clipped)
        merge_geojson(clipped_files, output)
    print(f"converted {len(clipped_files)} file(s) -> {output}")
    return [output]


def merge_geojson(inputs: list[Path], output: Path) -> None:
    features: list[dict[str, Any]] = []
    for path in inputs:
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            continue
        if data.get("type") == "FeatureCollection":
            features.extend(data.get("features") or [])
        elif data.get("type") == "Feature":
            features.append(data)
    output.write_text(
        json.dumps({"type": "FeatureCollection", "features": features}, ensure_ascii=False),
        encoding="utf-8"
    )


if __name__ == "__main__":
    raise SystemExit(main())
