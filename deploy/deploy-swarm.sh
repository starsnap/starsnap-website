#!/usr/bin/env bash

set -Eeuo pipefail

readonly expected_image_pattern='^ghcr\.io/starsnap/starsnap-website@sha256:[0-9a-f]{64}$'
readonly stack_file="deploy/docker-stack.yml"
readonly rollout_timeout_seconds=300
readonly rollback_timeout_seconds=240
readonly cleanup_timeout_seconds=60

: "${STACK_NAME:=starsnap-company}"
: "${SERVICE_NAME:=${STACK_NAME}_website}"
: "${STARSNAP_HEALTH_URL:?STARSNAP_HEALTH_URL is required}"
: "${STARSNAP_WEBSITE_IMAGE:?STARSNAP_WEBSITE_IMAGE is required}"
: "${RUNNER_TEMP:?RUNNER_TEMP is required}"

readonly response_file="$RUNNER_TEMP/starsnap-index.html"

rendered_stack=""
previous_image=""
deployment_started=false
previous_service_exists=false
previous_stack_exists=false
service_names=""
stack_names=""

if [[ ! "$STARSNAP_WEBSITE_IMAGE" =~ $expected_image_pattern ]]; then
  echo "Refusing to deploy a mutable or unexpected image reference." >&2
  exit 1
fi

if [[ ! "$STACK_NAME" =~ ^[a-z0-9][a-z0-9_-]*$ ]]; then
  echo "Invalid stack name." >&2
  exit 1
fi

if [[ "$SERVICE_NAME" != "${STACK_NAME}_website" ]]; then
  echo "Unexpected service name." >&2
  exit 1
fi

service_image() {
  docker service inspect \
    --format '{{.Spec.TaskTemplate.ContainerSpec.Image}}' \
    "$SERVICE_NAME"
}

service_replicas() {
  docker service ls \
    --filter "name=$SERVICE_NAME" \
    --format '{{.Name}} {{.Replicas}}' \
    | awk -v target="$SERVICE_NAME" '$1 == target { print $2; exit }'
}

service_update_state() {
  docker service inspect \
    --format '{{if .UpdateStatus}}{{.UpdateStatus.State}}{{else}}completed{{end}}' \
    "$SERVICE_NAME"
}

verify_http_once() {
  curl --fail --silent --show-error --max-time 10 \
    --output "$response_file" \
    "$STARSNAP_HEALTH_URL" \
    && grep -Fq "StarSnap" "$response_file" \
    && curl --fail --silent --show-error --max-time 10 \
      --output /dev/null \
      "${STARSNAP_HEALTH_URL%/}/icon.png"
}

wait_for_service() {
  local expected_image="$1"
  local timeout_seconds="$2"
  local mode="$3"
  local current_image=""
  local deadline=$((SECONDS + timeout_seconds))
  local replicas=""
  local update_state=""

  while (( SECONDS < deadline )); do
    if ! docker service inspect "$SERVICE_NAME" >/dev/null 2>&1; then
      sleep 2
      continue
    fi

    current_image="$(service_image 2>/dev/null || true)"
    replicas="$(service_replicas 2>/dev/null || true)"
    update_state="$(service_update_state 2>/dev/null || true)"

    case "$update_state" in
      paused|rollback_paused)
        echo "Swarm paused the service in state: $update_state" >&2
        return 1
        ;;
      rollback_started|rollback_completed)
        if [[ "$mode" != "rollback" ]]; then
          echo "Swarm rolled back the deployment: $update_state" >&2
          return 1
        fi
        ;;
    esac

    if [[ "$current_image" == "$expected_image" && "$replicas" == "1/1" ]]; then
      if [[ "$mode" == "deploy" && "$update_state" == "completed" ]] \
        || [[ "$mode" == "rollback" && "$update_state" =~ ^(completed|rollback_completed)$ ]]; then
        if verify_http_once; then
          return 0
        fi
      fi
    fi

    sleep 3
  done

  echo "Timed out waiting for the $mode operation to converge." >&2
  return 1
}

# Invoked indirectly by the EXIT trap.
# shellcheck disable=SC2329
rollback_after_failure() {
  local current_image=""

  if [[ "$previous_service_exists" != "true" ]]; then
    restore_absent_state
    return $?
  fi

  current_image="$(service_image 2>/dev/null || true)"
  if [[ "$current_image" != "$previous_image" ]]; then
    echo "Requesting rollback to the previous service specification." >&2
    if ! docker service rollback --detach "$SERVICE_NAME" >&2; then
      echo "Swarm rejected the rollback request." >&2
      return 1
    fi
  else
    echo "Swarm already restored the previous image; verifying recovery." >&2
  fi

  if wait_for_service "$previous_image" "$rollback_timeout_seconds" rollback; then
    echo "Rollback verified: $previous_image" >&2
    return 0
  fi

  echo "Rollback did not restore a healthy previous deployment." >&2
  docker service ps --no-trunc "$SERVICE_NAME" >&2 || true
  return 1
}

# Reached through rollback_after_failure from the EXIT trap.
# shellcheck disable=SC2329
restore_absent_state() {
  local deadline=$((SECONDS + cleanup_timeout_seconds))
  local current_service_names=""

  if ! current_service_names="$(docker service ls --format '{{.Name}}')"; then
    echo "Could not list Swarm services before cleanup." >&2
    return 1
  fi

  if ! grep -Fxq "$SERVICE_NAME" <<<"$current_service_names"; then
    echo "Failed initial deployment left no service to remove." >&2
    return 0
  fi

  if [[ "$previous_stack_exists" == "true" ]]; then
    echo "Removing the newly created service from the existing stack." >&2
    if ! docker service rm "$SERVICE_NAME" >&2; then
      echo "Swarm rejected removal of the failed new service." >&2
      return 1
    fi
  else
    echo "Removing the failed initial stack." >&2
    if ! docker stack rm "$STACK_NAME" >&2; then
      echo "Swarm rejected removal of the failed initial stack." >&2
      return 1
    fi
  fi

  while (( SECONDS < deadline )); do
    if ! current_service_names="$(docker service ls --format '{{.Name}}')"; then
      echo "Could not list Swarm services while verifying cleanup; retrying." >&2
      sleep 2
      continue
    fi

    if ! grep -Fxq "$SERVICE_NAME" <<<"$current_service_names"; then
      echo "Initial deployment cleanup verified." >&2
      return 0
    fi
    sleep 2
  done

  echo "Timed out waiting for the failed initial service to disappear." >&2
  docker service ps --no-trunc "$SERVICE_NAME" >&2 || true
  return 1
}

# Invoked indirectly by the EXIT trap.
# shellcheck disable=SC2329
on_exit() {
  local status=$?

  trap - EXIT
  set +e

  if (( status != 0 )) && [[ "$deployment_started" == "true" ]]; then
    docker service ps --no-trunc "$SERVICE_NAME" >&2 || true
    rollback_after_failure || true
  fi

  if [[ -n "$rendered_stack" ]]; then
    rm -f -- "$rendered_stack"
  fi
  rm -f -- "$response_file"

  exit "$status"
}

trap on_exit EXIT

if [[ "$(docker info --format '{{.Swarm.ControlAvailable}}')" != "true" ]]; then
  echo "This job must run against a Docker Swarm manager." >&2
  exit 1
fi

stack_names="$(docker stack ls --format '{{.Name}}')"
if grep -Fxq "$STACK_NAME" <<<"$stack_names"; then
  previous_stack_exists=true
fi

service_names="$(docker service ls --format '{{.Name}}')"
if grep -Fxq "$SERVICE_NAME" <<<"$service_names"; then
  previous_service_exists=true
  previous_image="$(service_image)"
fi

rendered_stack="$(mktemp)"
docker stack config --compose-file "$stack_file" >"$rendered_stack"

if ! grep -Fq "image: $STARSNAP_WEBSITE_IMAGE" "$rendered_stack"; then
  echo "Rendered stack does not contain the expected immutable image." >&2
  exit 1
fi

deployment_started=true
docker stack deploy \
  --compose-file "$rendered_stack" \
  --resolve-image never \
  "$STACK_NAME"

if wait_for_service "$STARSNAP_WEBSITE_IMAGE" "$rollout_timeout_seconds" deploy; then
  echo "Deployment verified: $STARSNAP_WEBSITE_IMAGE"
  exit 0
fi

echo "Deployment verification failed." >&2
exit 1
