#!/usr/bin/env bash

set -Eeuo pipefail

test_root="$(mktemp -d)"
export FAKE_HUB_SERVER_DEPLOY_ROOT="$test_root"

cleanup() {
  if [[ "$test_root" == /tmp/* || "$test_root" == /var/folders/* ]]; then
    find "$test_root" -depth -delete
  fi
}
trap cleanup EXIT

state() { printf '%s/%s' "$FAKE_HUB_SERVER_DEPLOY_ROOT" "$1"; }
write_state() { printf '%s\n' "$2" >"$(state "$1")"; }
read_state() { cat "$(state "$1")"; }
record_event() { printf '%s\n' "$1" >>"$(state events)"; }

reset_state() {
  local previous_health="$1" candidate_health="$2" rollback_health="$3" update_mode="$4"
  local repo_digest="${5:-$FAKE_HUB_SERVER_IMAGE}"
  find "$FAKE_HUB_SERVER_DEPLOY_ROOT" -mindepth 1 -delete
  write_state phase previous
  write_state version 10
  write_state previous-health "$previous_health"
  write_state candidate-health "$candidate_health"
  write_state rollback-health "$rollback_health"
  write_state update-mode "$update_mode"
  write_state repo-digest "$repo_digest"
  write_state update-state completed
  : >"$(state events)"
}

phase_health() {
  case "$(read_state phase)" in
    candidate) read_state candidate-health ;;
    rollback) read_state rollback-health ;;
    external) printf 'healthy\n' ;;
    *) read_state previous-health ;;
  esac
}

fake_service_image() {
  case "$(read_state phase)" in
    candidate) printf '%s\n' "$FAKE_LOCAL_IMAGE" ;;
    external) printf '%s\n' 'starsnap.invalid/external:latest' ;;
    *) printf '%s\n' "$FAKE_PREVIOUS_IMAGE" ;;
  esac
}

fake_container() {
  case "$(read_state phase)" in
    candidate) printf 'candidate-server-container\n' ;;
    external) printf 'external-server-container\n' ;;
    *) printf 'previous-server-container\n' ;;
  esac
}

fake_spec_phase() {
  if [[ "$(read_state phase)" == rollback ]]; then
    printf 'previous\n'
  else
    read_state phase
  fi
}

sha256sum() {
  cat >/dev/null
  case "$(read_state phase)" in
    candidate) printf '%064d  -\n' 2 ;;
    external) printf '%064d  -\n' 3 ;;
    *) printf '%064d  -\n' 1 ;;
  esac
}

curl() {
  if [[ "$(phase_health)" != healthy ]]; then
    printf '{"status":"DOWN","components":{"db":{"status":"UP"}}}\n'
    return 0
  fi
  printf '{"status":"UP"}\n'
  if [[ "$(read_state update-mode)" == concurrent && "$(read_state phase)" == candidate ]]; then
    write_state phase external
    write_state version 73
  fi
}

docker() {
  local object="${1:-}" operation="${2:-}" target='' format='' image=''
  shift 2 || true
  case "$object:$operation" in
    info:--format)
      case "$*" in
        *ControlAvailable*) printf 'true\n' ;;
        *NodeID*) printf 'fake-manager-node\n' ;;
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
    pull:*|tag:*) ;;
    service:inspect)
      target="${*: -1}"
      case "$*" in
        *'.Spec.TaskTemplate.ContainerSpec.Image'*) fake_service_image ;;
        *'.Spec.UpdateConfig.FailureAction'*|*'if .Spec.UpdateConfig'*) printf 'rollback\n' ;;
        *'.UpdateStatus'*) read_state update-state ;;
        *'json .Spec'*) printf '{"phase":"%s"}\n' "$(fake_spec_phase)" ;;
        *'.Version.Index'*) read_state version ;;
        --*) return 1 ;;
        *) test "$target" = 'starsnap-log_server' ;;
      esac
      ;;
    service:ls) printf 'starsnap-log_server 1/1\n' ;;
    service:update)
      while (( $# > 0 )); do
        case "$1" in
          --image) image="$2"; shift 2 ;;
          *) shift ;;
        esac
      done
      test "$image" = "$FAKE_LOCAL_IMAGE"
      write_state phase candidate
      write_state version 11
      write_state update-state completed
      record_event candidate-update
      ;;
    service:rollback)
      write_state phase rollback
      write_state version 12
      write_state update-state rollback_completed
      record_event rollback
      ;;
    service:ps|service:logs) ;;
    ps:--filter) fake_container ;;
    inspect:--format)
      format="${1:-}"
      target="${2:-}"
      case "$format" in
        *State.Health*)
          if [[ "$(phase_health)" == healthy ]]; then printf 'healthy\n'; else printf 'unhealthy\n'; fi
          ;;
        '{{.Image}}')
          case "$target" in
            candidate-server-container) printf 'sha256:candidate-image-id\n' ;;
            external-server-container) printf 'sha256:external-image-id\n' ;;
            *) printf 'sha256:previous-image-id\n' ;;
          esac
          ;;
        '{{.Config.Image}}') fake_service_image ;;
        *) return 1 ;;
      esac
      ;;
    image:inspect)
      format="${2:-}"
      case "$format" in
        '{{.Architecture}}') printf 'arm64\n' ;;
        '{{.Os}}') printf 'linux\n' ;;
        *'.RepoDigests'*) read_state repo-digest ;;
        '{{.Id}}') printf 'sha256:candidate-image-id\n' ;;
        *) return 1 ;;
      esac
      ;;
    *)
      echo "Unexpected fake docker call: $object $operation $*" >&2
      return 1
      ;;
  esac
}

bash() {
  if [[ "${1:-}" == deploy/platform/validate-platform.sh ]]; then
    return 0
  fi
  command bash "$@"
}

sleep() { :; }

hub_server_cas_update_override() {
  local expected_version="$1" image="$2" spec_file="$3"
  test "$expected_version" = "$(read_state version)"
  test "$image" = "$FAKE_LOCAL_IMAGE"
  if [[ "$(read_state update-mode)" == pre-cas-concurrent ]]; then
    write_state phase external
    write_state version 31
    return 1
  fi
  write_state phase candidate
  write_state version 47
  write_state update-state completed
  printf '{"phase":"candidate"}\n' >"$spec_file"
  record_event candidate-update
  if [[ "$(read_state update-mode)" == ambiguous ]]; then
    return 1
  fi
}

hub_server_cas_restore_override() {
  local expected_version="$1" spec_file="$2"
  test "$expected_version" = "$(read_state version)"
  test -s "$spec_file"
  write_state phase rollback
  write_state version 91
  write_state update-state completed
  record_event rollback
}

run_deploy() {
  local output_file="$1"
  (
    export ALLOW_HUB_SERVER_DEPLOY='DEPLOY-HUB-SERVER-192.168.1.103'
    export HUB_SERVER_IMAGE="$FAKE_HUB_SERVER_IMAGE"
    export HUB_SERVER_PULL_IMAGE="$FAKE_HUB_SERVER_PULL_IMAGE"
    # shellcheck disable=SC1091 # Repository-root execution is intentional.
    source deploy/platform/deploy-hub-server.sh
  ) >"$output_file" 2>&1
}

assert_contains() {
  local file="$1" expected="$2"
  grep -Fq "$expected" "$file" || {
    echo "Expected $file to contain: $expected" >&2
    sed -n '1,260p' "$file" >&2
    exit 1
  }
}

assert_not_contains() {
  local file="$1" unexpected="$2"
  if grep -Fq "$unexpected" "$file"; then
    echo "Expected $file not to contain: $unexpected" >&2
    sed -n '1,260p' "$file" >&2
    exit 1
  fi
}

readonly FAKE_PREVIOUS_IMAGE='starsnap.invalid/starsnap-platform-local/starsnap-log-server:sha-previous'
FAKE_HUB_SERVER_IMAGE="ghcr.io/starsnap/starsnap-log-server-runtime@sha256:$(printf 'a%.0s' {1..64})"
FAKE_HUB_SERVER_PULL_IMAGE='ghcr.io/starsnap/starsnap-log-server-runtime:release-test'
FAKE_LOCAL_IMAGE="starsnap.invalid/starsnap-platform-local/starsnap-log-server:sha-$(printf 'a%.0s' {1..64})"
readonly FAKE_HUB_SERVER_IMAGE FAKE_HUB_SERVER_PULL_IMAGE FAKE_LOCAL_IMAGE
export FAKE_PREVIOUS_IMAGE FAKE_HUB_SERVER_IMAGE FAKE_HUB_SERVER_PULL_IMAGE FAKE_LOCAL_IMAGE

# Mutable pull tags must resolve to the separately approved immutable digest.
wrong_digest="ghcr.io/starsnap/starsnap-log-server-runtime@sha256:$(printf 'b%.0s' {1..64})"
reset_state healthy healthy healthy normal "$wrong_digest"
digest_output="$(state digest-mismatch.out)"
set +e
run_deploy "$digest_output"
digest_status=$?
set -e
test "$digest_status" -ne 0
test ! -s "$(state events)"

# Healthy baseline and candidate deploy only the requested service.
reset_state healthy healthy healthy normal
success_output="$(state success.out)"
run_deploy "$success_output"
test "$(read_state phase)" = candidate
test "$(cat "$(state events)")" = candidate-update
assert_contains "$success_output" 'Hub server deployment verified:'
assert_not_contains "$success_output" 'CRITICAL:'

# Top-level DOWN with a nested UP component must fail and restore the full prior spec.
reset_state healthy unhealthy healthy normal
failure_output="$(state candidate-failure.out)"
set +e
run_deploy "$failure_output"
failure_status=$?
set -e
test "$failure_status" -ne 0
test "$(read_state phase)" = rollback
assert_contains "$(state events)" rollback
assert_contains "$failure_output" 'Hub server rollback verified:'

# A structurally restored but unhealthy rollback is never reported as verified.
reset_state healthy unhealthy unhealthy normal
rollback_health_output="$(state rollback-health.out)"
set +e
run_deploy "$rollback_health_output"
rollback_health_status=$?
set -e
test "$rollback_health_status" -ne 0
assert_contains "$rollback_health_output" 'The restored starsnap-log_server task is not core-healthy.'
assert_contains "$rollback_health_output" 'CRITICAL: Hub server rollback could not be fully verified'
assert_not_contains "$rollback_health_output" 'Hub server rollback verified:'

# A transport error after an accepted CAS update still rolls back the owned candidate.
reset_state healthy healthy healthy ambiguous
ambiguous_output="$(state ambiguous.out)"
set +e
run_deploy "$ambiguous_output"
ambiguous_status=$?
set -e
test "$ambiguous_status" -ne 0
test "$(read_state phase)" = rollback
assert_contains "$(state events)" rollback
assert_contains "$ambiguous_output" 'Hub server rollback verified:'

# A pre-CAS external version change fails closed and is not rolled back.
reset_state healthy healthy healthy pre-cas-concurrent
pre_cas_output="$(state pre-cas-concurrent.out)"
set +e
run_deploy "$pre_cas_output"
pre_cas_status=$?
set -e
test "$pre_cas_status" -ne 0
test "$(read_state phase)" = external
assert_not_contains "$(state events)" rollback
assert_contains "$pre_cas_output" 'changed outside this deployment; refusing to roll back'

# A concurrent external service mutation is not owned and must never be rolled back.
reset_state healthy healthy healthy concurrent
concurrent_output="$(state concurrent.out)"
set +e
run_deploy "$concurrent_output"
concurrent_status=$?
set -e
test "$concurrent_status" -ne 0
test "$(read_state phase)" = external
assert_not_contains "$(state events)" rollback
assert_contains "$concurrent_output" 'changed outside this deployment; refusing to roll back'

echo 'Hub server deployment tests passed.'
