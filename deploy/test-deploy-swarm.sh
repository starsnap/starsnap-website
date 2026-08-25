#!/usr/bin/env bash

set -euo pipefail

readonly candidate_image="ghcr.io/starsnap/starsnap-website@sha256:1111111111111111111111111111111111111111111111111111111111111111"
readonly previous_image="ghcr.io/starsnap/starsnap-website@sha256:2222222222222222222222222222222222222222222222222222222222222222"
export candidate_image previous_image

test_root="$(mktemp -d)"
export FAKE_SWARM_STATE="$test_root/swarm"
export FAKE_FAIL_CANDIDATE=false
export FAKE_SERVICE_LIST_ERROR=false

cleanup() {
  if [[ "$test_root" == /tmp/* || "$test_root" == /var/folders/* ]]; then
    find "$test_root" -depth -delete
  fi
}
trap cleanup EXIT

reset_state() {
  mkdir -p "$FAKE_SWARM_STATE"
  printf '%s' "$previous_image" >"$FAKE_SWARM_STATE/current-image"
  printf '%s' "completed" >"$FAKE_SWARM_STATE/update-state"
  printf '%s' "1/1" >"$FAKE_SWARM_STATE/replicas"
  touch "$FAKE_SWARM_STATE/stack-exists"
  rm -f -- "$FAKE_SWARM_STATE/rollback-requested"
  rm -f -- "$FAKE_SWARM_STATE/stack-remove-requested"
}

docker() {
  case "$1 $2" in
    "info --format")
      printf '%s\n' "true"
      ;;
    "service inspect")
      if [[ ! -f "$FAKE_SWARM_STATE/current-image" ]]; then
        return 1
      fi
      if [[ " $* " == *" --format "* ]]; then
        if [[ " $* " == *"ContainerSpec.Image"* ]]; then
          cat "$FAKE_SWARM_STATE/current-image"
        else
          cat "$FAKE_SWARM_STATE/update-state"
        fi
      fi
      ;;
    "service ls")
      if [[ "$FAKE_SERVICE_LIST_ERROR" == "true" ]]; then
        return 1
      fi
      if [[ -f "$FAKE_SWARM_STATE/current-image" ]]; then
        if [[ " $* " == *"{{.Replicas}}"* ]]; then
          printf '%s %s\n' "starsnap-company_website" "$(cat "$FAKE_SWARM_STATE/replicas")"
        else
          printf '%s\n' "starsnap-company_website"
        fi
      fi
      ;;
    "service ps")
      ;;
    "service rollback")
      printf '%s' "$previous_image" >"$FAKE_SWARM_STATE/current-image"
      printf '%s' "rollback_completed" >"$FAKE_SWARM_STATE/update-state"
      touch "$FAKE_SWARM_STATE/rollback-requested"
      ;;
    "service rm")
      rm -f -- "$FAKE_SWARM_STATE/current-image"
      ;;
    "stack config")
      printf 'services:\n  website:\n    image: %s\n' "$STARSNAP_WEBSITE_IMAGE"
      ;;
    "stack ls")
      if [[ -f "$FAKE_SWARM_STATE/stack-exists" ]]; then
        printf '%s\n' "starsnap-company"
      fi
      ;;
    "stack deploy")
      touch "$FAKE_SWARM_STATE/stack-exists"
      printf '%s' "$STARSNAP_WEBSITE_IMAGE" >"$FAKE_SWARM_STATE/current-image"
      printf '%s' "completed" >"$FAKE_SWARM_STATE/update-state"
      ;;
    "stack rm")
      rm -f -- "$FAKE_SWARM_STATE/current-image"
      rm -f -- "$FAKE_SWARM_STATE/stack-exists"
      touch "$FAKE_SWARM_STATE/stack-remove-requested"
      ;;
    *)
      printf 'Unexpected fake Docker call: %s\n' "$*" >&2
      return 1
      ;;
  esac
}

curl() {
  local output=""
  local current_image=""
  local index=1
  local args=("$@")

  while (( index <= ${#args[@]} )); do
    if [[ "${args[index - 1]}" == "--output" ]]; then
      output="${args[index]}"
      break
    fi
    index=$((index + 1))
  done

  current_image="$(cat "$FAKE_SWARM_STATE/current-image")"
  if [[ "$FAKE_FAIL_CANDIDATE" == "true" && "$current_image" == "$candidate_image" ]]; then
    return 22
  fi

  if [[ -n "$output" && "$output" != "/dev/null" ]]; then
    printf '%s' "StarSnap" >"$output"
  fi
}

sleep() {
  SECONDS=$((SECONDS + 60))
}

export -f docker curl sleep

run_deploy() {
  RUNNER_TEMP="$test_root" \
  STACK_NAME="starsnap-company" \
  SERVICE_NAME="starsnap-company_website" \
  STARSNAP_HEALTH_URL="http://192.0.2.1:3000/" \
  STARSNAP_WEBSITE_IMAGE="$candidate_image" \
    bash deploy/deploy-swarm.sh
}

reset_state
success_output="$(run_deploy 2>&1)"
grep -Fq "Deployment verified: $candidate_image" <<<"$success_output"
test ! -e "$FAKE_SWARM_STATE/rollback-requested"

reset_state
export FAKE_FAIL_CANDIDATE=true
if failure_output="$(run_deploy 2>&1)"; then
  echo "Expected the failed health verification to fail the deployment." >&2
  exit 1
fi
grep -Fq "Rollback verified: $previous_image" <<<"$failure_output"
test -e "$FAKE_SWARM_STATE/rollback-requested"
test "$(cat "$FAKE_SWARM_STATE/current-image")" = "$previous_image"

reset_state
rm -f -- "$FAKE_SWARM_STATE/current-image"
rm -f -- "$FAKE_SWARM_STATE/stack-exists"
export FAKE_FAIL_CANDIDATE=true
if initial_failure_output="$(run_deploy 2>&1)"; then
  echo "Expected the failed initial deployment to fail." >&2
  exit 1
fi
grep -Fq "Initial deployment cleanup verified." <<<"$initial_failure_output"
test -e "$FAKE_SWARM_STATE/stack-remove-requested"
test ! -e "$FAKE_SWARM_STATE/current-image"
test ! -e "$FAKE_SWARM_STATE/stack-exists"

reset_state
export FAKE_FAIL_CANDIDATE=false
export FAKE_SERVICE_LIST_ERROR=true
if run_deploy >/dev/null 2>&1; then
  echo "Expected a Swarm service-list API failure to stop deployment." >&2
  exit 1
fi
test "$(cat "$FAKE_SWARM_STATE/current-image")" = "$previous_image"
test ! -e "$FAKE_SWARM_STATE/rollback-requested"
test ! -e "$FAKE_SWARM_STATE/stack-remove-requested"

echo "deploy-swarm tests passed"
