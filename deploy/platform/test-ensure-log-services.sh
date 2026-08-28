#!/usr/bin/env bash

set -Eeuo pipefail

test_root="$(mktemp -d)"
export FAKE_ENSURE_ROOT="$test_root"

cleanup() {
  if [[ "$test_root" == /tmp/* || "$test_root" == /var/folders/* ]]; then
    find "$test_root" -depth -delete
  fi
}
trap cleanup EXIT

state() { printf '%s/%s' "$FAKE_ENSURE_ROOT" "$1"; }

docker() {
  local object="${1:-}" operation="${2:-}" name=''
  shift 2 || true
  case "$object:$operation" in
    info:--format)
      case "$*" in
        *ControlAvailable*) printf 'true\n' ;;
        *NodeID*) printf 'fake-manager\n' ;;
        *) return 1 ;;
      esac
      ;;
    node:inspect)
      case "$*" in
        *Status.Addr*) printf '192.168.1.103\n' ;;
        *Spec.Role*) printf 'manager\n' ;;
        *starsnap.actions-runner*) printf 'true\n' ;;
        *) return 1 ;;
      esac
      ;;
    network:inspect|secret:inspect)
      ;;
    service:inspect)
      if [[ "$*" == *'.Spec.Mode.Replicated.Replicas'* ]]; then
        name="${*: -1}"
        cat "$(state "replicas-$name")"
      else
        name="${1:-}"
        test -e "$(state "service-$name")"
      fi
      ;;
    service:create)
      local args="$*" replicas=''
      while (( $# > 0 )); do
        if [[ "$1" == --name ]]; then name="$2"; break; fi
        shift
      done
      test -n "$name"
      replicas="$(awk '{for (i=1; i<=NF; i++) if ($i == "--replicas") {print $(i+1); exit}}' <<<"$args")"
      printf '%s\n' "$args" >"$(state "create-$name")"
      : >"$(state "service-$name")"
      printf '%s\n' "$replicas" >"$(state "replicas-$name")"
      ;;
    service:scale)
      printf '%s\n' "$*" >>"$(state scales)"
      name="${1%%=*}"
      printf '%s\n' "${1#*=}" >"$(state "replicas-$name")"
      ;;
    *)
      echo "Unexpected fake docker call: $object $operation $*" >&2
      return 1
      ;;
  esac
}

node() {
  cat >/dev/null
  if test -e "$(state spec-drift)"; then
    echo 'Log service specification mismatch: injected test drift' >&2
    return 1
  fi
}

run_ensure() {
  (
    export HUB_SERVER_IMAGE='registry.example/log-server:current'
    export HUB_WEB_IMAGE='registry.example/log-web:current'
    export HUB_DB_PASSWORD_SECRET_NAME='hub-db-v1'
    export HUB_INGEST_SECRET_NAME='hub-ingest-v1'
    export CLOUDFLARE_ACCESS_TEAM_DOMAIN_SECRET_NAME='cf-team-v1'
    export CLOUDFLARE_ACCESS_AUDIENCE_SECRET_NAME='cf-audience-v1'
    source deploy/platform/ensure-log-services.sh
  )
}

run_ensure
server_args="$(cat "$(state create-starsnap-log_server)")"
web_args="$(cat "$(state create-starsnap-log_web)")"
grep -Fq -- '--name starsnap-log_server' <<<"$server_args"
grep -Fq -- '--network name=starsnap-main_app-net,alias=starsnap-log-server,alias=starsnap-hub_server' <<<"$server_args"
grep -Fq -- '--network starsnap-hub_database' <<<"$server_args"
grep -Fq -- '--publish published=8081,target=8081,protocol=tcp,mode=host' <<<"$server_args"
grep -Fq -- 'source=hub-db-v1,target=hub-db-password,uid=1000,gid=1000,mode=0400' <<<"$server_args"
grep -Fq -- '--name starsnap-log_web' <<<"$web_args"
grep -Fq -- '--network name=starsnap-main_app-net,alias=starsnap-log-web,alias=starsnap-hub_web' <<<"$web_args"

HUB_SERVER_REPLICAS=0 HUB_WEB_REPLICAS=0 run_ensure
grep -Fxq 'starsnap-log_server=0' "$(state scales)"
grep -Fxq 'starsnap-log_web=0' "$(state scales)"
scale_count="$(wc -l <"$(state scales)")"
HUB_SERVER_REPLICAS=0 HUB_WEB_REPLICAS=0 run_ensure
test "$(wc -l <"$(state scales)")" -eq "$scale_count"

: >"$(state spec-drift)"
drift_output="$(state drift-output)"
set +e
run_ensure >"$drift_output" 2>&1
drift_status=$?
set -e
test "$drift_status" -ne 0
grep -Fq 'Log service specification mismatch: injected test drift' "$drift_output"
rm "$(state spec-drift)"

find "$FAKE_ENSURE_ROOT" -mindepth 1 -delete
LOG_SERVER_SERVICE_NAME='starsnap-log-server' \
LOG_WEB_SERVICE_NAME='starsnap-log-web' \
LOG_SERVER_ALIASES='starsnap-hub_server' LOG_WEB_ALIASES='starsnap-hub_web' \
LOG_SERVER_PUBLISH_PORT=false run_ensure
legacy_server_args="$(cat "$(state create-starsnap-log-server)")"
legacy_web_args="$(cat "$(state create-starsnap-log-web)")"
grep -Fq -- '--name starsnap-log-server' <<<"$legacy_server_args"
grep -Fq -- '--network name=starsnap-main_app-net,alias=starsnap-hub_server' <<<"$legacy_server_args"
if grep -Fq -- '--publish' <<<"$legacy_server_args"; then exit 1; fi
grep -Fq -- '--name starsnap-log-web' <<<"$legacy_web_args"
grep -Fq -- '--network name=starsnap-main_app-net,alias=starsnap-hub_web' <<<"$legacy_web_args"

echo 'Ensure Log services tests passed.'
