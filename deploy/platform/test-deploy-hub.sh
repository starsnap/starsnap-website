#!/usr/bin/env bash

set -Eeuo pipefail

test_root="$(mktemp -d)"
export FAKE_HUB_DEPLOY_ROOT="$test_root"

cleanup() {
  if [[ "$test_root" == /tmp/* || "$test_root" == /var/folders/* ]]; then
    find "$test_root" -depth -delete
  fi
}
trap cleanup EXIT

state() { printf '%s/%s' "$FAKE_HUB_DEPLOY_ROOT" "$1"; }
write_state() { printf '%s\n' "$2" >"$(state "$1")"; }
read_state() { cat "$(state "$1")"; }
record_event() { printf '%s\n' "$1" >>"$(state events)"; }

reset_state() {
  local previous_health="$1" candidate_health="$2" rollback_health="$3" update_mode="$4"
  local repo_digest="${5:-$FAKE_HUB_WEB_IMAGE}"
  find "$FAKE_HUB_DEPLOY_ROOT" -mindepth 1 -delete
  write_state phase previous
  write_state previous-health "$previous_health"
  write_state candidate-health "$candidate_health"
  write_state rollback-health "$rollback_health"
  write_state update-mode "$update_mode"
  write_state repo-digest "$repo_digest"
  write_state update-state completed
  write_state failure-action rollback
  : >"$(state events)"
}

phase_health() {
  case "$(read_state phase)" in
    candidate) read_state candidate-health ;;
    rollback) read_state rollback-health ;;
    *) read_state previous-health ;;
  esac
}

fake_service_image() {
  if [[ "$(read_state phase)" == candidate ]]; then
    printf '%s\n' "$FAKE_LOCAL_IMAGE"
  else
    printf '%s\n' "$FAKE_PREVIOUS_IMAGE"
  fi
}

fake_container() {
  if [[ "$(read_state phase)" == candidate ]]; then
    printf '%s\n' candidate-web-container
  else
    printf '%s\n' previous-web-container
  fi
}

sha256sum() {
  cat >/dev/null
  if [[ "$(read_state phase)" == candidate ]]; then
    printf '%064d  -\n' 2
  else
    printf '%064d  -\n' 1
  fi
}

docker() {
  local object="${1:-}" operation="${2:-}" target='' format='' image='' action=''
  shift 2 || true
  case "$object:$operation" in
    info:--format)
      case "$*" in
        *ControlAvailable*) printf 'true\n' ;;
        *NodeID*) printf 'fake-manager-node\n' ;;
        *) echo "Unexpected fake docker info call: $*" >&2; return 1 ;;
      esac
      ;;
    node:inspect)
      case "$*" in
        *Status.Addr*) printf '192.168.1.103\n' ;;
        *Spec.Role*) printf 'manager\n' ;;
        *starsnap.actions-runner*) printf 'true\n' ;;
        *) echo "Unexpected fake docker node inspect: $*" >&2; return 1 ;;
      esac
      ;;
    pull:*|tag:*)
      ;;
    service:inspect)
      target="${*: -1}"
      case "$*" in
        *'.Spec.TaskTemplate.ContainerSpec.Image'*) fake_service_image ;;
        *'.Spec.UpdateConfig.FailureAction'*|*'if .Spec.UpdateConfig'*) read_state failure-action ;;
        *'.UpdateStatus'*) read_state update-state ;;
        *'json .Spec.TaskTemplate'*) printf '{"phase":"%s"}\n' "$(read_state phase)" ;;
        --*) echo "Unexpected fake service inspect: $*" >&2; return 1 ;;
        *) test "$target" = 'starsnap-log-web' ;;
      esac
      ;;
    service:ls)
      printf 'starsnap-log-web 1/1\n'
      ;;
    service:update)
      while (( $# > 0 )); do
        case "$1" in
          --image) image="$2"; shift 2 ;;
          --update-failure-action) action="$2"; shift 2 ;;
          *) shift ;;
        esac
      done
      if [[ -n "$image" ]]; then
        test "$image" = "$FAKE_LOCAL_IMAGE"
        write_state phase candidate
        write_state update-state completed
        if [[ -n "$action" ]]; then write_state failure-action "$action"; fi
        record_event "candidate-update|${action:-none}"
        if [[ "$(read_state update-mode)" == ambiguous ]]; then
          return 1
        fi
      else
        test -n "$action"
        write_state failure-action "$action"
        record_event "failure-action-update|$action"
      fi
      ;;
    service:rollback)
      write_state phase rollback
      write_state update-state rollback_completed
      write_state failure-action rollback
      record_event rollback
      ;;
    service:ps|service:logs)
      ;;
    ps:--filter)
      fake_container
      ;;
    inspect:--format)
      format="${1:-}"
      target="${2:-}"
      case "$format" in
        *State.Health*)
          if [[ "$(phase_health)" == healthy ]]; then printf 'healthy\n'; else printf 'unhealthy\n'; fi
          ;;
        '{{.Image}}')
          if [[ "$target" == candidate-web-container ]]; then
            printf 'sha256:candidate-image-id\n'
          else
            printf 'sha256:previous-image-id\n'
          fi
          ;;
        '{{.Config.Image}}') fake_service_image ;;
        *) echo "Unexpected fake inspect format: $format" >&2; return 1 ;;
      esac
      ;;
    image:inspect)
      format="${2:-}"
      case "$format" in
        '{{.Architecture}}') printf 'arm64\n' ;;
        '{{.Os}}') printf 'linux\n' ;;
        *'.RepoDigests'*) read_state repo-digest ;;
        '{{.Id}}') printf 'sha256:candidate-image-id\n' ;;
        *) echo "Unexpected fake image inspect: $format" >&2; return 1 ;;
      esac
      ;;
    exec:*)
      if [[ "$(phase_health)" != healthy ]]; then return 1; fi
      if [[ "$*" == *sha256sum* ]]; then
        printf '%s  /app/icon-96.png\n' "$EXPECTED_ICON_SHA256"
      fi
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

run_deploy() {
  local output_file="$1"
  (
    export ALLOW_HUB_DEPLOY='DEPLOY-HUB-WEB-192.168.1.103'
    export HUB_WEB_IMAGE="$FAKE_HUB_WEB_IMAGE"
    export HUB_WEB_PULL_IMAGE="$FAKE_HUB_WEB_PULL_IMAGE"
    # shellcheck disable=SC1091 # Repository-root execution is intentional.
    source deploy/platform/deploy-hub.sh
  ) >"$output_file" 2>&1
}

assert_contains() {
  local file="$1" expected="$2"
  grep -Fq "$expected" "$file" || {
    echo "Expected $file to contain: $expected" >&2
    sed -n '1,240p' "$file" >&2
    exit 1
  }
}

assert_not_contains() {
  local file="$1" unexpected="$2"
  if grep -Fq "$unexpected" "$file"; then
    echo "Expected $file not to contain: $unexpected" >&2
    sed -n '1,240p' "$file" >&2
    exit 1
  fi
}

readonly EXPECTED_ICON_SHA256='61432c716c06942f957481e9bf7af211081cf3c28ad4b2ecf16dfbb16d7eb8f9'
readonly FAKE_PREVIOUS_IMAGE='starsnap.invalid/starsnap-platform-local/starsnap-log-web:sha-previous'
FAKE_HUB_WEB_IMAGE="ghcr.io/starsnap/starsnap-log-web@sha256:$(printf 'a%.0s' {1..64})"
FAKE_HUB_WEB_PULL_IMAGE='ghcr.io/starsnap/starsnap-log-web:release-test'
FAKE_LOCAL_IMAGE="starsnap.invalid/starsnap-platform-local/starsnap-log-web:sha-$(printf 'a%.0s' {1..64})"
readonly FAKE_HUB_WEB_IMAGE FAKE_HUB_WEB_PULL_IMAGE FAKE_LOCAL_IMAGE
export EXPECTED_ICON_SHA256 FAKE_PREVIOUS_IMAGE FAKE_HUB_WEB_IMAGE FAKE_HUB_WEB_PULL_IMAGE FAKE_LOCAL_IMAGE

# A mutable pull tag must resolve to the separately approved immutable digest.
wrong_digest="ghcr.io/starsnap/starsnap-log-web@sha256:$(printf 'b%.0s' {1..64})"
reset_state healthy healthy healthy normal "$wrong_digest"
digest_mismatch_output="$(state digest-mismatch.out)"
set +e
run_deploy "$digest_mismatch_output"
digest_mismatch_status=$?
set -e
test "$digest_mismatch_status" -ne 0
test "$(read_state phase)" = previous
test ! -s "$(state events)"

# Healthy baseline + healthy candidate succeeds without touching sibling services.
reset_state healthy healthy healthy normal
success_output="$(state success.out)"
run_deploy "$success_output"
test "$(read_state phase)" = candidate
test "$(cat "$(state events)")" = 'candidate-update|none'
assert_contains "$success_output" 'Hub web deployment verified:'
assert_not_contains "$success_output" 'CRITICAL:'

# Candidate verification failure restores a healthy previous service and verifies health.
reset_state healthy unhealthy healthy normal
failure_output="$(state candidate-failure.out)"
set +e
run_deploy "$failure_output"
failure_status=$?
set -e
test "$failure_status" -ne 0
test "$(read_state phase)" = rollback
assert_contains "$(state events)" rollback
assert_contains "$failure_output" 'Hub web rollback verified:'
assert_not_contains "$failure_output" 'CRITICAL:'

# A client-side update error after Swarm accepted the mutation still rolls back.
reset_state healthy healthy healthy ambiguous
ambiguous_output="$(state ambiguous-update.out)"
set +e
run_deploy "$ambiguous_output"
ambiguous_status=$?
set -e
test "$ambiguous_status" -ne 0
test "$(read_state phase)" = rollback
assert_contains "$(state events)" rollback
assert_contains "$ambiguous_output" 'Hub web rollback verified:'

# A rollback that converges structurally but is unhealthy must never be reported verified.
reset_state healthy unhealthy unhealthy normal
rollback_health_output="$(state rollback-health-failure.out)"
set +e
run_deploy "$rollback_health_output"
rollback_health_status=$?
set -e
test "$rollback_health_status" -ne 0
assert_contains "$rollback_health_output" 'The restored starsnap-log-web task is not core-healthy.'
assert_contains "$rollback_health_output" 'CRITICAL: Hub web rollback could not be fully verified'
assert_not_contains "$rollback_health_output" 'Hub web rollback verified:'

# An unhealthy previous task is not restored over a failed candidate.
reset_state unhealthy unhealthy healthy normal
unhealthy_previous_output="$(state unhealthy-previous.out)"
set +e
run_deploy "$unhealthy_previous_output"
unhealthy_previous_status=$?
set -e
test "$unhealthy_previous_status" -ne 0
test "$(read_state phase)" = candidate
assert_not_contains "$(state events)" rollback
assert_contains "$unhealthy_previous_output" 'refusing to roll back to its unavailable specification'
assert_contains "$unhealthy_previous_output" 'CRITICAL: no healthy Hub web target exists'

# Successful recovery from an unhealthy prior task restores its failure action.
reset_state unhealthy healthy healthy normal
write_state failure-action continue
recovery_output="$(state recovery-success.out)"
run_deploy "$recovery_output"
test "$(read_state phase)" = candidate
test "$(read_state failure-action)" = continue
assert_contains "$(state events)" 'candidate-update|pause'
assert_contains "$(state events)" 'failure-action-update|continue'
assert_contains "$recovery_output" 'Hub web deployment verified:'

echo 'Hub web recovery deployment tests passed.'
