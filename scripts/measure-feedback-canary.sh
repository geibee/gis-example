#!/usr/bin/env bash
# 同一のread-only fixtureをKotlin/Goへ交互に送り、HTTP p95とerrorのcanary証跡を生成する。
set -euo pipefail
export LC_ALL=C

usage() {
  cat >&2 <<'USAGE'
usage: scripts/measure-feedback-canary.sh \
  --kotlin-url <base-url> --go-url <base-url> --path </feedback/v1/...> \
  --output <new-json-file> [--samples 200] [--concurrency 8] [--warmup 10] \
  [--expected-status 200] [--timeout-seconds 10] [--max-p95-regression-percent 10] \
  [--unauthenticated] [--allow-http]

認証付きrequestではFEEDBACK_CANARY_BEARER_TOKENが必須です。tokenは成果物へ記録しません。
USAGE
  exit 2
}

fail() {
  echo "[feedback-canary-measure] FAIL: $*" >&2
  exit 1
}

kotlin_url=""
go_url=""
request_path=""
output=""
samples=200
concurrency=8
warmup=10
expected_status=200
timeout_seconds=10
max_p95_regression_percent=10
unauthenticated=0
allow_http=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --kotlin-url) [[ $# -ge 2 ]] || usage; kotlin_url=$2; shift 2 ;;
    --go-url) [[ $# -ge 2 ]] || usage; go_url=$2; shift 2 ;;
    --path) [[ $# -ge 2 ]] || usage; request_path=$2; shift 2 ;;
    --output) [[ $# -ge 2 ]] || usage; output=$2; shift 2 ;;
    --samples) [[ $# -ge 2 ]] || usage; samples=$2; shift 2 ;;
    --concurrency) [[ $# -ge 2 ]] || usage; concurrency=$2; shift 2 ;;
    --warmup) [[ $# -ge 2 ]] || usage; warmup=$2; shift 2 ;;
    --expected-status) [[ $# -ge 2 ]] || usage; expected_status=$2; shift 2 ;;
    --timeout-seconds) [[ $# -ge 2 ]] || usage; timeout_seconds=$2; shift 2 ;;
    --max-p95-regression-percent)
      [[ $# -ge 2 ]] || usage
      max_p95_regression_percent=$2
      shift 2
      ;;
    --unauthenticated) unauthenticated=1; shift ;;
    --allow-http) allow_http=1; shift ;;
    -h | --help) usage ;;
    *) usage ;;
  esac
done

for command_name in bash curl date jq mktemp seq xargs; do
  command -v "$command_name" >/dev/null 2>&1 || fail "$command_name が見つかりません"
done

is_integer() { [[ "$1" =~ ^[0-9]+$ ]]; }
if ! is_integer "$samples" || (( samples < 20 || samples > 100000 )); then
  fail "samplesは20以上100000以下で指定してください"
fi
if ! is_integer "$concurrency" || (( concurrency < 1 || concurrency > 256 || concurrency > samples )); then
  fail "concurrencyは1以上、samples以下、256以下で指定してください"
fi
if ! is_integer "$warmup" || (( warmup > 1000 )); then
  fail "warmupは0以上1000以下で指定してください"
fi
if ! is_integer "$expected_status" || (( expected_status < 100 || expected_status > 599 )); then
  fail "expected-statusは100以上599以下で指定してください"
fi
if ! is_integer "$timeout_seconds" || (( timeout_seconds < 1 || timeout_seconds > 300 )); then
  fail "timeout-secondsは1以上300以下で指定してください"
fi
if ! is_integer "$max_p95_regression_percent" || (( max_p95_regression_percent > 1000 )); then
  fail "max-p95-regression-percentは0以上1000以下で指定してください"
fi

[[ -n "$kotlin_url" && -n "$go_url" && -n "$request_path" && -n "$output" ]] || usage
[[ "$request_path" == /* && "$request_path" != *$'\n'* && "$request_path" != *$'\r'* ]] ||
  fail "pathは/で始まる単一行で指定してください"
[[ ! -e "$output" ]] || fail "既存の証跡を上書きしません: $output"
[[ -d "$(dirname "$output")" ]] || fail "outputの親directoryがありません: $(dirname "$output")"

validate_base_url() {
  local name=$1
  local value=$2
  [[ "$value" != */ ]] || fail "$name URLの末尾に/を付けないでください"
  [[ "$value" != *[[:space:]]* && "$value" != *@* && "$value" != *\?* && "$value" != *\#* ]] ||
    fail "$name URLには空白、userinfo、query、fragmentを指定できません"
  if [[ "$allow_http" == "1" ]]; then
    [[ "$value" == http://* || "$value" == https://* ]] || fail "$name URLはhttp/httpsで指定してください"
  else
    [[ "$value" == https://* ]] || fail "$name URLはhttpsで指定してください（局所試験だけ--allow-http可）"
  fi
}
validate_base_url Kotlin "$kotlin_url"
validate_base_url Go "$go_url"

token=${FEEDBACK_CANARY_BEARER_TOKEN:-}
if [[ "$unauthenticated" == "0" ]]; then
  [[ -n "$token" ]] || fail "FEEDBACK_CANARY_BEARER_TOKENが必要です"
  [[ "$token" =~ ^[A-Za-z0-9._~-]+$ ]] || fail "Bearer tokenの形式が不正です"
fi

temporary_root=$(mktemp -d -t feedback-canary-measure.XXXXXX)
cleanup() {
  if [[ -d "$temporary_root" && "$(basename "$temporary_root")" == feedback-canary-measure.?????? ]]; then
    rm -rf -- "$temporary_root"
  fi
}
trap cleanup EXIT

curl_config="$temporary_root/curl.conf"
{
  echo 'silent'
  echo 'show-error'
  echo "connect-timeout = $timeout_seconds"
  echo "max-time = $timeout_seconds"
  if [[ "$allow_http" == "1" ]]; then
    echo 'proto = "=http,https"'
  else
    echo 'proto = "=https"'
    echo 'tlsv1.2'
  fi
  if [[ "$unauthenticated" == "0" ]]; then
    printf 'header = "Authorization: Bearer %s"\n' "$token"
  fi
} >"$curl_config"
chmod 600 "$curl_config"
unset token FEEDBACK_CANARY_BEARER_TOKEN

probe_once() {
  local base_url=$1
  local status
  if ! status=$(curl --config "$curl_config" --request GET --output /dev/null \
      --write-out '%{http_code}' "$base_url$request_path"); then
    return 1
  fi
  [[ "$status" == "$expected_status" ]]
}

for ((index = 0; index < warmup; index++)); do
  probe_once "$kotlin_url" || fail "Kotlin warmupがexpected status $expected_statusを返しません"
  probe_once "$go_url" || fail "Go warmupがexpected status $expected_statusを返しません"
done

run_batch() {
  local base_url=$1
  local count=$2
  local raw_output=$3
  local url="$base_url$request_path"
  # shellcheck disable=SC2016 # $1/$2/resultは子bashで展開する。
  seq 1 "$count" | xargs -P "$count" -I '{}' bash -c '
    result=""
    if ! result=$(curl --config "$1" --request GET --output /dev/null \
        --write-out "%{http_code} %{time_total}" "$2"); then
      [[ -n "$result" ]] || result="000 0"
    fi
    printf "%s\n" "$result"
  ' _ "$curl_config" "$url" >>"$raw_output"
}

kotlin_raw="$temporary_root/kotlin.raw"
go_raw="$temporary_root/go.raw"
: >"$kotlin_raw"
: >"$go_raw"
started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
remaining=$samples
round=0
while (( remaining > 0 )); do
  batch=$concurrency
  (( batch > remaining )) && batch=$remaining
  if (( round % 2 == 0 )); then
    run_batch "$kotlin_url" "$batch" "$kotlin_raw"
    run_batch "$go_url" "$batch" "$go_raw"
  else
    run_batch "$go_url" "$batch" "$go_raw"
    run_batch "$kotlin_url" "$batch" "$kotlin_raw"
  fi
  (( remaining -= batch )) || true
  (( round += 1 )) || true
done
completed_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)

summarize() {
  local raw=$1
  local summary=$2
  jq -Rn --argjson expected "$expected_status" '
    [inputs
      | split(" ")
      | select(length == 2)
      | {status: (.[0] | tonumber), latencyMs: ((.[1] | tonumber) * 1000)}
    ] as $samples
    | ($samples | length) as $count
    | ($samples | map(.latencyMs) | sort) as $latencies
    | if $count == 0 then error("sampleがありません") else {
        sampleCount: $count,
        errorCount: ($samples | map(select(.status != $expected)) | length),
        errorRate: (($samples | map(select(.status != $expected)) | length) / $count),
        transportErrorCount: ($samples | map(select(.status == 0)) | length),
        transportErrorRate: (($samples | map(select(.status == 0)) | length) / $count),
        meanMs: (($latencies | add) / $count),
        p50Ms: $latencies[((($count * 50 + 99) / 100 | floor) - 1)],
        p95Ms: $latencies[((($count * 95 + 99) / 100 | floor) - 1)],
        p99Ms: $latencies[((($count * 99 + 99) / 100 | floor) - 1)],
        samples: $samples
      } end
  ' <"$raw" >"$summary"
}

kotlin_summary="$temporary_root/kotlin.json"
go_summary="$temporary_root/go.json"
summarize "$kotlin_raw" "$kotlin_summary"
summarize "$go_raw" "$go_summary"
[[ "$(jq -r '.sampleCount' "$kotlin_summary")" == "$samples" ]] || fail "Kotlin sampleが欠落しました"
[[ "$(jq -r '.sampleCount' "$go_summary")" == "$samples" ]] || fail "Go sampleが欠落しました"

artifact="$temporary_root/result.json"
jq -n \
  --arg startedAt "$started_at" \
  --arg completedAt "$completed_at" \
  --arg path "$request_path" \
  --arg kotlinBaseUrl "$kotlin_url" \
  --arg goBaseUrl "$go_url" \
  --argjson expectedStatus "$expected_status" \
  --argjson samples "$samples" \
  --argjson concurrency "$concurrency" \
  --argjson warmup "$warmup" \
  --argjson timeoutSeconds "$timeout_seconds" \
  --argjson maximumRegression "$max_p95_regression_percent" \
  --slurpfile kotlin "$kotlin_summary" \
  --slurpfile go "$go_summary" '
    ($kotlin[0]) as $k
    | ($go[0]) as $g
    | {
        schemaVersion: 1,
        startedAt: $startedAt,
        completedAt: $completedAt,
        request: {
          method: "GET", path: $path, expectedStatus: $expectedStatus,
          samples: $samples, concurrency: $concurrency, warmup: $warmup,
          timeoutSeconds: $timeoutSeconds
        },
        kotlin: ({baseUrl: $kotlinBaseUrl} + $k),
        go: ({baseUrl: $goBaseUrl} + $g),
        acceptance: {
          maximumP95RegressionPercent: $maximumRegression,
          actualP95RegressionPercent: (
            if $k.p95Ms > 0 then ((($g.p95Ms / $k.p95Ms) - 1) * 100) else null end
          ),
          passed: (
            $k.errorCount == 0 and $g.errorCount == 0 and
            $k.p95Ms > 0 and
            $g.p95Ms <= ($k.p95Ms * (1 + ($maximumRegression / 100)))
          )
        }
      }
  ' >"$artifact"
mv "$artifact" "$output"

jq '{
  kotlin: {p95Ms: .kotlin.p95Ms, errorCount: .kotlin.errorCount},
  go: {p95Ms: .go.p95Ms, errorCount: .go.errorCount},
  acceptance: .acceptance
}' "$output"
jq -e '.acceptance.passed == true' "$output" >/dev/null ||
  fail "p95またはerror gateが不合格です（証跡: $output）"
echo "[feedback-canary-measure] PASS: $output"
