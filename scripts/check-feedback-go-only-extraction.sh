#!/usr/bin/env bash
# Kotlin/JDK/Gradleを含まない最終候補をclean directoryで検証する。
set -euo pipefail

ROOT=$(git rev-parse --show-toplevel)
cd "$ROOT"
temporary_root=$(mktemp -d -t feedback-go-only-extraction.XXXXXX)
no_java_bin=$(mktemp -d -t feedback-no-java.XXXXXX)
image_container=""

cleanup() {
  if [[ -n "$image_container" ]]; then
    docker rm -f "$image_container" >/dev/null 2>&1 || true
  fi
  for target in "$temporary_root" "$no_java_bin"; do
    case "$(basename "$target")" in
      feedback-go-only-extraction.?????? | feedback-no-java.??????)
        [[ -d "$target" ]] && rm -rf -- "$target"
        ;;
    esac
  done
}
trap cleanup EXIT

repository="$temporary_root/repository"
mkdir -p "$repository"
bash scripts/assemble-feedback-repository --output "$repository" --go-only >/dev/null

[[ ! -e "$repository/apps/feedback-service" ]] || { echo "Kotlin serviceがGo-only抽出物へ混入しました" >&2; exit 1; }
[[ -f "$repository/apps/feedback-service-go/migrations/baseline/V1__feedback_baseline.sql" ]] || {
  echo "Go-only fresh baselineがありません" >&2
  exit 1
}
if find "$repository" -type f \( -name '*.kt' -o -name '*.kts' -o -name 'gradlew' -o -name 'gradlew.bat' \) \
    -print -quit | grep -q .; then
  echo "Kotlin/Gradle sourceがGo-only抽出物へ混入しました" >&2
  exit 1
fi
if rg -n 'apps/feedback-service/Dockerfile|eclipse-temurin|openjdk|gradle:' \
    "$repository/deploy" "$repository"/apps/*/Dockerfile; then
  echo "Go-only build/runtime経路にKotlin/JDK参照があります" >&2
  exit 1
fi

# runnerにJavaが偶然存在しても呼べないよう、先頭PATHへ常に失敗するstubを置く。
false_binary=$(type -P false)
[[ -x "$false_binary" ]] || { echo "false commandが見つかりません" >&2; exit 1; }
ln -s "$false_binary" "$no_java_bin/java"
(
  cd "$repository"
  npm ci --ignore-scripts --no-audit --no-fund
  PATH="$no_java_bin:$PATH" FEEDBACK_VERIFY_SKIP_NPM_CI=1 bash scripts/verify-feedback.sh

  docker build --no-cache -f apps/feedback-service-go/Dockerfile -t feedback-service-go:go-only-extraction-test .
  go_image_size=$(docker image inspect feedback-service-go:go-only-extraction-test --format '{{.Size}}')
  ((go_image_size <= 104857600)) || {
    echo "Go runtime imageが100MBを超えています: $go_image_size bytes" >&2
    exit 1
  }
  [[ "$(docker image inspect feedback-service-go:go-only-extraction-test --format '{{.Config.User}}')" == "65532:65532" ]] || {
    echo "Go runtime imageがnon-root UID/GID 65532ではありません" >&2
    exit 1
  }
  image_container=$(docker create feedback-service-go:go-only-extraction-test)
  image_root="$temporary_root/image-root"
  mkdir -p "$image_root" "$image_root/data"
  docker cp "$image_container:/app/." "$image_root/"
  docker cp "$image_container:/data/." "$image_root/data/"
  docker cp "$image_container:/etc/ssl/certs/ca-certificates.crt" "$image_root/ca-certificates.crt"
  docker cp "$image_container:/usr/share/zoneinfo/Etc/UTC" "$image_root/timezone-utc"
  [[ -s "$image_root/ca-certificates.crt" && -s "$image_root/timezone-utc" ]] || {
    echo "Go runtime imageにCA証明書またはtimezone dataがありません" >&2
    exit 1
  }
  if docker export "$image_container" | tar -tf - | \
      rg -x 'bin/(sh|bash)|usr/bin/(sh|bash)|sbin/apk|usr/bin/apt(-get)?'; then
    echo "Go runtime imageへshellまたはpackage managerが混入しています" >&2
    exit 1
  fi
  for name in feedback-service feedback-notification-worker feedback-export-worker \
    feedback-retention-worker feedback-bootstrap feedback-connector-register \
    feedback-connector-runtime feedback-backup-pull feedback-legacy-migration feedback-migrate; do
    [[ -x "$image_root/bin/$name" ]] || { echo "entrypointが実行可能ではありません: $name" >&2; exit 1; }
  done
  for directory in evidence exports connector; do
    [[ -d "$image_root/data/$directory" ]] || { echo "書込みvolume mount pointがありません: $directory" >&2; exit 1; }
  done
  docker rm "$image_container" >/dev/null
  image_container=""
  docker compose --env-file deploy/.env.example -f deploy/compose.yaml config --quiet
  PATH="$no_java_bin:$PATH" FEEDBACK_SMOKE_PROJECT=feedback-go-only-extraction-smoke \
    bash scripts/smoke-feedback-standalone.sh
)

echo "[feedback-go-only-extraction] PASS: JDKなしでclean build/test/smokeを完走しました"
