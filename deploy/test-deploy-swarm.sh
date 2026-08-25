#!/usr/bin/env bash

set -euo pipefail

readonly candidate_image="ghcr.io/starsnap/starsnap-website@sha256:1111111111111111111111111111111111111111111111111111111111111111"
readonly previous_image="ghcr.io/starsnap/starsnap-website@sha256:2222222222222222222222222222222222222222222222222222222222222222"
readonly caddy_image="docker.io/library/caddy:2.10.2-alpine@sha256:4c6e91c6ed0e2fa03efd5b44747b625fec79bc9cd06ac5235a779726618e530d"
export candidate_image previous_image caddy_image

test_root="$(mktemp -d)"
export FAKE_SWARM_STATE="$test_root/swarm"
export FAKE_FAIL_CANDIDATE=false
export FAKE_FAIL_CADDY_REDIRECT=false
export FAKE_SERVICE_LIST_ERROR=false

cleanup() {
  if [[ "$test_root" == /tmp/* || "$test_root" == /var/folders/* ]]; then
    find "$test_root" -depth -delete
  fi
}
trap cleanup EXIT

reset_state() {
  mkdir -p "$FAKE_SWARM_STATE"
  mkdir -p "$FAKE_SWARM_STATE/configs"
  printf '%s' "$previous_image" >"$FAKE_SWARM_STATE/current-image"
  printf '%s' "completed" >"$FAKE_SWARM_STATE/update-state"
  printf '%s' "1/1" >"$FAKE_SWARM_STATE/replicas"
  touch "$FAKE_SWARM_STATE/stack-exists"
  rm -f -- "$FAKE_SWARM_STATE/caddy-image"
  rm -f -- "$FAKE_SWARM_STATE/caddy-config"
  rm -f -- "$FAKE_SWARM_STATE/caddy-update-state"
  rm -f -- "$FAKE_SWARM_STATE/caddy-replicas"
  find "$FAKE_SWARM_STATE/configs" -type f -delete
  rm -f -- "$FAKE_SWARM_STATE/rollback-requested"
  rm -f -- "$FAKE_SWARM_STATE/caddy-rollback-requested"
  rm -f -- "$FAKE_SWARM_STATE/stack-remove-requested"
  rm -f -- "$FAKE_SWARM_STATE/pulled-image"
  export FAKE_FAIL_CANDIDATE=false
  export FAKE_FAIL_CADDY_REDIRECT=false
  export FAKE_SERVICE_LIST_ERROR=false
}

docker() {
  local config_name=""
  local config_source=""
  local digest_label=""
  local target=""

  case "$1 $2" in
    "info --format")
      printf '%s\n' "true"
      ;;
    "service inspect")
      target="${!#}"
      if [[ "$target" == "starsnap-company_website" ]]; then
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
        return 0
      fi

      if [[ "$target" != "starsnap-company_caddy" || ! -f "$FAKE_SWARM_STATE/caddy-image" ]]; then
        return 1
      fi
      if [[ " $* " == *" --format "* ]]; then
        if [[ " $* " == *"ContainerSpec.Image"* ]]; then
          cat "$FAKE_SWARM_STATE/caddy-image"
        elif [[ " $* " == *"ContainerSpec.Configs"* ]]; then
          cat "$FAKE_SWARM_STATE/caddy-config"
        else
          cat "$FAKE_SWARM_STATE/caddy-update-state"
        fi
      fi
      ;;
    "service ls")
      if [[ "$FAKE_SERVICE_LIST_ERROR" == "true" ]]; then
        return 1
      fi

      if [[ " $* " == *"name=starsnap-company_website"* ]]; then
        if [[ -f "$FAKE_SWARM_STATE/current-image" ]]; then
          printf '%s %s\n' "starsnap-company_website" "$(cat "$FAKE_SWARM_STATE/replicas")"
        fi
        return 0
      fi
      if [[ " $* " == *"name=starsnap-company_caddy"* ]]; then
        if [[ -f "$FAKE_SWARM_STATE/caddy-image" ]]; then
          printf '%s %s\n' "starsnap-company_caddy" "$(cat "$FAKE_SWARM_STATE/caddy-replicas")"
        fi
        return 0
      fi

      if [[ -f "$FAKE_SWARM_STATE/current-image" ]]; then
        printf '%s\n' "starsnap-company_website"
      fi
      if [[ -f "$FAKE_SWARM_STATE/caddy-image" ]]; then
        printf '%s\n' "starsnap-company_caddy"
      fi
      ;;
    "service ps")
      ;;
    "service rollback")
      target="${!#}"
      if [[ "$target" == "starsnap-company_website" ]]; then
        printf '%s' "$previous_image" >"$FAKE_SWARM_STATE/current-image"
        printf '%s' "rollback_completed" >"$FAKE_SWARM_STATE/update-state"
        touch "$FAKE_SWARM_STATE/rollback-requested"
      else
        printf '%s' "$caddy_image" >"$FAKE_SWARM_STATE/caddy-image"
        cat "$FAKE_SWARM_STATE/previous-caddy-config" >"$FAKE_SWARM_STATE/caddy-config"
        printf '%s' "rollback_completed" >"$FAKE_SWARM_STATE/caddy-update-state"
        touch "$FAKE_SWARM_STATE/caddy-rollback-requested"
      fi
      ;;
    "service rm")
      target="$3"
      if [[ "$target" == "starsnap-company_website" ]]; then
        rm -f -- "$FAKE_SWARM_STATE/current-image"
      else
        rm -f -- "$FAKE_SWARM_STATE/caddy-image"
        rm -f -- "$FAKE_SWARM_STATE/caddy-config"
        rm -f -- "$FAKE_SWARM_STATE/caddy-update-state"
        rm -f -- "$FAKE_SWARM_STATE/caddy-replicas"
      fi
      ;;
    "stack config")
      printf 'services:\n  caddy:\n    deploy:\n      placement:\n        constraints:\n          - node.role == manager\n    image: %s\n  website:\n    deploy:\n      placement:\n        constraints:\n          - node.role == manager\n    image: %s\nconfigs:\n  caddyfile:\n    name: %s\n' \
        "$caddy_image" "$STARSNAP_WEBSITE_IMAGE" "$CADDY_CONFIG_NAME"
      ;;
    "stack ls")
      if [[ -f "$FAKE_SWARM_STATE/stack-exists" ]]; then
        printf '%s\n' "starsnap-company"
      fi
      ;;
    pull\ *)
      printf '%s\n' "$2" >>"$FAKE_SWARM_STATE/pulled-image"
      ;;
    "run --rm")
      if [[ " $* " != *" $caddy_image "* || " $* " != *" validate --config - --adapter caddyfile "* ]]; then
        echo "Expected the pinned Caddy image to validate stdin." >&2
        return 1
      fi
      cat >/dev/null
      ;;
    "config ls")
      find "$FAKE_SWARM_STATE/configs" -type f -name '*.data' -printf '%f\n' \
        | sed 's/\.data$//'
      ;;
    "config inspect")
      target="${!#}"
      if [[ ! -f "$FAKE_SWARM_STATE/configs/$target.data" ]]; then
        return 1
      fi
      if [[ " $* " == *" --format "* ]]; then
        cat "$FAKE_SWARM_STATE/configs/$target.digest"
      fi
      ;;
    "config create")
      config_name="${*: -2:1}"
      config_source="${*: -1}"
      digest_label=""
      for target in "$@"; do
        if [[ "$target" == com.starsnap.config-sha256=* ]]; then
          digest_label="${target#*=}"
        fi
      done
      cp "$config_source" "$FAKE_SWARM_STATE/configs/$config_name.data"
      printf '%s' "$digest_label" >"$FAKE_SWARM_STATE/configs/$config_name.digest"
      ;;
    "config rm")
      target="$3"
      rm -f -- "$FAKE_SWARM_STATE/configs/$target.data" "$FAKE_SWARM_STATE/configs/$target.digest"
      ;;
    "stack deploy")
      if [[ " $* " != *" --with-registry-auth "* ]]; then
        echo "Expected registry credentials to be forwarded to Swarm." >&2
        return 1
      fi
      if ! grep -Fxq "$STARSNAP_WEBSITE_IMAGE" "$FAKE_SWARM_STATE/pulled-image" \
        || ! grep -Fxq "$caddy_image" "$FAKE_SWARM_STATE/pulled-image"; then
        echo "Expected both immutable images to be pulled before deployment." >&2
        return 1
      fi
      touch "$FAKE_SWARM_STATE/stack-exists"
      printf '%s' "$STARSNAP_WEBSITE_IMAGE" >"$FAKE_SWARM_STATE/current-image"
      printf '%s' "completed" >"$FAKE_SWARM_STATE/update-state"
      printf '%s' "$caddy_image" >"$FAKE_SWARM_STATE/caddy-image"
      printf '%s' "$CADDY_CONFIG_NAME" >"$FAKE_SWARM_STATE/caddy-config"
      printf '%s' "completed" >"$FAKE_SWARM_STATE/caddy-update-state"
      printf '%s' "1/1" >"$FAKE_SWARM_STATE/caddy-replicas"
      ;;
    "stack rm")
      rm -f -- "$FAKE_SWARM_STATE/current-image"
      rm -f -- "$FAKE_SWARM_STATE/caddy-image"
      rm -f -- "$FAKE_SWARM_STATE/caddy-config"
      rm -f -- "$FAKE_SWARM_STATE/caddy-update-state"
      rm -f -- "$FAKE_SWARM_STATE/caddy-replicas"
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
  local dump_header=""
  local host=""
  local output=""
  local current_image=""
  local index=1
  local args=("$@")

  while (( index <= ${#args[@]} )); do
    if [[ "${args[index - 1]}" == "--output" ]]; then
      output="${args[index]}"
    elif [[ "${args[index - 1]}" == "--dump-header" ]]; then
      dump_header="${args[index]}"
    elif [[ "${args[index - 1]}" == "--header" ]]; then
      host="${args[index]#Host: }"
    fi
    index=$((index + 1))
  done

  if [[ -n "$dump_header" ]]; then
    if [[ "$FAKE_FAIL_CADDY_REDIRECT" == "true" ]]; then
      printf 'HTTP/1.1 200 OK\r\n\r\n' >"$dump_header"
    elif [[ "$host" == "starsnap.kr" ]]; then
      printf 'HTTP/1.1 308 Permanent Redirect\r\nLocation: https://starsnap.kr/\r\n\r\n' >"$dump_header"
    elif [[ "$host" == "www.starsnap.kr" ]]; then
      printf 'HTTP/1.1 301 Moved Permanently\r\nLocation: https://starsnap.kr/\r\n\r\n' >"$dump_header"
    else
      return 22
    fi
    return 0
  fi

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
  STARSNAP_PROXY_HEALTH_URL="http://192.0.2.1/" \
  STARSNAP_ROLLOUT_TIMEOUT_SECONDS=1 \
  STARSNAP_ROLLBACK_TIMEOUT_SECONDS=1 \
  STARSNAP_CLEANUP_TIMEOUT_SECONDS=1 \
  STARSNAP_WEBSITE_IMAGE="$candidate_image" \
    bash deploy/deploy-swarm.sh
}

reset_state
success_output="$(run_deploy 2>&1)"
grep -Fq "Deployment verified: $candidate_image" <<<"$success_output"
grep -Fq "Caddy verified: $caddy_image" <<<"$success_output"
test ! -e "$FAKE_SWARM_STATE/rollback-requested"
test -e "$FAKE_SWARM_STATE/caddy-image"
test -e "$FAKE_SWARM_STATE/caddy-config"

reset_state
export FAKE_FAIL_CANDIDATE=true
if failure_output="$(run_deploy 2>&1)"; then
  echo "Expected the failed health verification to fail the deployment." >&2
  exit 1
fi
grep -Fq "Website rollback verified: $previous_image" <<<"$failure_output"
test -e "$FAKE_SWARM_STATE/rollback-requested"
test "$(cat "$FAKE_SWARM_STATE/current-image")" = "$previous_image"
test ! -e "$FAKE_SWARM_STATE/caddy-image"
test -z "$(find "$FAKE_SWARM_STATE/configs" -type f -name '*.data' -print -quit)"

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
test ! -e "$FAKE_SWARM_STATE/caddy-image"
test ! -e "$FAKE_SWARM_STATE/stack-exists"

reset_state
export FAKE_FAIL_CADDY_REDIRECT=true
if redirect_failure_output="$(run_deploy 2>&1)"; then
  echo "Expected an invalid Caddy redirect to fail the deployment." >&2
  exit 1
fi
grep -Fq "Timed out waiting for the Caddy deploy operation" <<<"$redirect_failure_output"
grep -Fq "Website rollback verified: $previous_image" <<<"$redirect_failure_output"
test ! -e "$FAKE_SWARM_STATE/caddy-image"
test -z "$(find "$FAKE_SWARM_STATE/configs" -type f -name '*.data' -print -quit)"

reset_state
export FAKE_SERVICE_LIST_ERROR=true
if run_deploy >/dev/null 2>&1; then
  echo "Expected a Swarm service-list API failure to stop deployment." >&2
  exit 1
fi
test "$(cat "$FAKE_SWARM_STATE/current-image")" = "$previous_image"
test ! -e "$FAKE_SWARM_STATE/rollback-requested"
test ! -e "$FAKE_SWARM_STATE/stack-remove-requested"

echo "deploy-swarm tests passed"
