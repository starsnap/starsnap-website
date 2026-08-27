#!/usr/bin/env bash

set -Eeuo pipefail

readonly expected_image_pattern='^ghcr\.io/starsnap/starsnap-website@sha256:[0-9a-f]{64}$'
readonly stack_file="deploy/docker-stack.yml"
readonly caddy_config_file="deploy/Caddyfile"
readonly internal_route_verifier="deploy/verify-internal.mjs"
readonly caddy_image="docker.io/library/caddy:2.10.2-alpine@sha256:4c6e91c6ed0e2fa03efd5b44747b625fec79bc9cd06ac5235a779726618e530d"
readonly api_network_name="starsnap-main_app-net"
readonly api_service_name="starsnap-main_api"
readonly rollout_timeout_seconds="${STARSNAP_ROLLOUT_TIMEOUT_SECONDS:-300}"
readonly rollback_timeout_seconds="${STARSNAP_ROLLBACK_TIMEOUT_SECONDS:-240}"
readonly cleanup_timeout_seconds="${STARSNAP_CLEANUP_TIMEOUT_SECONDS:-60}"

: "${STACK_NAME:=starsnap-company}"
: "${SERVICE_NAME:=${STACK_NAME}_website}"
: "${INTERNAL_VERIFIER_SERVICE_NAME:=starsnap-erp_web}"
: "${STARSNAP_WEBSITE_IMAGE:?STARSNAP_WEBSITE_IMAGE is required}"

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
api_network_details=""
api_network_driver=""
api_network_scope=""
api_network_id=""
api_service_network_ids=""
current_node_id=""
current_node_runner_label=""
labeled_runner_node_ids=""
labeled_runner_node_count=""
labeled_runner_node_id=""

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

if [[ ! -f "$caddy_config_file" ]]; then
  echo "Missing Caddy configuration: $caddy_config_file" >&2
  exit 1
fi

if [[ ! -f "$internal_route_verifier" ]]; then
  echo "Missing internal route verifier: $internal_route_verifier" >&2
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

normalize_docker_hub_library_image() {
  local image_reference="$1"

  case "$image_reference" in
    docker.io/library/*)
      image_reference="${image_reference#docker.io/library/}"
      ;;
    index.docker.io/library/*)
      image_reference="${image_reference#index.docker.io/library/}"
      ;;
    library/*)
      image_reference="${image_reference#library/}"
      ;;
  esac

  # Only canonicalize immutable, single-component Docker Hub official images.
  # The repository, optional tag, digest algorithm, and digest remain part of
  # the comparison; this must never degrade into a digest-only match.
  if [[ ! "$image_reference" =~ ^[a-z0-9][a-z0-9._-]*(:[A-Za-z0-9_][A-Za-z0-9._-]*)?@sha256:[0-9a-f]{64}$ ]]; then
    return 1
  fi

  printf 'docker.io/library/%s\n' "$image_reference"
}

docker_hub_library_images_match() {
  local actual_image="$1"
  local expected_image="$2"
  local normalized_actual=""
  local normalized_expected=""

  normalized_actual="$(normalize_docker_hub_library_image "$actual_image")" || return 1
  normalized_expected="$(normalize_docker_hub_library_image "$expected_image")" || return 1

  [[ "$normalized_actual" == "$normalized_expected" ]]
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

service_container_id() {
  local target_service="$1"
  local container_count=""
  local container_ids=""

  container_ids="$(docker ps \
    --filter "label=com.docker.swarm.service.name=$target_service" \
    --filter "status=running" \
    --format '{{.ID}}')"
  container_count="$(awk 'NF { count++ } END { print count + 0 }' <<<"$container_ids")"

  if [[ "$container_count" != "1" ]]; then
    return 1
  fi

  printf '%s\n' "$container_ids"
}

service_health_status() {
  local target_service="$1"
  local container_id=""

  if ! container_id="$(service_container_id "$target_service")"; then
    printf '%s\n' "not-ready"
    return 0
  fi

  docker inspect \
    --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' \
    "$container_id"
}

verify_internal_routes_once() {
  local verifier_container_id=""

  if ! verifier_container_id="$(service_container_id "$INTERNAL_VERIFIER_SERVICE_NAME")"; then
    return 1
  fi

  # The ERP task is attached to the shared application overlay used by Caddy
  # and the migrated services. This keeps verification off the manager LAN and
  # preserves normal CA/hostname validation for every public hostname.
  docker exec --interactive "$verifier_container_id" \
    node --input-type=module <"$internal_route_verifier"
}

wait_for_website() {
  local expected_image="$1"
  local timeout_seconds="$2"
  local mode="$3"
  local current_image=""
  local health_status=""
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
    health_status="$(service_health_status "$SERVICE_NAME" 2>/dev/null || true)"

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

    if [[ "$current_image" == "$expected_image" \
      && "$replicas" == "1/1" \
      && "$health_status" == "healthy" ]]; then
      if [[ "$mode" == "deploy" && "$update_state" == "completed" ]] \
        || [[ "$mode" == "rollback" && "$update_state" =~ ^(completed|rollback_completed)$ ]]; then
        return 0
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
  local current_config=""
  local current_image=""
  local health_status=""
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
    health_status="$(service_health_status "$caddy_service_name" 2>/dev/null || true)"

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

    if docker_hub_library_images_match "$current_image" "$expected_image" \
      && [[ "$current_config" == "$expected_config" \
      && "$replicas" == "1/1" \
      && "$health_status" == "healthy" ]]; then
      if [[ "$mode" == "deploy" && "$update_state" == "completed" ]] \
        || [[ "$mode" == "rollback" && "$update_state" =~ ^(completed|rollback_completed)$ ]]; then
        if [[ "$mode" == "rollback" ]] || verify_internal_routes_once; then
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

  if wait_for_caddy "$previous_caddy_image" "$previous_caddy_config" "$rollback_timeout_seconds" rollback \
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
  exit "$status"
}

trap on_exit EXIT

if [[ "$(docker info --format '{{.Swarm.ControlAvailable}}')" != "true" ]]; then
  echo "This job must run against a Docker Swarm manager." >&2
  exit 1
fi

if ! current_node_id="$(docker info --format '{{.Swarm.NodeID}}')" \
  || [[ -z "$current_node_id" ]]; then
  echo "Could not determine the current Swarm manager node ID." >&2
  exit 1
fi

if ! current_node_runner_label="$(docker node inspect \
  --format '{{index .Spec.Labels "starsnap.actions-runner"}}' \
  "$current_node_id")"; then
  echo "Could not inspect the current Swarm manager node." >&2
  exit 1
fi

if [[ "$current_node_runner_label" != "true" ]]; then
  echo "Current Swarm manager must have starsnap.actions-runner=true." >&2
  exit 1
fi

if ! labeled_runner_node_ids="$(docker node ls \
  --filter 'node.label=starsnap.actions-runner=true' \
  --format '{{.ID}}')"; then
  echo "Could not list Swarm nodes carrying starsnap.actions-runner=true." >&2
  exit 1
fi

labeled_runner_node_count="$(awk 'NF { count++ } END { print count + 0 }' \
  <<<"$labeled_runner_node_ids")"
if [[ "$labeled_runner_node_count" != "1" ]]; then
  echo "Expected exactly one Swarm node with starsnap.actions-runner=true; found $labeled_runner_node_count." >&2
  exit 1
fi

labeled_runner_node_id="$(awk 'NF { print $1; exit }' <<<"$labeled_runner_node_ids")"
if [[ "$labeled_runner_node_id" != "$current_node_id" ]]; then
  echo "The sole starsnap.actions-runner node must be the current manager ($current_node_id); found $labeled_runner_node_id." >&2
  exit 1
fi

if ! api_network_details="$(docker network inspect \
  --format '{{.Driver}} {{.Scope}} {{.ID}}' \
  "$api_network_name")"; then
  echo "Required API overlay network is missing: $api_network_name" >&2
  exit 1
fi

read -r api_network_driver api_network_scope api_network_id <<<"$api_network_details"
if [[ "$api_network_driver" != "overlay" || "$api_network_scope" != "swarm" || -z "$api_network_id" ]]; then
  echo "API network must be a Swarm-scoped overlay: $api_network_name" >&2
  exit 1
fi

if ! api_service_network_ids="$(docker service inspect \
  --format '{{range .Spec.TaskTemplate.Networks}}{{println .Target}}{{end}}' \
  "$api_service_name")"; then
  echo "Required API service is missing: $api_service_name" >&2
  exit 1
fi

if ! grep -Fxq "$api_network_id" <<<"$api_service_network_ids"; then
  echo "$api_service_name is not attached to $api_network_name." >&2
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

if ! grep -Fq "name: $api_network_name" "$rendered_stack" \
  || ! grep -Fq "starsnap_main_app_net: null" "$rendered_stack"; then
  echo "Rendered Caddy service must attach to the external API overlay." >&2
  exit 1
fi

if [[ "$(grep -Fc "node.role == manager" "$rendered_stack")" -lt 2 ]]; then
  echo "Rendered stack must keep both services on the Swarm manager." >&2
  exit 1
fi

if [[ "$(grep -Fc "node.labels.starsnap.actions-runner == true" "$rendered_stack")" -lt 2 ]]; then
  echo "Rendered stack must pin both services to the labeled runner manager." >&2
  exit 1
fi

deployment_started=true
docker stack deploy \
  --compose-file "$rendered_stack" \
  --resolve-image never \
  --with-registry-auth \
  "$STACK_NAME"

wait_for_website "$STARSNAP_WEBSITE_IMAGE" "$rollout_timeout_seconds" deploy
wait_for_caddy "$caddy_image" "$CADDY_CONFIG_NAME" "$rollout_timeout_seconds" deploy

echo "Deployment verified: $STARSNAP_WEBSITE_IMAGE"
echo "Caddy verified: $caddy_image ($CADDY_CONFIG_NAME)"
