#!/usr/bin/env bash

set -Eeuo pipefail

readonly expected_image_pattern='^ghcr\.io/starsnap/starsnap-website@sha256:[0-9a-f]{64}$'
readonly stack_file="deploy/docker-stack.yml"
readonly caddy_config_file="deploy/Caddyfile"
readonly caddy_image="docker.io/library/caddy:2.10.2-alpine@sha256:4c6e91c6ed0e2fa03efd5b44747b625fec79bc9cd06ac5235a779726618e530d"
readonly rollout_timeout_seconds="${STARSNAP_ROLLOUT_TIMEOUT_SECONDS:-300}"
readonly rollback_timeout_seconds="${STARSNAP_ROLLBACK_TIMEOUT_SECONDS:-240}"
readonly cleanup_timeout_seconds="${STARSNAP_CLEANUP_TIMEOUT_SECONDS:-60}"

: "${STACK_NAME:=starsnap-company}"
: "${SERVICE_NAME:=${STACK_NAME}_website}"
: "${STARSNAP_HEALTH_URL:?STARSNAP_HEALTH_URL is required}"
: "${STARSNAP_PROXY_HEALTH_URL:?STARSNAP_PROXY_HEALTH_URL is required}"
: "${STARSNAP_WEBSITE_IMAGE:?STARSNAP_WEBSITE_IMAGE is required}"
: "${RUNNER_TEMP:?RUNNER_TEMP is required}"

readonly response_file="$RUNNER_TEMP/starsnap-index.html"
readonly caddy_headers_file="$RUNNER_TEMP/starsnap-caddy-headers.txt"
readonly caddy_service_name="${STACK_NAME}_caddy"

rendered_stack=""
previous_image=""
previous_caddy_image=""
previous_caddy_config=""
previous_caddy_spec_digest=""
deployment_started=false
previous_service_exists=false
previous_caddy_service_exists=false
previous_stack_exists=false
created_caddy_config=false
service_names=""
stack_names=""
caddy_config_digest=""
CADDY_CONFIG_NAME=""
proxy_address=""

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

if [[ ! "$STARSNAP_PROXY_HEALTH_URL" =~ ^http://[^/?#]+/$ ]]; then
  echo "STARSNAP_PROXY_HEALTH_URL must be an HTTP origin ending in /." >&2
  exit 1
fi

proxy_address="${STARSNAP_PROXY_HEALTH_URL#http://}"
proxy_address="${proxy_address%/}"
if [[ ! "$proxy_address" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]; then
  echo "STARSNAP_PROXY_HEALTH_URL must use the Swarm manager's IPv4 address." >&2
  exit 1
fi

if [[ ! -f "$caddy_config_file" ]]; then
  echo "Missing Caddy configuration: $caddy_config_file" >&2
  exit 1
fi

caddy_config_digest="$(sha256sum "$caddy_config_file" | awk '{print $1}')"
CADDY_CONFIG_NAME="${STACK_NAME}_caddyfile_${caddy_config_digest:0:16}"
export CADDY_CONFIG_NAME

service_image() {
  local target_service="$1"

  docker service inspect \
    --format '{{.Spec.TaskTemplate.ContainerSpec.Image}}' \
    "$target_service"
}

service_replicas() {
  local target_service="$1"

  docker service ls \
    --filter "name=$target_service" \
    --format '{{.Name}} {{.Replicas}}' \
    | awk -v target="$target_service" '$1 == target { print $2; exit }'
}

service_update_state() {
  local target_service="$1"

  docker service inspect \
    --format '{{if .UpdateStatus}}{{.UpdateStatus.State}}{{else}}completed{{end}}' \
    "$target_service"
}

service_caddy_config() {
  docker service inspect \
    --format '{{range .Spec.TaskTemplate.ContainerSpec.Configs}}{{if eq .File.Name "/etc/caddy/Caddyfile"}}{{.ConfigName}}{{end}}{{end}}' \
    "$caddy_service_name"
}

service_spec_digest() {
  local target_service="$1"

  docker service inspect \
    --format '{{json .Spec}}' \
    "$target_service" \
    | sha256sum \
    | awk '{print $1}'
}

verify_website_http_once() {
  curl --fail --silent --show-error --max-time 10 \
    --output "$response_file" \
    "$STARSNAP_HEALTH_URL" \
    && grep -Fq "StarSnap" "$response_file" \
    && curl --fail --silent --show-error --max-time 10 \
      --output /dev/null \
      "${STARSNAP_HEALTH_URL%/}/icon.png"
}

verify_redirect() {
  local host="$1"
  local expected_status="$2"
  local expected_location="$3"
  local location=""
  local status=""

  if ! curl --silent --show-error --max-time 10 \
    --dump-header "$caddy_headers_file" \
    --output /dev/null \
    --header "Host: $host" \
    "$STARSNAP_PROXY_HEALTH_URL"; then
    return 1
  fi

  status="$(awk 'toupper($1) ~ /^HTTP\// { value=$2 } END { print value }' "$caddy_headers_file")"
  location="$(awk 'tolower($1) == "location:" { $1=""; sub(/^[[:space:]]+/, ""); sub(/\r$/, ""); value=$0 } END { print value }' "$caddy_headers_file")"

  [[ "$status" == "$expected_status" && "$location" == "$expected_location" ]]
}

verify_caddy_http_once() {
  verify_redirect "starsnap.kr" "308" "https://starsnap.kr/" \
    && verify_redirect "www.starsnap.kr" "301" "https://starsnap.kr/" \
    && verify_redirect "api.starsnap.kr" "308" "https://api.starsnap.kr/"
}

verify_caddy_https_once() {
  if ! curl --fail --silent --show-error --max-time 15 \
    --resolve "starsnap.kr:443:$proxy_address" \
    --output "$response_file" \
    "https://starsnap.kr/"; then
    return 1
  fi

  if ! grep -Fq "StarSnap" "$response_file"; then
    return 1
  fi

  if ! curl --fail --silent --show-error --max-time 15 \
    --resolve "starsnap.kr:443:$proxy_address" \
    --output /dev/null \
    "https://starsnap.kr/icon.png"; then
    return 1
  fi

  if ! curl --fail --silent --show-error --max-time 15 \
    --resolve "api.starsnap.kr:443:$proxy_address" \
    --output "$response_file" \
    "https://api.starsnap.kr/api/health"; then
    return 1
  fi

  if ! grep -Fq '"status":"ok"' "$response_file"; then
    return 1
  fi

  if ! curl --silent --show-error --max-time 15 \
    --resolve "www.starsnap.kr:443:$proxy_address" \
    --dump-header "$caddy_headers_file" \
    --output /dev/null \
    "https://www.starsnap.kr/"; then
    return 1
  fi

  local location=""
  local status=""
  status="$(awk 'toupper($1) ~ /^HTTP\// { value=$2 } END { print value }' "$caddy_headers_file")"
  location="$(awk 'tolower($1) == "location:" { $1=""; sub(/^[[:space:]]+/, ""); sub(/\r$/, ""); value=$0 } END { print value }' "$caddy_headers_file")"

  [[ "$status" == "301" && "$location" == "https://starsnap.kr/" ]]
}

verify_caddy_routes_once() {
  verify_caddy_http_once && verify_caddy_https_once
}

wait_for_website() {
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

    current_image="$(service_image "$SERVICE_NAME" 2>/dev/null || true)"
    replicas="$(service_replicas "$SERVICE_NAME" 2>/dev/null || true)"
    update_state="$(service_update_state "$SERVICE_NAME" 2>/dev/null || true)"

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
        if verify_website_http_once; then
          return 0
        fi
      fi
    fi

    sleep 3
  done

  echo "Timed out waiting for the $mode operation to converge." >&2
  return 1
}

wait_for_caddy() {
  local expected_image="$1"
  local expected_config="$2"
  local timeout_seconds="$3"
  local mode="$4"
  local verify_routes="$5"
  local current_config=""
  local current_image=""
  local deadline=$((SECONDS + timeout_seconds))
  local replicas=""
  local update_state=""

  while (( SECONDS < deadline )); do
    if ! docker service inspect "$caddy_service_name" >/dev/null 2>&1; then
      sleep 2
      continue
    fi

    current_image="$(service_image "$caddy_service_name" 2>/dev/null || true)"
    current_config="$(service_caddy_config 2>/dev/null || true)"
    replicas="$(service_replicas "$caddy_service_name" 2>/dev/null || true)"
    update_state="$(service_update_state "$caddy_service_name" 2>/dev/null || true)"

    case "$update_state" in
      paused|rollback_paused)
        echo "Swarm paused Caddy in state: $update_state" >&2
        return 1
        ;;
      rollback_started|rollback_completed)
        if [[ "$mode" != "rollback" ]]; then
          echo "Swarm rolled back Caddy: $update_state" >&2
          return 1
        fi
        ;;
    esac

    if [[ "$current_image" == "$expected_image" \
      && "$current_config" == "$expected_config" \
      && "$replicas" == "1/1" ]]; then
      if [[ "$mode" == "deploy" && "$update_state" == "completed" ]] \
        || [[ "$mode" == "rollback" && "$update_state" =~ ^(completed|rollback_completed)$ ]]; then
        if [[ "$verify_routes" != "true" ]] || verify_caddy_routes_once; then
          return 0
        fi
      fi
    fi

    sleep 3
  done

  echo "Timed out waiting for the Caddy $mode operation to converge." >&2
  return 1
}

remove_new_service() {
  local target_service="$1"
  local deadline=$((SECONDS + cleanup_timeout_seconds))
  local current_service_names=""

  if ! current_service_names="$(docker service ls --format '{{.Name}}')"; then
    echo "Could not list Swarm services before cleanup." >&2
    return 1
  fi

  if ! grep -Fxq "$target_service" <<<"$current_service_names"; then
    return 0
  fi

  echo "Removing newly created service: $target_service" >&2
  if ! docker service rm "$target_service" >&2; then
    echo "Swarm rejected removal of $target_service." >&2
    return 1
  fi

  while (( SECONDS < deadline )); do
    if ! current_service_names="$(docker service ls --format '{{.Name}}')"; then
      echo "Could not list Swarm services while verifying cleanup; retrying." >&2
      sleep 2
      continue
    fi

    if ! grep -Fxq "$target_service" <<<"$current_service_names"; then
      return 0
    fi
    sleep 2
  done

  echo "Timed out waiting for $target_service to disappear." >&2
  docker service ps --no-trunc "$target_service" >&2 || true
  return 1
}

restore_website_after_failure() {
  local current_image=""

  if [[ "$previous_service_exists" != "true" ]]; then
    remove_new_service "$SERVICE_NAME"
    return $?
  fi

  current_image="$(service_image "$SERVICE_NAME" 2>/dev/null || true)"
  if [[ "$current_image" != "$previous_image" ]]; then
    echo "Requesting website rollback to the previous service specification." >&2
    if ! docker service rollback --detach "$SERVICE_NAME" >&2; then
      echo "Swarm rejected the website rollback request." >&2
      return 1
    fi
  else
    echo "Swarm already restored the previous website image; verifying recovery." >&2
  fi

  if wait_for_website "$previous_image" "$rollback_timeout_seconds" rollback; then
    echo "Website rollback verified: $previous_image" >&2
    return 0
  fi

  echo "Rollback did not restore a healthy previous website deployment." >&2
  docker service ps --no-trunc "$SERVICE_NAME" >&2 || true
  return 1
}

restore_caddy_after_failure() {
  local current_config=""
  local current_image=""
  local current_spec_digest=""

  if [[ "$previous_caddy_service_exists" != "true" ]]; then
    remove_new_service "$caddy_service_name"
    return $?
  fi

  current_image="$(service_image "$caddy_service_name" 2>/dev/null || true)"
  current_config="$(service_caddy_config 2>/dev/null || true)"
  current_spec_digest="$(service_spec_digest "$caddy_service_name" 2>/dev/null || true)"
  if [[ "$current_spec_digest" != "$previous_caddy_spec_digest" ]]; then
    echo "Requesting Caddy rollback to the previous service specification." >&2
    if ! docker service rollback --detach "$caddy_service_name" >&2; then
      echo "Swarm rejected the Caddy rollback request." >&2
      return 1
    fi
  else
    echo "Swarm already restored the previous Caddy specification; verifying recovery." >&2
  fi

  if wait_for_caddy "$previous_caddy_image" "$previous_caddy_config" "$rollback_timeout_seconds" rollback false \
    && [[ "$(service_spec_digest "$caddy_service_name" 2>/dev/null || true)" == "$previous_caddy_spec_digest" ]]; then
    echo "Caddy rollback verified: $previous_caddy_config" >&2
    return 0
  fi

  echo "Rollback did not restore the previous Caddy deployment." >&2
  docker service ps --no-trunc "$caddy_service_name" >&2 || true
  return 1
}

restore_absent_stack() {
  local deadline=$((SECONDS + cleanup_timeout_seconds))
  local current_service_names=""

  if ! current_service_names="$(docker service ls --format '{{.Name}}')"; then
    echo "Could not list Swarm services before cleanup." >&2
    return 1
  fi

  if ! grep -Fxq "$SERVICE_NAME" <<<"$current_service_names" \
    && ! grep -Fxq "$caddy_service_name" <<<"$current_service_names"; then
    echo "Failed initial deployment left no stack services to remove." >&2
    return 0
  fi

  echo "Removing the failed initial stack." >&2
  if ! docker stack rm "$STACK_NAME" >&2; then
    echo "Swarm rejected removal of the failed initial stack." >&2
    return 1
  fi

  while (( SECONDS < deadline )); do
    if ! current_service_names="$(docker service ls --format '{{.Name}}')"; then
      echo "Could not list Swarm services while verifying cleanup; retrying." >&2
      sleep 2
      continue
    fi

    if ! grep -Fxq "$SERVICE_NAME" <<<"$current_service_names" \
      && ! grep -Fxq "$caddy_service_name" <<<"$current_service_names"; then
      echo "Initial deployment cleanup verified." >&2
      return 0
    fi
    sleep 2
  done

  echo "Timed out waiting for the failed initial stack services to disappear." >&2
  docker service ps --no-trunc "$SERVICE_NAME" >&2 || true
  docker service ps --no-trunc "$caddy_service_name" >&2 || true
  return 1
}

# Invoked indirectly by the EXIT trap.
# shellcheck disable=SC2329
rollback_after_failure() {
  local rollback_failed=false

  if [[ "$previous_stack_exists" != "true" ]]; then
    restore_absent_stack
    return $?
  fi

  restore_caddy_after_failure || rollback_failed=true
  restore_website_after_failure || rollback_failed=true

  [[ "$rollback_failed" == "false" ]]
}

cleanup_created_caddy_config() {
  if [[ "$created_caddy_config" != "true" ]]; then
    return 0
  fi

  if ! docker config inspect "$CADDY_CONFIG_NAME" >/dev/null 2>&1; then
    return 0
  fi

  if ! docker config rm "$CADDY_CONFIG_NAME" >&2; then
    echo "Could not remove the unused Caddy config: $CADDY_CONFIG_NAME" >&2
    return 1
  fi
}

ensure_caddy_config() {
  local config_names=""
  local existing_digest=""

  if ! config_names="$(docker config ls --format '{{.Name}}')"; then
    echo "Could not list Swarm configs." >&2
    return 1
  fi

  if grep -Fxq "$CADDY_CONFIG_NAME" <<<"$config_names"; then
    existing_digest="$(docker config inspect \
      --format '{{index .Spec.Labels "com.starsnap.config-sha256"}}' \
      "$CADDY_CONFIG_NAME")"
    if [[ "$existing_digest" != "$caddy_config_digest" ]]; then
      echo "Existing Caddy config has an unexpected content label." >&2
      return 1
    fi
    return 0
  fi

  if ! docker config create \
    --label "com.starsnap.config-sha256=$caddy_config_digest" \
    --label "com.starsnap.stack=$STACK_NAME" \
    "$CADDY_CONFIG_NAME" \
    "$caddy_config_file" >/dev/null; then
    echo "Could not create the content-addressed Caddy config." >&2
    return 1
  fi

  created_caddy_config=true
}

# Invoked indirectly by the EXIT trap.
# shellcheck disable=SC2329
on_exit() {
  local status=$?

  trap - EXIT
  set +e

  if (( status != 0 )) && [[ "$deployment_started" == "true" ]]; then
    docker service ps --no-trunc "$SERVICE_NAME" >&2 || true
    docker service ps --no-trunc "$caddy_service_name" >&2 || true
    rollback_after_failure || true
  fi

  if (( status != 0 )); then
    cleanup_created_caddy_config || true
  fi

  if [[ -n "$rendered_stack" ]]; then
    rm -f -- "$rendered_stack"
  fi
  rm -f -- "$response_file" "$caddy_headers_file"

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
  previous_image="$(service_image "$SERVICE_NAME")"
fi

if grep -Fxq "$caddy_service_name" <<<"$service_names"; then
  previous_caddy_service_exists=true
  previous_caddy_image="$(service_image "$caddy_service_name")"
  previous_caddy_config="$(service_caddy_config)"
  previous_caddy_spec_digest="$(service_spec_digest "$caddy_service_name")"
fi

if ! docker pull "$STARSNAP_WEBSITE_IMAGE" >/dev/null; then
  echo "Could not pull the verified website image on the Swarm manager." >&2
  exit 1
fi

if ! docker pull "$caddy_image" >/dev/null; then
  echo "Could not pull the pinned Caddy image on the Swarm manager." >&2
  exit 1
fi

if ! docker run --rm --interactive --entrypoint caddy "$caddy_image" \
  validate --config - --adapter caddyfile <"$caddy_config_file"; then
  echo "Caddy rejected the committed configuration." >&2
  exit 1
fi

ensure_caddy_config

rendered_stack="$(mktemp)"
docker stack config --compose-file "$stack_file" >"$rendered_stack"

if ! grep -Fq "image: $STARSNAP_WEBSITE_IMAGE" "$rendered_stack"; then
  echo "Rendered stack does not contain the expected immutable image." >&2
  exit 1
fi

if ! grep -Fq "image: $caddy_image" "$rendered_stack"; then
  echo "Rendered stack does not contain the pinned Caddy image." >&2
  exit 1
fi

if ! grep -Fq "name: $CADDY_CONFIG_NAME" "$rendered_stack"; then
  echo "Rendered stack does not reference the expected Caddy config." >&2
  exit 1
fi

if [[ "$(grep -Fc "node.role == manager" "$rendered_stack")" -lt 2 ]]; then
  echo "Rendered stack must keep both services on the Swarm manager." >&2
  exit 1
fi

if ! grep -Fq "node.labels.starsnap.actions-runner == true" "$rendered_stack"; then
  echo "Rendered stack must pin Caddy's local certificate volumes to the runner manager." >&2
  exit 1
fi

deployment_started=true
docker stack deploy \
  --compose-file "$rendered_stack" \
  --resolve-image never \
  --with-registry-auth \
  "$STACK_NAME"

wait_for_website "$STARSNAP_WEBSITE_IMAGE" "$rollout_timeout_seconds" deploy
wait_for_caddy "$caddy_image" "$CADDY_CONFIG_NAME" "$rollout_timeout_seconds" deploy true

echo "Deployment verified: $STARSNAP_WEBSITE_IMAGE"
echo "Caddy verified: $caddy_image ($CADDY_CONFIG_NAME)"
