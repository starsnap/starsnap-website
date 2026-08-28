#!/usr/bin/env bash

set -Eeuo pipefail

test_root="$(mktemp -d)"
export FAKE_RENAME_ROOT="$test_root"

cleanup() {
  if [[ "$test_root" == /tmp/* || "$test_root" == /var/folders/* ]]; then
    find "$test_root" -depth -delete
  fi
}
trap cleanup EXIT

state() { printf '%s/%s' "$FAKE_RENAME_ROOT" "$1"; }
write_state() { printf '%s\n' "$2" >"$(state "$1")"; }
read_state() { cat "$(state "$1")"; }
record_event() { printf '%s\n' "$1" >>"$(state events)"; }

reset_state() {
  local route_result="$1" caddy_update_mode="$2" server_remove_mode="$3"
  local port_add_mode="$4" source_restore_mode="${5:-normal}"
  local post_caddy_source_health="${6:-normal}"
  local target_ensure_mode="${7:-normal}" initial_caddy_config="${8:-starsnap-company_caddyfile_previous}"
  local manager_health_result="${9:-pass}"
  find "$FAKE_RENAME_ROOT" -mindepth 1 -delete
  write_state old-server 1
  write_state old-web 1
  write_state new-server 0
  write_state new-web 0
  write_state target-port 0
  write_state caddy-config "$initial_caddy_config"
  write_state caddy-hash "$(printf '1%.0s' {1..64})"
  write_state caddy-state completed
  write_state config-exists 0
  write_state route-result "$route_result"
  write_state caddy-update-mode "$caddy_update_mode"
  write_state server-remove-mode "$server_remove_mode"
  write_state port-add-mode "$port_add_mode"
  write_state source-restore-mode "$source_restore_mode"
  write_state post-caddy-source-health "$post_caddy_source_health"
  write_state target-ensure-mode "$target_ensure_mode"
  write_state manager-health-result "$manager_health_result"
  : >"$(state events)"
}

present() {
  case "$1" in
    starsnap-log-server) test "$(read_state old-server)" = 1 ;;
    starsnap-log-web) test "$(read_state old-web)" = 1 ;;
    starsnap-log_server) test "$(read_state new-server)" = 1 ;;
    starsnap-log_web) test "$(read_state new-web)" = 1 ;;
    starsnap-company_caddy) return 0 ;;
    *) return 1 ;;
  esac
}

container_for() {
  case "$1" in
    starsnap-log-server) printf 'old-server-container\n' ;;
    starsnap-log-web) printf 'old-web-container\n' ;;
    starsnap-log_server) printf 'new-server-container\n' ;;
    starsnap-log_web) printf 'new-web-container\n' ;;
    starsnap-company_caddy) printf 'caddy-container\n' ;;
  esac
}

sha256sum() {
  if (( $# > 0 )); then printf '%064d  %s\n' 10 "$1"; return; fi
  cat >/dev/null
  printf '%s  -\n' "$(read_state caddy-hash)"
}

docker() {
  local object="${1:-}" operation="${2:-}" target='' format='' service=''
  shift 2 || true
  case "$object:$operation" in
    service:inspect)
      target="${*: -1}"
      case "$*" in
        *'.Spec.TaskTemplate.ContainerSpec.Image'*)
          if [[ "$target" == starsnap-log_* && -e "$(state local-target-images)" ]]; then
            case "$target" in
              *server) printf 'starsnap.invalid/platform/log-server:sha-current\n' ;;
              *web) printf 'starsnap.invalid/platform/log-web:sha-current\n' ;;
            esac
            return 0
          fi
          case "$target" in
            *server) printf '%s\n' "$FAKE_SERVER_IMAGE" ;;
            *web) printf '%s\n' "$FAKE_WEB_IMAGE" ;;
          esac
          ;;
        *'.UpdateStatus'*)
          if [[ "$target" == starsnap-company_caddy ]]; then read_state caddy-state; else printf 'completed\n'; fi
          ;;
        *'json .Spec.TaskTemplate'*) printf '{"hash":"%s"}\n' "$(read_state caddy-hash)" ;;
        *'.Spec.TaskTemplate.ContainerSpec.Configs'*) read_state caddy-config ;;
        *'.Endpoint.Ports'*)
          if [[ "$(read_state target-port)" = 1 ]]; then printf '8081\n'; fi
          ;;
        *) present "$target" ;;
      esac
      ;;
    service:ls)
      if [[ "$*" == *--filter* ]]; then
        for candidate in starsnap-log-server starsnap-log-web starsnap-log_server starsnap-log_web starsnap-company_caddy; do
          if [[ "$*" == *"$candidate"* ]] && present "$candidate"; then printf '%s 1/1\n' "$candidate"; fi
        done
      else
        for candidate in starsnap-log-server starsnap-log-web starsnap-log_server starsnap-log_web starsnap-company_caddy; do
          present "$candidate" && printf '%s\n' "$candidate"
        done
      fi
      ;;
    service:update)
      target="${*: -1}"
      if [[ "$target" == starsnap-company_caddy ]]; then
        write_state caddy-config starsnap-company_caddyfile_0000000000000000
        write_state caddy-hash "$(printf '2%.0s' {1..64})"
        write_state caddy-state completed
        record_event caddy-update
        if [[ "$(read_state caddy-update-mode)" == ambiguous ]]; then return 1; fi
      elif [[ "$target" == starsnap-log_server && "$*" == *--publish-add* ]]; then
        write_state target-port 1
        record_event target-port-add
        if [[ "$(read_state port-add-mode)" == ambiguous ]]; then return 1; fi
      elif [[ "$target" == starsnap-log_server && "$*" == *--publish-rm* ]]; then
        write_state target-port 0
        record_event target-port-remove
      elif [[ "$target" == starsnap-log_web && "$*" == *--network-add* ]]; then
        grep -Fq -- 'name=starsnap-main_app-net,alias=starsnap-log-web,alias=starsnap-hub_web' <<<"$*"
        record_event target-web-aliases-add
      elif [[ "$target" == starsnap-log_server && "$*" == *--network-add* ]]; then
        grep -Fq -- 'name=starsnap-main_app-net,alias=starsnap-log-server,alias=starsnap-hub_server' <<<"$*"
        record_event target-server-aliases-add
      else
        return 1
      fi
      ;;
    service:rollback)
      write_state caddy-config starsnap-company_caddyfile_previous
      write_state caddy-hash "$(printf '1%.0s' {1..64})"
      write_state caddy-state rollback_completed
      record_event caddy-rollback
      ;;
    service:rm)
      target="${1:-}"
      case "$target" in
        starsnap-log-web) write_state old-web 0; record_event old-web-remove ;;
        starsnap-log-server)
          write_state old-server 0
          record_event old-server-remove
          if [[ "$(read_state server-remove-mode)" == ambiguous ]]; then return 1; fi
          ;;
        starsnap-log_web) write_state new-web 0; record_event new-web-remove ;;
        starsnap-log_server) write_state new-server 0; write_state target-port 0; record_event new-server-remove ;;
        *) return 1 ;;
      esac
      ;;
    service:ps|service:logs)
      ;;
    ps:--filter)
      for candidate in starsnap-log-server starsnap-log-web starsnap-log_server starsnap-log_web starsnap-company_caddy; do
        if [[ "$*" == *"$candidate"* ]] && present "$candidate"; then container_for "$candidate"; fi
      done
      ;;
    inspect:--format)
      format="${1:-}"
      target="${2:-}"
      case "$format" in
        *State.Health*)
          if [[ "$target" == old-server-container \
            && "$(read_state post-caddy-source-health)" == degrade \
            && -e "$(state events)" ]] \
            && grep -Fxq caddy-rollback "$(state events)"; then
            printf 'unhealthy\n'
          else
            printf 'healthy\n'
          fi
          ;;
        '{{.Image}}')
          case "$target" in
            *server*) printf 'sha256:server-id\n' ;;
            *web*) printf 'sha256:web-id\n' ;;
          esac
          ;;
        *) return 1 ;;
      esac
      ;;
    image:inspect)
      target="${*: -1}"
      case "$target" in
        *server*) printf 'sha256:server-id\n' ;;
        *web*) printf 'sha256:web-id\n' ;;
        *) return 1 ;;
      esac
      ;;
    exec:*)
      target="$operation"
      if [[ "$target" == caddy-container && "$*" == *"https://127.0.0.1/"* ]]; then
        if [[ "$(read_state route-result)" == pass ]]; then printf '<title>StarSnap Log Dashboard</title>\n'; else return 1; fi
      elif [[ "$target" == caddy-container && "$*" == *"starsnap-log_web"* ]]; then
        grep -Fq -- '--header=Host: log.starsnap.kr' <<<"$*"
        printf '<title>StarSnap Log Dashboard</title>\n'
      elif [[ "$target" == caddy-container && "$*" == *"starsnap-log_server"* ]]; then
        grep -Fq -- '--header=Host: log.starsnap.kr' <<<"$*"
        printf '{"status":"UP"}\n'
      else
        return 0
      fi
      ;;
    pull:*)
      ;;
    run:*)
      if [[ "$*" == *'actuator/health'* ]]; then
        grep -Fq -- '--network host' <<<"$*"
        grep -Fq -- '--entrypoint wget' <<<"$*"
        grep -Fq -- '--timeout=30 --tries=1' <<<"$*"
        grep -Fq -- 'http://127.0.0.1:8081/actuator/health' <<<"$*"
        if [[ "$(read_state manager-health-result)" != pass ]]; then return 1; fi
        printf '{"status":"UP"}\n'
      fi
      ;;
    config:ls)
      if [[ "$(read_state config-exists)" = 1 ]]; then printf 'starsnap-company_caddyfile_0000000000000000\n'; fi
      ;;
    config:create)
      write_state config-exists 1
      record_event config-create
      ;;
    config:inspect)
      if [[ "$(read_state config-exists)" != 1 ]]; then return 1; fi
      if [[ "$*" == *com.starsnap.config-sha256* ]]; then printf '%064d\n' 10; fi
      ;;
    config:rm)
      write_state config-exists 0
      record_event config-remove
      ;;
    *)
      echo "Unexpected fake docker call: $object $operation $*" >&2
      return 1
      ;;
  esac
}

bash() {
  if [[ "${1:-}" == deploy/platform/validate-platform.sh ]]; then return 0; fi
  if [[ "${1:-}" == deploy/platform/ensure-log-services.sh ]]; then
    if [[ "${LOG_SERVER_SERVICE_NAME:-}" == starsnap-log_server ]]; then
      if [[ -z "${LOG_SERVER_ALIASES:-}" && -z "${LOG_WEB_ALIASES:-}" ]]; then
        write_state new-server 1
        write_state new-web 1
        record_event targets-create
        if [[ "$(read_state target-ensure-mode)" == fail ]]; then return 1; fi
      else
        test "${LOG_SERVER_ALIASES:-}" = 'starsnap-log-server,starsnap-hub_server'
        test "${LOG_WEB_ALIASES:-}" = 'starsnap-log-web,starsnap-hub_web'
        test "$(read_state new-server)" = 1
        test "$(read_state new-web)" = 1
        record_event target-aliases-verified
      fi
    else
      test "${LOG_SERVER_ALIASES:-}" = 'starsnap-hub_server'
      test "${LOG_WEB_ALIASES:-}" = 'starsnap-hub_web'
      if [[ "$(read_state source-restore-mode)" == fail ]]; then return 1; fi
      write_state old-server 1
      write_state old-web 1
      record_event sources-restore
    fi
    return 0
  fi
  command bash "$@"
}

wget() { printf '{"status":"UP"}\n'; }
curl() {
  grep -Fq -- '--noproxy *' <<<"$*"
  grep -Fq -- '--connect-timeout 10' <<<"$*"
  grep -Fq -- '--max-time 30' <<<"$*"
  grep -Fq -- '--resolve log.starsnap.kr:443:192.168.1.103' <<<"$*"
  grep -Fq -- 'https://log.starsnap.kr/' <<<"$*"
  if [[ "$(read_state route-result)" == pass ]]; then
    printf '<title>StarSnap Log Dashboard</title>\n'
  else
    return 1
  fi
}
sleep() { :; }

run_rename() {
  local output_file="$1"
  (
    export ALLOW_LOG_SERVICE_RENAME='RENAME-LOG-SERVICES-192.168.1.103'
    export HUB_DB_PASSWORD_SECRET_NAME=hub-db-v1
    export HUB_INGEST_SECRET_NAME=hub-ingest-v1
    export CLOUDFLARE_ACCESS_TEAM_DOMAIN_SECRET_NAME=cf-team-v1
    export CLOUDFLARE_ACCESS_AUDIENCE_SECRET_NAME=cf-audience-v1
    export HUB_SERVER_IMAGE="$FAKE_SERVER_IMAGE"
    export HUB_WEB_IMAGE="$FAKE_WEB_IMAGE"
    source deploy/platform/rename-log-services.sh
  ) >"$output_file" 2>&1
}

assert_contains() {
  grep -Fq "$2" "$1" || {
    echo "Expected $1 to contain: $2" >&2
    sed -n '1,280p' "$1" >&2
    exit 1
  }
}

readonly FAKE_SERVER_IMAGE='starsnap.invalid/log-server:current'
readonly FAKE_WEB_IMAGE='starsnap.invalid/log-web:current'
export FAKE_SERVER_IMAGE FAKE_WEB_IMAGE

reset_state pass normal normal normal
success_output="$(state success.out)"
run_rename "$success_output"
test "$(read_state old-server)" = 0
test "$(read_state old-web)" = 0
test "$(read_state new-server)" = 1
test "$(read_state new-web)" = 1
test "$(read_state target-port)" = 1
test "$(read_state caddy-config)" = starsnap-company_caddyfile_0000000000000000
assert_contains "$(state events)" target-web-aliases-add
assert_contains "$(state events)" target-server-aliases-add
assert_contains "$success_output" 'Log service rename verified: starsnap-log-server -> starsnap-log_server, starsnap-log-web -> starsnap-log_web'

reset_state fail normal normal normal
route_failure_output="$(state route-failure.out)"
set +e
run_rename "$route_failure_output"
route_failure_status=$?
set -e
test "$route_failure_status" -ne 0
test "$(read_state old-server)" = 1
test "$(read_state old-web)" = 1
test "$(read_state new-server)" = 0
test "$(read_state new-web)" = 0
test "$(read_state caddy-config)" = starsnap-company_caddyfile_previous
assert_contains "$(state events)" caddy-rollback
assert_contains "$route_failure_output" 'Log service rename rollback verified.'

reset_state pass normal ambiguous normal
remove_failure_output="$(state remove-failure.out)"
set +e
run_rename "$remove_failure_output"
remove_failure_status=$?
set -e
test "$remove_failure_status" -ne 0
test "$(read_state old-server)" = 1
test "$(read_state old-web)" = 1
test "$(read_state new-server)" = 0
test "$(read_state new-web)" = 0
assert_contains "$(state events)" sources-restore
assert_contains "$(state events)" caddy-rollback

reset_state pass normal normal ambiguous
port_failure_output="$(state port-failure.out)"
set +e
run_rename "$port_failure_output"
port_failure_status=$?
set -e
test "$port_failure_status" -ne 0
test "$(read_state old-server)" = 1
test "$(read_state old-web)" = 1
test "$(read_state new-server)" = 0
test "$(read_state new-web)" = 0
test "$(read_state target-port)" = 0
assert_contains "$(state events)" target-port-remove

reset_state pass normal normal ambiguous fail
restore_failure_output="$(state restore-failure.out)"
set +e
run_rename "$restore_failure_output"
restore_failure_status=$?
set -e
test "$restore_failure_status" -ne 0
test "$(read_state new-server)" = 1
test "$(read_state new-web)" = 1
test "$(read_state caddy-config)" = starsnap-company_caddyfile_0000000000000000
assert_contains "$restore_failure_output" 'Keeping new Log services online because rollback dependencies are not healthy.'
assert_contains "$restore_failure_output" 'CRITICAL: Log service rename rollback could not be fully verified.'

reset_state pass normal normal ambiguous normal degrade
stale_health_output="$(state stale-health.out)"
set +e
run_rename "$stale_health_output"
stale_health_status=$?
set -e
test "$stale_health_status" -ne 0
test "$(read_state new-server)" = 1
test "$(read_state new-web)" = 1
test "$(read_state caddy-config)" = starsnap-company_caddyfile_previous
assert_contains "$stale_health_output" 'Keeping new Log services online because rollback dependencies changed health.'
assert_contains "$stale_health_output" 'CRITICAL: Log service rename rollback could not be fully verified.'

reset_state pass normal normal normal normal normal fail starsnap-company_caddyfile_0000000000000000
precutover_caddy_output="$(state precutover-caddy.out)"
set +e
run_rename "$precutover_caddy_output"
precutover_caddy_status=$?
set -e
test "$precutover_caddy_status" -ne 0
test "$(read_state new-server)" = 1
test "$(read_state new-web)" = 1
test "$(read_state caddy-config)" = starsnap-company_caddyfile_0000000000000000
assert_contains "$precutover_caddy_output" 'Keeping new Log services online because rollback dependencies are not healthy.'
assert_contains "$precutover_caddy_output" 'CRITICAL: Log service rename rollback could not be fully verified.'

reset_state pass normal normal normal
write_state old-server 0
write_state new-server 1
write_state new-web 1
write_state caddy-config starsnap-company_caddyfile_0000000000000000
: >"$(state local-target-images)"
resume_output="$(state resume.out)"
run_rename "$resume_output"
test "$(read_state old-server)" = 0
test "$(read_state old-web)" = 0
test "$(read_state new-server)" = 1
test "$(read_state new-web)" = 1
test "$(read_state target-port)" = 1
test "$(read_state caddy-config)" = starsnap-company_caddyfile_0000000000000000
assert_contains "$resume_output" 'Resuming Log rename from verified exact-name services and Caddy route.'
assert_contains "$resume_output" 'Log service rename verified: starsnap-log-server -> starsnap-log_server, starsnap-log-web -> starsnap-log_web'

reset_state pass normal normal normal
write_state old-server 0
write_state old-web 0
write_state new-server 1
write_state new-web 1
write_state target-port 1
write_state caddy-config starsnap-company_caddyfile_0000000000000000
resume_with_port_output="$(state resume-with-port.out)"
run_rename "$resume_with_port_output"
test "$(read_state new-server)" = 1
test "$(read_state new-web)" = 1
test "$(read_state target-port)" = 1
if grep -Fxq target-port-add "$(state events)"; then exit 1; fi
assert_contains "$resume_with_port_output" 'Log service rename verified: starsnap-log-server -> starsnap-log_server, starsnap-log-web -> starsnap-log_web'

reset_state pass normal normal normal normal normal normal starsnap-company_caddyfile_0000000000000000 fail
write_state old-server 0
write_state new-server 1
write_state new-web 1
write_state target-port 1
resume_port_failure_output="$(state resume-port-failure.out)"
set +e
run_rename "$resume_port_failure_output"
resume_port_failure_status=$?
set -e
test "$resume_port_failure_status" -ne 0
test "$(read_state new-server)" = 1
test "$(read_state new-web)" = 1
test "$(read_state target-port)" = 1
test "$(read_state caddy-config)" = starsnap-company_caddyfile_0000000000000000
if grep -Fxq target-port-remove "$(state events)"; then exit 1; fi
if grep -Fxq sources-restore "$(state events)"; then exit 1; fi
assert_contains "$resume_port_failure_output" 'Keeping the verified exact-name services, Caddy route, and preexisting host port.'
assert_contains "$resume_port_failure_output" 'CRITICAL: Log service rename rollback could not be fully verified.'

reset_state pass normal normal normal
write_state new-server 1
partial_target_output="$(state partial-target.out)"
set +e
run_rename "$partial_target_output"
partial_target_status=$?
set -e
test "$partial_target_status" -ne 0
test "$(read_state old-server)" = 1
test "$(read_state old-web)" = 1
test "$(read_state new-server)" = 1
test "$(read_state new-web)" = 0
test "$(read_state caddy-config)" = starsnap-company_caddyfile_previous
assert_contains "$partial_target_output" 'Refusing a partial Log rename target state; both target services must exist or both must be absent.'

echo 'Log service rename tests passed.'
