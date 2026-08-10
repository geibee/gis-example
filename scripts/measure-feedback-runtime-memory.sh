#!/usr/bin/env bash
# 実行中Feedback containerのmemory使用量をrole別JSONへ保存し、絶対上限をfail-closedに検査する。
set -euo pipefail

implementation=""
output=""
maximum_bytes=104857600
declare -a role_containers=()

usage() {
  echo "usage: scripts/measure-feedback-runtime-memory.sh --implementation <go|kotlin> --output <new.json> [--maximum-bytes <N>] --container <role=container>..." >&2
  exit 2
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --implementation) [[ $# -ge 2 ]] || usage; implementation=$2; shift 2 ;;
    --output) [[ $# -ge 2 ]] || usage; output=$2; shift 2 ;;
    --maximum-bytes) [[ $# -ge 2 ]] || usage; maximum_bytes=$2; shift 2 ;;
    --container) [[ $# -ge 2 ]] || usage; role_containers+=("$2"); shift 2 ;;
    *) usage ;;
  esac
done

[[ "$implementation" == "go" || "$implementation" == "kotlin" ]] || usage
[[ -n "$output" && ! -e "$output" && -d "$(dirname "$output")" ]] || usage
[[ "$maximum_bytes" =~ ^[0-9]+$ ]] || usage
(( ${#role_containers[@]} > 0 )) || usage
for command in docker jq awk; do
  command -v "$command" >/dev/null 2>&1 || { echo "$command が必要です" >&2; exit 1; }
done

samples='[]'
declare -A observed_roles=()
for pair in "${role_containers[@]}"; do
  role=${pair%%=*}
  container=${pair#*=}
  [[ "$pair" == *=* && "$role" =~ ^[a-z][a-z0-9-]{0,63}$ && -n "$container" ]] || {
    echo "container指定が不正です: $pair" >&2
    exit 1
  }
  [[ -z "${observed_roles[$role]:-}" ]] || { echo "roleが重複しています: $role" >&2; exit 1; }
  observed_roles[$role]=1
  [[ "$(docker inspect "$container" --format '{{.State.Running}}')" == "true" ]] || {
    echo "containerが起動していません: $role=$container" >&2
    exit 1
  }
  container_id=$(docker inspect "$container" --format '{{.Id}}')
  usage=$(docker stats --no-stream --format '{{.MemUsage}}' "$container")
  used=${usage%% / *}
  if [[ ! "$used" =~ ^([0-9]+([.][0-9]+)?)(B|KiB|MiB|GiB)$ ]]; then
    echo "memory使用量を解釈できません: $role=$usage" >&2
    exit 1
  fi
  number=${BASH_REMATCH[1]}
  unit=${BASH_REMATCH[3]}
  case "$unit" in
    B) multiplier=1 ;;
    KiB) multiplier=1024 ;;
    MiB) multiplier=1048576 ;;
    GiB) multiplier=1073741824 ;;
  esac
  bytes=$(awk -v number="$number" -v multiplier="$multiplier" \
    'BEGIN { printf "%.0f", number * multiplier }')
  samples=$(jq -c \
    --arg role "$role" --arg containerId "$container_id" --arg raw "$usage" --argjson bytes "$bytes" \
    '. + [{role:$role,containerId:$containerId,memoryUsage:$raw,bytes:$bytes}]' <<<"$samples")
done

passed=$(jq -n --argjson maximum "$maximum_bytes" --argjson samples "$samples" \
  '$maximum == 0 or all($samples[]; .bytes <= $maximum)')
jq -n \
  --arg implementation "$implementation" \
  --arg recordedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --argjson maximumBytes "$maximum_bytes" \
  --argjson passed "$passed" \
  --argjson samples "$samples" \
  '{schemaVersion:1,implementation:$implementation,recordedAt:$recordedAt,
    maximumBytes:$maximumBytes,passed:$passed,samples:$samples}' >"$output"

[[ "$passed" == "true" ]] || {
  echo "[feedback-runtime-memory] FAIL: memory上限を超えました: $output" >&2
  exit 1
}
echo "[feedback-runtime-memory] PASS: $output"
