#!/usr/bin/env bash
# publishせず、実tarballをworkspace外のReact 18/19 fixtureへ導入してpackage契約を検査する。
set -euo pipefail

ROOT=$(git rev-parse --show-toplevel 2>/dev/null || (cd "$(dirname "$0")/.." && pwd))
cd "$ROOT"

feedback_package_tmp=$(mktemp -d -t feedback-packages.XXXXXX)
cleanup_feedback_package_tmp() {
  if [[ -d "$feedback_package_tmp" && "$(basename "$feedback_package_tmp")" == feedback-packages.* ]]; then
    rm -rf -- "$feedback_package_tmp"
  fi
}
trap cleanup_feedback_package_tmp EXIT

tarball_dir="$feedback_package_tmp/tarballs"
mkdir -p "$tarball_dir"
packages=(
  @feedback/contracts
  @feedback/core
  @feedback/react
  @feedback/maplibre
  @feedback/admin-react
)
declare -A tarballs

for package_name in "${packages[@]}"; do
  package_key=${package_name#@feedback/}
  node -e '
    const fs = require("node:fs");
    const lock = JSON.parse(fs.readFileSync("package-lock.json", "utf8"));
    const entry = Object.entries(lock.packages).find(([, value]) => value && value.name === process.argv[1]);
    if (!entry) process.exit(1);
    const manifest = JSON.parse(fs.readFileSync(`${entry[0]}/package.json`, "utf8"));
    if (manifest.private !== true) process.exit(1);
  ' "$package_name" || {
    echo "[feedback-package] FAIL: $package_name はregistry承認前のprivate workspaceである必要があります" >&2
    exit 1
  }

  pack_result=$(npm --workspace "$package_name" pack --pack-destination "$tarball_dir" --json)
  tarball_file=$(PACK_RESULT="$pack_result" PACKAGE_NAME="$package_name" node -e '
    const [result] = JSON.parse(process.env.PACK_RESULT);
    const files = new Set(result.files.map((file) => file.path));
    const required = ["dist/index.js", "dist/index.d.ts", "package.json", "README.md", "CHANGELOG.md"];
    if (["@feedback/react", "@feedback/admin-react"].includes(process.env.PACKAGE_NAME)) required.push("dist/styles.css");
    if (process.env.PACKAGE_NAME === "@feedback/contracts") {
      required.push("openapi.yaml", "token-exchange.openapi.yaml", "schemas/application-manifest.schema.json", "schemas/location.schema.json", "schemas/target.schema.json", "schemas/webhook-event.schema.json", "schemas/token-exchange-jwt.schema.json");
    }
    if (required.some((path) => !files.has(path))) process.exit(1);
    process.stdout.write(result.filename);
  ') || {
    echo "[feedback-package] FAIL: $package_name のtarballにJS/types/CSS/契約/metadataが揃っていません" >&2
    exit 1
  }
  tarballs[$package_key]="$tarball_dir/$tarball_file"
  echo "[feedback-package] PASS: $package_name tarball"
done

node -e '
  const fs = require("node:fs");
  const read = (path) => JSON.parse(fs.readFileSync(path, "utf8"));
  const contracts = read("contracts/feedback/package.json");
  const core = read("packages/feedback-core/package.json");
  const react = read("packages/feedback-react/package.json");
  const maplibre = read("packages/feedback-maplibre/package.json");
  const admin = read("packages/feedback-admin-react/package.json");
  const dependencyNames = (value) => new Set([
    ...Object.keys(value.dependencies || {}),
    ...Object.keys(value.peerDependencies || {}),
    ...Object.keys(value.optionalDependencies || {})
  ]);
  for (const value of [contracts, core]) {
    const names = dependencyNames(value);
    if (["react", "react-dom", "maplibre-gl", "@feedback/react", "@feedback/maplibre", "@feedback/admin-react"].some((name) => names.has(name))) process.exit(1);
  }
  if (dependencyNames(react).has("maplibre-gl") || dependencyNames(react).has("@feedback/maplibre")) process.exit(1);
  if (Object.keys(maplibre.peerDependencies || {}).join(",") !== "maplibre-gl") process.exit(1);
  if (![contracts, core, react, maplibre, admin].every((value) => value.private === true && value.version === "1.0.0-alpha.1")) process.exit(1);
' || {
  echo "[feedback-package] FAIL: optional dependencyまたはversion/private metadata境界が不正です" >&2
  exit 1
}

react_versions=(18.3.1 19.1.1)
react_type_versions=(18.3.12 19.1.9)
react_dom_type_versions=(18.3.1 19.1.7)
typescript_versions=(5.6.3 5.9.3)

for index in "${!react_versions[@]}"; do
  react_version=${react_versions[$index]}
  fixture="$feedback_package_tmp/react-$react_version"
  cp -R tests/fixtures/feedback-sdk-vite "$fixture"
  (
    cd "$fixture"
    npm install --ignore-scripts --no-audit --no-fund \
      "react@$react_version" "react-dom@$react_version" \
      "@types/react@${react_type_versions[$index]}" "@types/react-dom@${react_dom_type_versions[$index]}" \
      "typescript@${typescript_versions[$index]}" vite@5.4.21 @vitejs/plugin-react@4.7.0 \
      vitest@4.1.9 jsdom@29.1.1 @testing-library/react@16.3.2 react-router-dom@6.30.1
    npm install --ignore-scripts --no-audit --no-fund \
      "${tarballs[contracts]}" "${tarballs[core]}" "${tarballs[react]}"
    test ! -d node_modules/@feedback/maplibre
    test ! -d node_modules/@feedback/admin-react
    test ! -d node_modules/maplibre-gl
    test -f node_modules/@feedback/react/dist/styles.css
    npm run typecheck
    npm run build
    npm run test

    if [[ "$react_version" == 19.* ]]; then
      npm install --ignore-scripts --no-audit --no-fund maplibre-gl@5.24.0 "${tarballs[maplibre]}"
      npm run typecheck:maplibre
      node --input-type=module -e 'await import("@feedback/maplibre")'
      npm install --ignore-scripts --no-audit --no-fund "${tarballs["admin-react"]}"
      npm run typecheck:admin
      test -f node_modules/@feedback/admin-react/dist/styles.css
      node --input-type=module -e 'await import("@feedback/admin-react")'
    fi
  )
  echo "[feedback-package] PASS: clean Vite React $react_version fixture"
done

# alpha tarballと同じ公開surfaceを、version/internal dependencyだけ1.0.0へ昇格した候補で再検証する。
# publishは行わず、pre-release consumer sourceがstable候補へ無変更で移れることだけを確認する。
stable_tarball_dir="$feedback_package_tmp/stable-tarballs"
mkdir -p "$stable_tarball_dir"
declare -A stable_tarballs
for package_name in "${packages[@]}"; do
  package_key=${package_name#@feedback/}
  candidate="$feedback_package_tmp/stable-$package_key"
  mkdir -p "$candidate"
  tar -xzf "${tarballs[$package_key]}" -C "$candidate" --strip-components=1
  node -e '
    const fs = require("node:fs");
    const file = process.argv[1];
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    value.version = "1.0.0";
    for (const section of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
      for (const name of Object.keys(value[section] || {})) {
        if (name.startsWith("@feedback/")) value[section][name] = "1.0.0";
      }
    }
    fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
  ' "$candidate/package.json"
  stable_pack=$(npm pack "$candidate" --pack-destination "$stable_tarball_dir" --json)
  stable_file=$(PACK_RESULT="$stable_pack" node -e 'const [result] = JSON.parse(process.env.PACK_RESULT); process.stdout.write(result.filename)')
  stable_tarballs[$package_key]="$stable_tarball_dir/$stable_file"
done

stable_fixture="$feedback_package_tmp/stable-consumer"
cp -R tests/fixtures/feedback-sdk-vite "$stable_fixture"
(
  cd "$stable_fixture"
  npm install --ignore-scripts --no-audit --no-fund \
    react@19.1.1 react-dom@19.1.1 @types/react@19.1.9 @types/react-dom@19.1.7 \
    typescript@5.9.3 vite@5.4.21 @vitejs/plugin-react@4.7.0 vitest@4.1.9 jsdom@29.1.1 \
    @testing-library/react@16.3.2 react-router-dom@6.30.1 maplibre-gl@5.24.0
  npm install --ignore-scripts --no-audit --no-fund \
    "${stable_tarballs[contracts]}" "${stable_tarballs[core]}" "${stable_tarballs[react]}" \
    "${stable_tarballs[maplibre]}" "${stable_tarballs[admin-react]}"
  npm run typecheck
  npm run typecheck:maplibre
  npm run typecheck:admin
  npm run build
  npm run test
)
echo "[feedback-package] PASS: prerelease consumer → stable 1.0.0 candidate semver compatibility"
