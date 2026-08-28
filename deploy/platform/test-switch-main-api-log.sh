#!/usr/bin/env bash

set -Eeuo pipefail

test_root="$(mktemp -d)"
export FAKE_LOG_ROUTE_ROOT="$test_root"
export FAKE_HUB_REPLICAS="1/1"
export FAKE_API_UPDATE_STATE="completed"
readonly marker_name="starsnap-main-api-log-route-pre-20260827"
readonly old_line="SERVER_LOG_BASE_URL=http://192.168.1.2:8081"
readonly new_line="SERVER_LOG_BASE_URL=http://starsnap-log_server:8081"
export marker_name old_line new_line

cleanup() {
  if [[ "$test_root" == /tmp/* || "$test_root" == /var/folders/* ]]; then
    find "$test_root" -depth -delete
  fi
}
trap cleanup EXIT

fake_env_file() {
  printf '%s/service-env' "$FAKE_LOG_ROUTE_ROOT"
}

fake_marker_file() {
  printf '%s/marker' "$FAKE_LOG_ROUTE_ROOT"
}

docker() {
  local object="${1:-}" operation="${2:-}" label value target=""
  shift 2 || true
  case "$object:$operation" in
    service:inspect)
      target="${*: -1}"
      if [[ "$target" != "starsnap-main_api" ]]; then
        return 0
      fi
      case "$*" in
        *ContainerSpec.Env*)
          if [[ -s "$(fake_env_file)" ]]; then
            cat "$(fake_env_file)"
          fi
          ;;
        *Replicated.Replicas*) printf '1\n' ;;
        *UpdateStatus*) printf '%s\n' "$FAKE_API_UPDATE_STATE" ;;
      esac
      ;;
    service:ls)
      case "$*" in
        *starsnap-main_api*) printf 'starsnap-main_api 1/1\n' ;;
        *starsnap-log_server*) printf 'starsnap-log_server %s\n' "$FAKE_HUB_REPLICAS" ;;
      esac
      ;;
    service:update)
      while (( $# > 0 )); do
        case "$1" in
          --env-rm)
            : >"$(fake_env_file)"
            shift 2
            ;;
          --env-add)
            printf '%s\n' "$2" >"$(fake_env_file)"
            shift 2
            ;;
          *) shift ;;
        esac
      done
      ;;
    service:ps|service:logs)
      ;;
    config:inspect)
      if [[ ! -f "$(fake_marker_file)" ]]; then
        return 1
      fi
      case "$*" in
        *previous-present*) cat "$FAKE_LOG_ROUTE_ROOT/previous-present" ;;
        *previous-url*) cat "$FAKE_LOG_ROUTE_ROOT/previous-url" ;;
      esac
      ;;
    config:create)
      while (( $# > 0 )); do
        case "$1" in
          --label)
            label="${2%%=*}"
            value="${2#*=}"
            case "$label" in
              com.starsnap.previous-present)
                printf '%s\n' "$value" >"$FAKE_LOG_ROUTE_ROOT/previous-present"
                ;;
              com.starsnap.previous-url)
                printf '%s\n' "$value" >"$FAKE_LOG_ROUTE_ROOT/previous-url"
                ;;
            esac
            shift 2
            ;;
          -) shift ;;
          *) target="$1"; shift ;;
        esac
      done
      test "$target" = "$marker_name"
      cat >"$(fake_marker_file)"
      ;;
    config:rm)
      find "$FAKE_LOG_ROUTE_ROOT" -maxdepth 1 -type f \
        \( -name marker -o -name previous-present -o -name previous-url \) \
        -delete
      ;;
    ps:*)
      if [[ "$*" == *"com.docker.swarm.service.name=starsnap-main_api"* ]]; then
        printf 'api-container\n'
      elif [[ "$*" == *"com.docker.swarm.service.name=starsnap-erp_web"* ]]; then
        printf 'probe-container\n'
      else
        return 1
      fi
      ;;
    inspect:*)
      target="${*: -1}"
      if [[ "$target" != "api-container" ]]; then
        return 1
      fi
      if [[ -f "$FAKE_LOG_ROUTE_ROOT/fail-api-inspect" ]]; then
        return 1
      fi
      if [[ -s "$(fake_env_file)" ]]; then
        cat "$(fake_env_file)"
      fi
      ;;
    exec:*)
      if [[ -f "$FAKE_LOG_ROUTE_ROOT/fail-target-health" ]] \
        && [[ "$(cat "$(fake_env_file)")" == "$new_line" ]]; then
        return 1
      fi
      ;;
    *)
      printf 'Unexpected fake docker call: %s %s %s\n' "$object" "$operation" "$*" >&2
      return 2
      ;;
  esac
}

sleep() {
  SECONDS=$((SECONDS + 60))
}

export -f docker sleep fake_env_file fake_marker_file

grep -Fq 'headers: { Host: "api.starsnap.kr" }' \
  deploy/platform/switch-main-api-log.sh
grep -Fq 'hostname: "starsnap-main_api"' \
  deploy/platform/switch-main-api-log.sh

printf '%s\n' "$old_line" >"$(fake_env_file)"
ALLOW_API_LOG_ROUTE=SWITCH-MAIN-API-LOG \
  bash deploy/platform/switch-main-api-log.sh switch >/dev/null
test "$(cat "$(fake_env_file)")" = "$new_line"
test -f "$(fake_marker_file)"

ALLOW_API_LOG_ROUTE=SWITCH-MAIN-API-LOG \
  bash deploy/platform/switch-main-api-log.sh switch >/dev/null
test "$(cat "$(fake_env_file)")" = "$new_line"

export FAKE_HUB_REPLICAS="0/1"
ALLOW_API_LOG_ROUTE=RESTORE-MAIN-API-LOG \
  bash deploy/platform/switch-main-api-log.sh restore >/dev/null
test "$(cat "$(fake_env_file)")" = "$old_line"
test ! -f "$(fake_marker_file)"

if ALLOW_API_LOG_ROUTE=SWITCH-MAIN-API-LOG \
  bash deploy/platform/switch-main-api-log.sh switch >/dev/null 2>&1; then
  echo 'Switch should fail while the target Hub is unavailable.' >&2
  exit 1
fi
export FAKE_HUB_REPLICAS="1/1"

export FAKE_API_UPDATE_STATE="updating"
STARSNAP_API_LOG_ROUTE_STABLE_OBSERVATIONS=2 \
ALLOW_API_LOG_ROUTE=SWITCH-MAIN-API-LOG \
  bash deploy/platform/switch-main-api-log.sh switch >/dev/null
test "$(cat "$(fake_env_file)")" = "$new_line"
test -f "$(fake_marker_file)"
if STARSNAP_API_LOG_ROUTE_TIMEOUT_SECONDS=1 \
  ALLOW_API_LOG_ROUTE=RESTORE-MAIN-API-LOG \
  bash deploy/platform/switch-main-api-log.sh restore >/dev/null 2>&1; then
  echo 'Restore should not finish while the Swarm update is nonterminal.' >&2
  exit 1
fi
test -f "$(fake_marker_file)"
export FAKE_API_UPDATE_STATE="completed"
ALLOW_API_LOG_ROUTE=RESTORE-MAIN-API-LOG \
  bash deploy/platform/switch-main-api-log.sh restore >/dev/null
test "$(cat "$(fake_env_file)")" = "$old_line"
test ! -f "$(fake_marker_file)"

: >"$(fake_env_file)"
ALLOW_API_LOG_ROUTE=SWITCH-MAIN-API-LOG \
  bash deploy/platform/switch-main-api-log.sh switch >/dev/null
test "$(cat "$(fake_env_file)")" = "$new_line"
test -f "$(fake_marker_file)"
touch "$FAKE_LOG_ROUTE_ROOT/fail-api-inspect"
if STARSNAP_API_LOG_ROUTE_TIMEOUT_SECONDS=1 \
  ALLOW_API_LOG_ROUTE=RESTORE-MAIN-API-LOG \
  bash deploy/platform/switch-main-api-log.sh restore >/dev/null 2>&1; then
  echo 'Restore should fail when the running API container cannot be inspected.' >&2
  exit 1
fi
test -f "$(fake_marker_file)"
rm "$FAKE_LOG_ROUTE_ROOT/fail-api-inspect"
ALLOW_API_LOG_ROUTE=RESTORE-MAIN-API-LOG \
  bash deploy/platform/switch-main-api-log.sh restore >/dev/null
test ! -s "$(fake_env_file)"
test ! -f "$(fake_marker_file)"

printf '%s\n' "$old_line" >"$(fake_env_file)"
touch "$FAKE_LOG_ROUTE_ROOT/fail-target-health"
export FAKE_API_UPDATE_STATE="updating"
if STARSNAP_API_LOG_ROUTE_TIMEOUT_SECONDS=1 \
  ALLOW_API_LOG_ROUTE=SWITCH-MAIN-API-LOG \
  bash deploy/platform/switch-main-api-log.sh switch >/dev/null 2>&1; then
  echo 'Switch should fail when both target verification and rollback completion fail.' >&2
  exit 1
fi
test "$(cat "$(fake_env_file)")" = "$old_line"
test -f "$(fake_marker_file)"
rm "$FAKE_LOG_ROUTE_ROOT/fail-target-health"
export FAKE_API_UPDATE_STATE="completed"
ALLOW_API_LOG_ROUTE=SWITCH-MAIN-API-LOG \
  bash deploy/platform/switch-main-api-log.sh switch >/dev/null
test "$(cat "$(fake_env_file)")" = "$new_line"
test -f "$(fake_marker_file)"
ALLOW_API_LOG_ROUTE=RESTORE-MAIN-API-LOG \
  bash deploy/platform/switch-main-api-log.sh restore >/dev/null
test "$(cat "$(fake_env_file)")" = "$old_line"
test ! -f "$(fake_marker_file)"

printf '%s\n' "$new_line" >"$(fake_env_file)"
if ALLOW_API_LOG_ROUTE=RESTORE-MAIN-API-LOG \
  bash deploy/platform/switch-main-api-log.sh restore >/dev/null 2>&1; then
  echo 'Restore should fail when the target route has no rollback marker.' >&2
  exit 1
fi
if ALLOW_API_LOG_ROUTE=SWITCH-MAIN-API-LOG \
  bash deploy/platform/switch-main-api-log.sh switch >/dev/null 2>&1; then
  echo 'Switch should fail when the target route has no rollback marker.' >&2
  exit 1
fi

printf '%s\n' "$old_line" >"$(fake_env_file)"
touch "$FAKE_LOG_ROUTE_ROOT/fail-target-health"
if ALLOW_API_LOG_ROUTE=SWITCH-MAIN-API-LOG \
  bash deploy/platform/switch-main-api-log.sh switch >/dev/null 2>&1; then
  echo 'Switch should fail when target API health verification fails.' >&2
  exit 1
fi
test "$(cat "$(fake_env_file)")" = "$old_line"
test ! -f "$(fake_marker_file)"

echo 'switch-main-api-log tests passed'
