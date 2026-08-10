#!/usr/bin/env bash
# Feedback Service Go版のmulti-arch release artifactを再現可能な形で生成する。
set -euo pipefail

ROOT=$(git rev-parse --show-toplevel 2>/dev/null || (cd "$(dirname "$0")/.." && pwd))
cd "$ROOT"

output=""
version=${FEEDBACK_RELEASE_VERSION:-}

usage() {
  echo "usage: scripts/build-feedback-go-release.sh --output <empty-directory> --version <version>" >&2
  exit 2
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --output) [[ $# -ge 2 ]] || usage; output=$2; shift 2 ;;
    --version) [[ $# -ge 2 ]] || usage; version=$2; shift 2 ;;
    *) usage ;;
  esac
done

[[ -n "$output" && -n "$version" ]] || usage
[[ "$version" =~ ^[0-9A-Za-z][0-9A-Za-z._+-]{0,99}$ ]] || {
  echo "versionが不正です: $version" >&2
  exit 1
}
for command in go docker file jq sha256sum stat tar trivy; do
  command -v "$command" >/dev/null 2>&1 || { echo "$command が必要です" >&2; exit 1; }
done
trivy_version=$(trivy version 2>/dev/null | awk '$1 == "Version:" { print $2; exit }')
[[ "$trivy_version" == "0.70.0" ]] || {
  echo "Trivy 0.70.0が必要です: detected=${trivy_version:-unknown}" >&2
  exit 1
}

if [[ -e "$output" ]]; then
  [[ -d "$output" && -z "$(find "$output" -mindepth 1 -maxdepth 1 -print -quit)" ]] || {
    echo "出力先は空directoryで指定してください: $output" >&2
    exit 1
  }
else
  mkdir -p "$output"
fi
output=$(cd "$output" && pwd)

export GOTOOLCHAIN=go1.26.5
[[ "$(go env GOVERSION)" == "go1.26.5" ]] || {
  echo "Go 1.26.5が必要です" >&2
  exit 1
}

release_builder=${FEEDBACK_RELEASE_BUILDER:-feedback-go-release-$$}
owns_builder=0
oci_layout=$(mktemp -d -t feedback-go-oci.XXXXXX)
checksum_temp=""
if [[ -z "${FEEDBACK_RELEASE_BUILDER:-}" ]]; then
  docker buildx create --driver docker-container --name "$release_builder" >/dev/null
  owns_builder=1
fi
cleanup() {
  if [[ "$owns_builder" == "1" ]]; then
    docker buildx rm "$release_builder" >/dev/null 2>&1 || true
  fi
  if [[ -d "$oci_layout" && "$(basename "$oci_layout")" == feedback-go-oci.?????? ]]; then
    rm -rf -- "$oci_layout"
  fi
  if [[ -n "$checksum_temp" && -f "$checksum_temp" && \
      "$(basename "$checksum_temp")" == feedback-sha256sums.?????? ]]; then
    rm -- "$checksum_temp"
  fi
}
trap cleanup EXIT

build_binary() {
  local operating_system=$1
  local architecture=$2
  local suffix=${3:-}
  local artifact="feedback-service-go_${version}_${operating_system}_${architecture}${suffix}"
  (
    cd apps/feedback-service-go
    CGO_ENABLED=0 GOOS="$operating_system" GOARCH="$architecture" \
      go build -buildvcs=false -trimpath -ldflags='-s -w' -o "$output/$artifact" ./cmd/feedback
  )
  chmod 0755 "$output/$artifact"
}

build_binary linux amd64
build_binary linux arm64
build_binary darwin arm64
build_binary windows amd64 .exe

LC_ALL=C file "$output/feedback-service-go_${version}_linux_amd64" | grep -q 'ELF 64-bit.*x86-64'
LC_ALL=C file "$output/feedback-service-go_${version}_linux_arm64" | grep -q 'ELF 64-bit.*ARM aarch64'
LC_ALL=C file "$output/feedback-service-go_${version}_darwin_arm64" | grep -q 'Mach-O 64-bit arm64'
LC_ALL=C file "$output/feedback-service-go_${version}_windows_amd64.exe" | grep -q 'PE32+ executable.*x86-64'

oci_archive="feedback-service-go_${version}_linux_multiarch.oci.tar"
revision=$(git rev-parse HEAD 2>/dev/null || echo unknown)
docker buildx build \
  --builder "$release_builder" \
  --platform linux/amd64,linux/arm64 \
  --build-arg "VERSION=$version" \
  --build-arg "REVISION=$revision" \
  --file apps/feedback-service-go/Dockerfile \
  --output "type=oci,dest=$oci_layout,tar=false" \
  .

for platform in linux/amd64 linux/arm64; do
  platform_suffix=${platform//\//_}
  vulnerability_report="feedback-service-go_${version}_${platform_suffix}.trivy.sarif"
  trivy image --quiet --input "$oci_layout" --platform "$platform" --scanners vuln \
    --severity HIGH,CRITICAL --exit-code 1 --format sarif --output "$output/$vulnerability_report"
  sbom="feedback-service-go_${version}_${platform_suffix}.cdx.json"
  trivy image --quiet --input "$oci_layout" --platform "$platform" \
    --format cyclonedx --output "$output/$sbom"
done
tar --sort=name --owner=0 --group=0 --numeric-owner --mtime=@0 \
  -C "$oci_layout" -cf "$output/$oci_archive" .

artifacts_json='[]'
while IFS= read -r artifact; do
  filename=$(basename "$artifact")
  digest=$(sha256sum "$artifact" | awk '{print $1}')
  bytes=$(stat -c '%s' "$artifact")
  artifacts_json=$(jq -c \
    --arg name "$filename" --arg sha256 "$digest" --argjson bytes "$bytes" \
    '. + [{name:$name,sha256:$sha256,bytes:$bytes}]' <<<"$artifacts_json")
done < <(find "$output" -maxdepth 1 -type f -print | LC_ALL=C sort)

generated_at=$(date -u +'%Y-%m-%dT%H:%M:%SZ')
jq -n \
  --arg version "$version" \
  --arg generatedAt "$generated_at" \
  --argjson artifacts "$artifacts_json" \
  '{
    schemaVersion: "1",
    product: "feedback-service-go",
    version: $version,
    generatedAt: $generatedAt,
    apiVersion: "feedback/v1",
    connectorProtocolVersion: "1",
    databaseHandoffVersion: 6,
    minimumPostgreSQLMajor: 16,
    platforms: ["linux/amd64", "linux/arm64"],
    cliPlatforms: ["darwin/arm64", "windows/amd64"],
    artifacts: $artifacts,
    signingTargets: ["SHA256SUMS", "release-manifest.json"]
  }' >"$output/release-manifest.json"

checksum_temp=$(mktemp -t feedback-sha256sums.XXXXXX)
(
  cd "$output"
  find . -maxdepth 1 -type f ! -name SHA256SUMS -printf '%P\n' \
    | LC_ALL=C sort \
    | xargs sha256sum
) >"$checksum_temp"
mv "$checksum_temp" "$output/SHA256SUMS"
checksum_temp=""
(
  cd "$output"
  sha256sum --check SHA256SUMS >/dev/null
)

echo "[feedback-go-release] PASS: $output"
