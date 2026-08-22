#!/bin/sh
set -eu

enabled=${FEEDBACK_REDMINE_ENABLED:-false}
profile_id=${FEEDBACK_REDMINE_PROFILE_ID:-disabled}
gateway_base_path=${FEEDBACK_REDMINE_GATEWAY_BASE_PATH:-/internal/feedback-redmine/v1}

case "$enabled" in
  true|false) ;;
  *) echo "FEEDBACK_REDMINE_ENABLEDはtrueまたはfalseで指定してください" >&2; exit 1 ;;
esac

case "$profile_id" in
  *[!A-Za-z0-9._-]*|'') echo "FEEDBACK_REDMINE_PROFILE_IDが不正です" >&2; exit 1 ;;
esac

case "$gateway_base_path" in
  /*) ;;
  *) echo "FEEDBACK_REDMINE_GATEWAY_BASE_PATHはroot-relative pathで指定してください" >&2; exit 1 ;;
esac
case "$gateway_base_path" in
  *[!A-Za-z0-9._/-]*) echo "FEEDBACK_REDMINE_GATEWAY_BASE_PATHに不正な文字があります" >&2; exit 1 ;;
esac

runtime_config_dir=/usr/share/nginx/html/.well-known
mkdir -p "$runtime_config_dir"
printf '{"schemaVersion":"1","enabled":%s,"profileId":"%s","gatewayBasePath":"%s"}\n' \
  "$enabled" "$profile_id" "$gateway_base_path" \
  >"$runtime_config_dir/feedback-redmine.json"
