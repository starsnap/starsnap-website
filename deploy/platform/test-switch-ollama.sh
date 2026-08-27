#!/usr/bin/env bash

set -Eeuo pipefail

test_root="$(mktemp -d)"
export FAKE_OLLAMA_SWITCH_ROOT="$test_root"

cleanup() {
  if [[ "$test_root" == /tmp/* || "$test_root" == /var/folders/* ]]; then
    find "$test_root" -depth -delete
  fi
}
trap cleanup EXIT

state() {
  printf '%s/%s' "$FAKE_OLLAMA_SWITCH_ROOT" "$1"
}

reset_state() {
  find "$FAKE_OLLAMA_SWITCH_ROOT" -mindepth 1 -delete
  printf '%s\n' 'http://ollama:11434' >"$(state web-url)"
  printf '%s\n' 'http://ollama:11434' >"$(state runtime-url)"
  printf '1\n' >"$(state ollama-replicas)"
  printf '1\n' >"$(state model-replicas)"
  printf '0\n' >"$(state updates)"
  printf '0\n' >"$(state scales)"
  printf 'completed\n' >"$(state update-state)"
  export FAKE_MANAGER_ADDRESS='192.168.1.103'
  export FAKE_PREFLIGHT_FAIL='false'
  export FAKE_LIVE_FAIL='false'
  export FAKE_POST_SCALE_FAIL='false'
  export FAKE_AUTO_ROLLBACK='false'
}

increment() {
  local file value
  file="$(state "$1")"
  value="$(<"$file")"
  printf '%s\n' "$((value + 1))" >"$file"
}

docker() {
  local object="${1:-}" operation="${2:-}" target format label value service replicas
  shift 2 || true
  case "$object:$operation" in
    info:--format) printf 'true\n' ;;
    node:inspect) printf '%s\n' "$FAKE_MANAGER_ADDRESS" ;;
    service:inspect)
      target="${*: -1}"
      case "$*" in
        *ContainerSpec.Env*) printf 'ERP_EMBEDDING_BASE_URL=%s\n' "$(<"$(state web-url)")" ;;
        *Replicated.Replicas*)
          case "$target" in
            starsnap-erp_web) printf '1\n' ;;
            starsnap-erp_ollama) cat "$(state ollama-replicas)" ;;
            starsnap-erp_ollama-model) cat "$(state model-replicas)" ;;
          esac
          ;;
        *UpdateStatus*) cat "$(state update-state)" ;;
      esac
      ;;
    service:ls)
      case "$*" in
        *starsnap-erp_web*) printf 'starsnap-erp_web 1/1\n' ;;
        *starsnap-erp_ollama-model*)
          replicas="$(<"$(state model-replicas)")"
          printf 'starsnap-erp_ollama-model %s/%s\n' "$replicas" "$replicas"
          ;;
        *starsnap-erp_ollama*)
          replicas="$(<"$(state ollama-replicas)")"
          printf 'starsnap-erp_ollama %s/%s\n' "$replicas" "$replicas"
          ;;
      esac
      ;;
    service:ps)
      if [[ "$*" == *CurrentState* ]]; then
        printf 'Complete 1 second ago\n'
      fi
      ;;
    service:update)
      while (( $# > 0 )); do
        case "$1" in
          --env-add)
            value="${2#ERP_EMBEDDING_BASE_URL=}"
            if [[ "$FAKE_AUTO_ROLLBACK" == 'true' \
              && "$value" == 'http://mac-mini.hamtory.com:11434' ]]; then
              printf 'rollback_completed\n' >"$(state update-state)"
            else
              printf '%s\n' "$value" >"$(state web-url)"
              printf '%s\n' "$value" >"$(state runtime-url)"
              printf 'completed\n' >"$(state update-state)"
            fi
            shift 2
            ;;
          --env-rm) shift 2 ;;
          *) shift ;;
        esac
      done
      increment updates
      ;;
    service:scale)
      [[ "${1:-}" == '--detach=true' ]] || return 1
      shift
      service="${1%%=*}"
      replicas="${1#*=}"
      case "$service" in
        starsnap-erp_ollama) printf '%s\n' "$replicas" >"$(state ollama-replicas)" ;;
        starsnap-erp_ollama-model) printf '%s\n' "$replicas" >"$(state model-replicas)" ;;
      esac
      increment scales
      ;;
    ps:--filter) printf 'erp-web-container\n' ;;
    inspect:--format) printf 'ERP_EMBEDDING_BASE_URL=%s\n' "$(<"$(state runtime-url)")" ;;
    exec:--interactive)
      if [[ "$*" == *'--env ERP_EMBEDDING_BASE_URL=http://mac-mini.hamtory.com:11434'* ]]; then
        [[ "$FAKE_PREFLIGHT_FAIL" != 'true' ]] || return 1
      else
        value="$(<"$(state runtime-url)")"
        if [[ "$value" == 'http://mac-mini.hamtory.com:11434' ]]; then
          [[ "$FAKE_LIVE_FAIL" != 'true' ]] || return 1
          if [[ "$(<"$(state ollama-replicas)")" == '0' ]]; then
            [[ "$FAKE_POST_SCALE_FAIL" != 'true' ]] || return 1
          fi
        fi
      fi
      printf 'Ollama semantic probe passed: digest=790764642607 dimension=1024\n'
      ;;
    config:inspect)
      [[ -f "$(state marker)" ]] || return 1
      format="$*"
      case "$format" in
        *previous-url*) cat "$(state previous-url)" ;;
        *previous-ollama-replicas*) cat "$(state previous-ollama-replicas)" ;;
        *previous-model-replicas*) cat "$(state previous-model-replicas)" ;;
        *target-url*) cat "$(state target-url)" ;;
      esac
      ;;
    config:create)
      IFS= read -r _ || true
      while (( $# > 0 )); do
        case "$1" in
          --label)
            label="${2%%=*}"
            value="${2#*=}"
            case "$label" in
              com.starsnap.previous-url) printf '%s\n' "$value" >"$(state previous-url)" ;;
              com.starsnap.previous-ollama-replicas) printf '%s\n' "$value" >"$(state previous-ollama-replicas)" ;;
              com.starsnap.previous-model-replicas) printf '%s\n' "$value" >"$(state previous-model-replicas)" ;;
              com.starsnap.target-url) printf '%s\n' "$value" >"$(state target-url)" ;;
            esac
            shift 2
            ;;
          *) shift ;;
        esac
      done
      : >"$(state marker)"
      ;;
    config:rm) rm -f "$(state marker)" ;;
    *) echo "Unexpected fake docker call: $object $operation $*" >&2; return 1 ;;
  esac
}

run_switch() {
  (
    export ALLOW_OLLAMA_ROUTE="${1:-SWITCH-OLLAMA-192.168.1.6}"
    export ERP_EMBEDDING_BASE_URL='http://mac-mini.hamtory.com:11434'
    export ERP_OLLAMA_REPLICAS=0
    export ERP_OLLAMA_MODEL_REPLICAS=0
    export STARSNAP_OLLAMA_SWITCH_TIMEOUT_SECONDS=2
    export STARSNAP_OLLAMA_SWITCH_POLL_SECONDS=0
    source deploy/platform/switch-ollama.sh switch
  )
}

reset_state
if run_switch wrong-confirmation >/dev/null 2>&1; then
  echo 'Missing confirmation unexpectedly succeeded.' >&2
  exit 1
fi
test "$(<"$(state web-url)")" = 'http://ollama:11434'

reset_state
export FAKE_MANAGER_ADDRESS='192.168.1.2'
if run_switch >/dev/null 2>&1; then
  echo 'Wrong Swarm manager unexpectedly succeeded.' >&2
  exit 1
fi
test "$(<"$(state web-url)")" = 'http://ollama:11434'

reset_state
export FAKE_PREFLIGHT_FAIL='true'
if run_switch >/dev/null 2>&1; then
  echo 'Failed external preflight unexpectedly succeeded.' >&2
  exit 1
fi
test "$(<"$(state web-url)")" = 'http://ollama:11434'
test "$(<"$(state ollama-replicas)")" = '1'
test "$(<"$(state model-replicas)")" = '1'
test ! -e "$(state marker)"

reset_state
run_switch >/dev/null
test "$(<"$(state web-url)")" = 'http://mac-mini.hamtory.com:11434'
test "$(<"$(state ollama-replicas)")" = '0'
test "$(<"$(state model-replicas)")" = '0'
test ! -e "$(state marker)"
updates_before="$(<"$(state updates)")"
scales_before="$(<"$(state scales)")"
run_switch >/dev/null
test "$(<"$(state updates)")" = "$updates_before"
test "$(<"$(state scales)")" = "$scales_before"

reset_state
printf '%s\n' 'http://mac-mini.hamtory.com:11434' >"$(state web-url)"
printf '%s\n' 'http://mac-mini.hamtory.com:11434' >"$(state runtime-url)"
printf '%s\n' 'http://ollama:11434' >"$(state previous-url)"
printf '1\n' >"$(state previous-ollama-replicas)"
printf '1\n' >"$(state previous-model-replicas)"
printf '%s\n' 'http://mac-mini.hamtory.com:11434' >"$(state target-url)"
: >"$(state marker)"
run_switch >/dev/null
test "$(<"$(state ollama-replicas)")" = '0'
test "$(<"$(state model-replicas)")" = '0'
test ! -e "$(state marker)"

reset_state
export FAKE_AUTO_ROLLBACK='true'
if run_switch >/dev/null 2>&1; then
  echo 'Swarm-auto-rolled-back web update unexpectedly succeeded.' >&2
  exit 1
fi
test "$(<"$(state web-url)")" = 'http://ollama:11434'
test "$(<"$(state runtime-url)")" = 'http://ollama:11434'
test "$(<"$(state ollama-replicas)")" = '1'
test "$(<"$(state model-replicas)")" = '1'
test ! -e "$(state marker)"

reset_state
export FAKE_LIVE_FAIL='true'
if run_switch >/dev/null 2>&1; then
  echo 'Failed switched semantic probe unexpectedly succeeded.' >&2
  exit 1
fi
test "$(<"$(state web-url)")" = 'http://ollama:11434'
test "$(<"$(state ollama-replicas)")" = '1'
test "$(<"$(state model-replicas)")" = '1'
test ! -e "$(state marker)"

reset_state
export FAKE_POST_SCALE_FAIL='true'
if run_switch >/dev/null 2>&1; then
  echo 'Failed post-scale semantic probe unexpectedly succeeded.' >&2
  exit 1
fi
test "$(<"$(state web-url)")" = 'http://ollama:11434'
test "$(<"$(state ollama-replicas)")" = '1'
test "$(<"$(state model-replicas)")" = '1'
test ! -e "$(state marker)"

echo 'Ollama route switch tests passed.'
