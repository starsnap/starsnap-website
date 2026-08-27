#!/usr/bin/env bash

set -Eeuo pipefail

test_root="$(mktemp -d)"
export FAKE_ERP_DEPLOY_ROOT="$test_root"

cleanup() {
  if [[ "$test_root" == /tmp/* || "$test_root" == /var/folders/* ]]; then
    find "$test_root" -depth -delete
  fi
}
trap cleanup EXIT

state() {
  printf '%s/%s' "$FAKE_ERP_DEPLOY_ROOT" "$1"
}

write_state() {
  printf '%s\n' "$2" >"$(state "$1")"
}

read_state() {
  cat "$(state "$1")"
}

record_event() {
  printf '%s\n' "$1" >>"$(state events)"
}

reset_state() {
  local pre_state="$1" verify_result="$2" mounted_secret_name="${3:-erp-eat-api-key-v1}"
  find "$FAKE_ERP_DEPLOY_ROOT" -mindepth 1 -delete
  write_state phase previous
  write_state update-state completed
  write_state failure-action rollback
  write_state verify-result "$verify_result"
  write_state previous-secret "$mounted_secret_name"
  write_state current-secret "$mounted_secret_name"
  : >"$(state events)"
  if [[ "$pre_state" == healthy ]]; then
    write_state replicas 1/1
  else
    write_state replicas 0/1
  fi
}

fake_service_image() {
  if [[ "$(read_state phase)" == candidate ]]; then
    printf '%s\n' "$FAKE_LOCAL_IMAGE"
  else
    printf '%s\n' "$FAKE_PREVIOUS_IMAGE"
  fi
}

fake_web_container() {
  if [[ "$(read_state phase)" == candidate ]]; then
    printf '%s\n' candidate-web-container
  else
    printf '%s\n' previous-web-container
  fi
}

docker() {
  local object="${1:-}" operation="${2:-}" format target action='' image=''
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
        *) echo "Unexpected fake docker node inspect call: $*" >&2; return 1 ;;
      esac
      ;;
    secret:inspect|volume:create|pull:*|tag:*)
      ;;
    service:inspect)
      target="${*: -1}"
      case "$*" in
        *'.Spec.TaskTemplate.ContainerSpec.Image'*)
          if [[ "$target" == starsnap-erp_postgres ]]; then
            printf 'postgres:16\n'
          else
            if [[ "$(read_state phase)" == candidate ]]; then
              : >"$(state candidate-service-image-inspected)"
            fi
            fake_service_image
          fi
          ;;
        *'.Spec.TaskTemplate.ContainerSpec.Secrets'*)
          printf '%s|eat-api-service-key|1000|1000|256\n' "$(read_state current-secret)"
          ;;
        *'.Spec.TaskTemplate.ContainerSpec.Env'*)
          printf '%s\n' \
            'EAT_API_SERVICE_KEY_FILE=/run/secrets/eat-api-service-key' \
            'EAT_CACHE_TTL_MINUTES=360'
          ;;
        *'.Spec.UpdateConfig.FailureAction'*|*'if .Spec.UpdateConfig'*)
          read_state failure-action
          ;;
        *'.UpdateStatus'*) read_state update-state ;;
        *'json .Spec.TaskTemplate'*)
          printf '{"phase":"%s"}\n' "$(read_state phase)"
          ;;
        --*)
          echo "Unexpected fake docker service inspect format: $*" >&2
          return 1
          ;;
        *)
          ;;
      esac
      ;;
    service:ls)
      printf 'starsnap-erp_web %s\n' "$(read_state replicas)"
      ;;
    service:update)
      local secret_remove='' secret_add='' secret_source=''
      while (( $# > 0 )); do
        case "$1" in
          --image)
            image="$2"
            shift 2
            ;;
          --update-failure-action)
            action="$2"
            shift 2
            ;;
          --env-add)
            shift 2
            ;;
          --secret-rm)
            secret_remove="$2"
            shift 2
            ;;
          --secret-add)
            secret_add="$2"
            shift 2
            ;;
          *)
            shift
            ;;
        esac
      done
      if [[ -n "$image" ]]; then
        test "$image" = "$FAKE_LOCAL_IMAGE"
        if [[ -n "$secret_remove" ]]; then
          write_state secret-rm "$secret_remove"
        fi
        if [[ -n "$secret_add" ]]; then
          write_state secret-add "$secret_add"
          secret_source="${secret_add%%,*}"
          write_state current-secret "${secret_source#source=}"
        fi
        write_state phase candidate
        write_state replicas 1/1
        write_state update-state completed
        if [[ -n "$action" ]]; then
          write_state failure-action "$action"
        fi
        record_event "candidate-update|${action:-none}"
      else
        test -n "$action"
        write_state failure-action "$action"
        record_event "failure-action-update|$action"
      fi
      ;;
    service:rollback)
      write_state phase previous
      write_state current-secret "$(read_state previous-secret)"
      write_state replicas 1/1
      write_state update-state rollback_completed
      write_state failure-action rollback
      record_event rollback
      ;;
    service:ps|service:logs)
      ;;
    ps:--filter)
      if [[ "$*" == *starsnap-erp_postgres* ]]; then
        printf 'postgres-container\n'
      elif [[ "$(read_state replicas)" == 1/1 ]]; then
        fake_web_container
      fi
      ;;
    inspect:--format)
      format="${1:-}"
      target="${2:-}"
      case "$format" in
        *State.Health*) printf 'healthy\n' ;;
        '{{.Image}}')
          if [[ "$target" == candidate-web-container ]]; then
            : >"$(state candidate-running-image-inspected)"
            printf 'sha256:candidate-image-id\n'
          else
            printf 'sha256:previous-image-id\n'
          fi
          ;;
        '{{.Config.Image}}')
          if [[ "$target" == candidate-web-container ]]; then
            printf '%s\n' "$FAKE_LOCAL_IMAGE"
          else
            printf '%s\n' "$FAKE_PREVIOUS_IMAGE"
          fi
          ;;
        *) echo "Unexpected fake docker inspect format: $format" >&2; return 1 ;;
      esac
      ;;
    image:inspect)
      format="${2:-}"
      case "$format" in
        '{{.Architecture}}') printf 'arm64\n' ;;
        '{{.Os}}') printf 'linux\n' ;;
        '{{.Id}}')
          if [[ "$(read_state phase)" == candidate ]]; then
            : >"$(state candidate-image-id-inspected)"
          fi
          printf 'sha256:candidate-image-id\n'
          ;;
        *) echo "Unexpected fake docker image inspect format: $format" >&2; return 1 ;;
      esac
      ;;
    exec:*)
      target="$operation"
      if [[ "$target" == postgres-container && "$*" == *pg_dump* ]]; then
        printf 'fake-postgres-dump\n'
      fi
      ;;
    run:*)
      if [[ "$*" == *sha256sum* ]]; then
        printf '%064d  /backups/fake.dump\n' 0
      elif [[ "$*" == *'--entrypoint stat'* ]]; then
        printf '42\n'
      elif [[ "$*" == *interactive* || "$*" == *'cat >'* ]]; then
        cat >/dev/null
      fi
      ;;
    *)
      echo "Unexpected fake docker call: $object $operation $*" >&2
      return 1
      ;;
  esac
}

bash() {
  case "${1:-}" in
    deploy/platform/validate-platform.sh)
      return 0
      ;;
    deploy/platform/verify-erp-eat.sh)
      record_event verify
      if [[ "$(read_state verify-result)" == pass ]]; then
        return 0
      fi
      return 1
      ;;
    *)
      command bash "$@"
      ;;
  esac
}

run_deploy() {
  local output_file="$1"
  (
    export ALLOW_ERP_DEPLOY='DEPLOY-ERP-192.168.1.103'
    export ERP_EAT_API_SECRET_NAME='erp-eat-api-key-v2'
    export ERP_WEB_IMAGE="$FAKE_ERP_WEB_IMAGE"
    # shellcheck disable=SC1091 # The repository root is the required working directory.
    source deploy/platform/deploy-erp.sh
  ) >"$output_file" 2>&1
}

assert_contains() {
  local file="$1" expected="$2"
  if ! grep -Fq "$expected" "$file"; then
    echo "Expected $file to contain: $expected" >&2
    sed -n '1,240p' "$file" >&2
    exit 1
  fi
}

assert_not_contains() {
  local file="$1" unexpected="$2"
  if grep -Fq "$unexpected" "$file"; then
    echo "Expected $file not to contain: $unexpected" >&2
    sed -n '1,240p' "$file" >&2
    exit 1
  fi
}

assert_secret_rotation_requested() {
  test "$(read_state secret-rm)" = 'erp-eat-api-key-v1'
  test "$(read_state secret-add)" = 'source=erp-eat-api-key-v2,target=eat-api-service-key,uid=1000,gid=1000,mode=0400'
}

readonly FAKE_PREVIOUS_IMAGE='registry.example/starsnap-erp-web:previous'
FAKE_ERP_WEB_IMAGE="ghcr.io/starsnap/starsnap-erp-web@sha256:$(printf 'a%.0s' {1..64})"
FAKE_LOCAL_IMAGE="starsnap.invalid/starsnap-platform-local/starsnap-erp-web:sha-$(printf 'a%.0s' {1..64})"
readonly FAKE_ERP_WEB_IMAGE FAKE_LOCAL_IMAGE
export FAKE_PREVIOUS_IMAGE FAKE_ERP_WEB_IMAGE FAKE_LOCAL_IMAGE

# A healthy previous task is a safe rollback target. A verification failure must
# explicitly roll back, accept rollback_completed, and verify the restored task.
reset_state healthy fail
healthy_failure_output="$(state healthy-verification-failure.out)"
set +e
run_deploy "$healthy_failure_output"
healthy_failure_status=$?
set -e
test "$healthy_failure_status" -ne 0
assert_contains "$(state events)" 'candidate-update|none'
assert_contains "$(state events)" rollback
assert_secret_rotation_requested
test "$(read_state phase)" = previous
test "$(read_state current-secret)" = 'erp-eat-api-key-v1'
test "$(read_state update-state)" = rollback_completed
assert_contains "$healthy_failure_output" 'ERP rollback verified:'
assert_not_contains "$healthy_failure_output" 'CRITICAL:'
assert_not_contains "$healthy_failure_output" 'Rollback did not converge'

# An unavailable previous task must never replace a core-healthy recovery
# candidate. The candidate update uses pause so Swarm cannot auto-roll it back.
reset_state unhealthy fail
unhealthy_failure_output="$(state unhealthy-verification-failure.out)"
set +e
run_deploy "$unhealthy_failure_output"
unhealthy_failure_status=$?
set -e
test "$unhealthy_failure_status" -ne 0
assert_contains "$(state events)" 'candidate-update|pause'
assert_not_contains "$(state events)" rollback
assert_secret_rotation_requested
test "$(read_state phase)" = candidate
test "$(read_state current-secret)" = 'erp-eat-api-key-v2'
test "$(read_state failure-action)" = pause
assert_contains "$unhealthy_failure_output" 'refusing to roll back to its unavailable specification'
assert_contains "$unhealthy_failure_output" 'candidate ERP image is running and core-healthy'
assert_not_contains "$unhealthy_failure_output" 'CRITICAL:'

# A successful recovery restores the service's original FailureAction without
# replacing the verified candidate task. The markers prove the final service
# image, running task image, and local candidate ID were all inspected.
reset_state unhealthy pass
write_state failure-action continue
recovery_success_output="$(state recovery-success.out)"
run_deploy "$recovery_success_output"
assert_secret_rotation_requested
test "$(read_state phase)" = candidate
test "$(read_state current-secret)" = 'erp-eat-api-key-v2'
test "$(read_state failure-action)" = continue
test -e "$(state candidate-service-image-inspected)"
test -e "$(state candidate-running-image-inspected)"
test -e "$(state candidate-image-id-inspected)"
test "$(sed -n '1p' "$(state events)")" = 'candidate-update|pause'
test "$(sed -n '2p' "$(state events)")" = verify
test "$(sed -n '3p' "$(state events)")" = 'failure-action-update|continue'
test "$(wc -l <"$(state events)" | tr -d ' ')" = 3
assert_contains "$recovery_success_output" "ERP-only deployment verified: image=$FAKE_ERP_WEB_IMAGE"
assert_not_contains "$recovery_success_output" 'CRITICAL:'

# A service already using the requested version must not receive redundant
# secret remove/add operations during an otherwise successful image update.
reset_state healthy pass 'erp-eat-api-key-v2'
idempotent_output="$(state idempotent-success.out)"
run_deploy "$idempotent_output"
test ! -e "$(state secret-rm)"
test ! -e "$(state secret-add)"
test "$(read_state current-secret)" = 'erp-eat-api-key-v2'
assert_contains "$idempotent_output" "ERP-only deployment verified: image=$FAKE_ERP_WEB_IMAGE"
assert_not_contains "$idempotent_output" 'Rotating eAT secret mount:'

echo 'ERP recovery deployment tests passed.'
