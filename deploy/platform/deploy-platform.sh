#!/usr/bin/env bash

set -Eeuo pipefail

readonly phase="${1:-}"
readonly app_network="starsnap-main_app-net"
readonly manager_label="starsnap.actions-runner"
readonly required_services=(
  starsnap-main_api
  starsnap-main_starsnap-postgres
)
readonly secret_name_variables=(
  MAIN_DB_PASSWORD_SECRET_NAME
  ERP_DB_PASSWORD_SECRET_NAME
  ADMIN_JWT_SECRET_NAME
  AWS_ACCESS_KEY_ID_SECRET_NAME
  AWS_SECRET_ACCESS_KEY_SECRET_NAME
  HUB_INGEST_SECRET_NAME
  HUB_DB_PASSWORD_SECRET_NAME
  CLOUDFLARE_ACCESS_TEAM_DOMAIN_SECRET_NAME
  CLOUDFLARE_ACCESS_AUDIENCE_SECRET_NAME
  ERP_AUTH_CODE_SECRET_NAME
  ERP_SMTP_MAILER_TOKEN_SECRET_NAME
  ERP_SMTP_USERNAME_SECRET_NAME
  ERP_SMTP_PASSWORD_SECRET_NAME
  ERP_EMBEDDING_WORKER_TOKEN_SECRET_NAME
)
readonly image_variables=(
  SNS_WEB_IMAGE
  ADMIN_WEB_IMAGE
  ADMIN_SERVER_IMAGE
  HUB_WEB_IMAGE
  HUB_SERVER_IMAGE
  ERP_WEB_IMAGE
  ERP_SMTP_MAILER_IMAGE
  ERP_EMBEDDING_WORKER_IMAGE
)
readonly private_image_services=(
  'starsnap-erp_smtp-mailer|ERP_SMTP_MAILER_IMAGE'
  'starsnap-erp_web|ERP_WEB_IMAGE'
  'starsnap-erp_embedding-worker|ERP_EMBEDDING_WORKER_IMAGE'
  'starsnap-hub_server|HUB_SERVER_IMAGE'
  'starsnap-hub_web|HUB_WEB_IMAGE'
  'starsnap-admin_server|ADMIN_SERVER_IMAGE'
  'starsnap-admin_web|ADMIN_WEB_IMAGE'
  'starsnap-sns_web|SNS_WEB_IMAGE'
)
# This registry hostname is intentionally non-resolvable so a missing local tag fails closed.
readonly manager_local_image_registry='starsnap.invalid'

usage() {
  echo "Usage: $0 preflight|stage|activate|diagnose|verify|stop-target" >&2
}

if [[ ! "$phase" =~ ^(preflight|stage|activate|diagnose|verify|stop-target)$ ]]; then
  usage
  exit 2
fi

require_manager() {
  local current_node_id labeled_nodes server_api_version service_update_help
  service_update_help="$(docker service update --help)"
  grep -Fq -- '--no-resolve-image' <<<"$service_update_help"
  server_api_version="$(docker version --format '{{.Server.APIVersion}}')"
  awk -F. '($1 > 1) || ($1 == 1 && $2 >= 30) { ok = 1 } END { exit ok ? 0 : 1 }' \
    <<<"$server_api_version"
  test "$(docker info --format '{{.Swarm.ControlAvailable}}')" = "true"
  current_node_id="$(docker info --format '{{.Swarm.NodeID}}')"
  test -n "$current_node_id"
  test "$(docker node inspect --format '{{.Spec.Role}}' "$current_node_id")" = "manager"
  test "$(docker node inspect --format "{{with index .Spec.Labels \"$manager_label\"}}{{.}}{{end}}" "$current_node_id")" = "true"
  labeled_nodes="$(docker node ls --filter "node.label=$manager_label=true" --format '{{.ID}}')"
  test "$(awk 'NF {count++} END {print count + 0}' <<<"$labeled_nodes")" -eq 1
  test "$labeled_nodes" = "$current_node_id"
}

require_dependencies() {
  local network_driver network_scope service network_ids
  network_driver="$(docker network inspect --format '{{.Driver}}' "$app_network")"
  network_scope="$(docker network inspect --format '{{.Scope}}' "$app_network")"
  test "$network_driver" = "overlay"
  test "$network_scope" = "swarm"

  for service in "${required_services[@]}"; do
    docker service inspect "$service" >/dev/null
    network_ids="$(docker service inspect --format '{{range .Spec.TaskTemplate.Networks}}{{println .Target}}{{end}}' "$service")"
    grep -Fxq "$(docker network inspect --format '{{.ID}}' "$app_network")" <<<"$network_ids"
  done

  for variable in "${secret_name_variables[@]}"; do
    docker secret inspect "${!variable}" >/dev/null
  done
}

verify_images_on_manager() {
  local variable image architecture operating_system
  for variable in "${image_variables[@]}"; do
    image="${!variable}"
    echo "Verifying $variable image on the Swarm manager."
    docker pull "$image" >/dev/null
    architecture="$(docker image inspect --format '{{.Architecture}}' "$image")"
    operating_system="$(docker image inspect --format '{{.Os}}' "$image")"
    if [[ "$operating_system" != "linux" ]]; then
      echo "$variable resolved to unsupported operating system: $operating_system" >&2
      return 1
    fi
    case "$architecture" in
      arm64|aarch64) ;;
      *) echo "$variable resolved to unsupported architecture: $architecture" >&2; return 1 ;;
    esac
  done
}

create_persistent_resources() {
  local config_name config_digest existing_digest
  docker volume create --label starsnap.migration=server-20260827 "${HUB_POSTGRES_VOLUME_NAME:-starsnap-hub-postgres-data-v1}" >/dev/null
  docker volume create --label starsnap.migration=server-20260827 "${ERP_POSTGRES_VOLUME_NAME:-starsnap-erp-postgres-data-v1}" >/dev/null
  docker volume create --label starsnap.migration=server-20260827 "${ERP_OLLAMA_VOLUME_NAME:-starsnap-erp-ollama-models-v1}" >/dev/null

  config_name="${ERP_POSTGRES_INIT_CONFIG_NAME:-starsnap-erp-postgres-init-v1}"
  config_digest="$(sha256sum deploy/platform/erp-postgres-init.sql | awk '{print $1}')"
  if docker config inspect "$config_name" >/dev/null 2>&1; then
    existing_digest="$(docker config inspect --format '{{index .Spec.Labels "com.starsnap.sha256"}}' "$config_name")"
    test "$existing_digest" = "$config_digest"
  else
    docker config create \
      --label "com.starsnap.sha256=$config_digest" \
      "$config_name" \
      deploy/platform/erp-postgres-init.sql >/dev/null
  fi
}

deploy_stacks() {
  docker stack deploy --with-registry-auth --prune --resolve-image always \
    --compose-file deploy/platform/starsnap-erp.yml starsnap-erp
  docker stack deploy --with-registry-auth --prune --resolve-image always \
    --compose-file deploy/platform/starsnap-hub.yml starsnap-hub
  docker stack deploy --with-registry-auth --prune --resolve-image always \
    --compose-file deploy/platform/starsnap-admin.yml starsnap-admin
  docker stack deploy --with-registry-auth --prune --resolve-image always \
    --compose-file deploy/platform/starsnap-sns.yml starsnap-sns
}

manager_local_image_reference() {
  local service="$1" image="$2" digest local_service
  digest="${image##*@sha256:}"
  if [[ ! "$digest" =~ ^[0-9a-f]{64}$ ]]; then
    echo "$image did not contain the verified sha256 digest." >&2
    return 1
  fi
  local_service="${service//_/-}"
  printf '%s/starsnap-platform-local/%s:sha-%s\n' \
    "$manager_local_image_registry" "$local_service" "$digest"
}

refresh_private_image_tasks() {
  local entry service variable image local_image source_id local_id

  for entry in "${private_image_services[@]}"; do
    IFS='|' read -r service variable <<<"$entry"
    image="${!variable}"
    local_image="$(manager_local_image_reference "$service" "$image")"
    echo "Tagging the verified $variable image locally for $service."
    docker tag "$image" "$local_image"
    source_id="$(docker image inspect --format '{{.Id}}' "$image")"
    local_id="$(docker image inspect --format '{{.Id}}' "$local_image")"
    test -n "$source_id"
    test "$local_id" = "$source_id"

    echo "Refreshing $service from the verified manager-local image."
    if ! docker service update --detach=true --no-resolve-image --image "$local_image" --force "$service" >/dev/null; then
      echo "Failed to refresh $service; reporting task state and recent logs." >&2
      docker service ps --no-trunc "$service" >&2 || true
      docker service logs --raw --tail 100 "$service" >&2 || true
      return 1
    fi
  done
}

verify_private_service_placements() {
  local entry service constraints
  for entry in "${private_image_services[@]}"; do
    service="${entry%%|*}"
    constraints="$(docker service inspect \
      --format '{{range .Spec.TaskTemplate.Placement.Constraints}}{{println .}}{{end}}' \
      "$service")"
    grep -Fxq 'node.role == manager' <<<"$constraints"
    grep -Fxq "node.labels.$manager_label == true" <<<"$constraints"
  done
}

verify_private_service_runtime() {
  local entry service variable image local_image spec_image container_ids container_id
  local source_id container_image_id
  for entry in "${private_image_services[@]}"; do
    IFS='|' read -r service variable <<<"$entry"
    image="${!variable}"
    local_image="$(manager_local_image_reference "$service" "$image")"
    spec_image="$(docker service inspect \
      --format '{{.Spec.TaskTemplate.ContainerSpec.Image}}' "$service")"
    test "$spec_image" = "$local_image"

    container_ids="$(docker ps \
      --filter "label=com.docker.swarm.service.name=$service" \
      --filter status=running \
      --format '{{.ID}}')"
    test "$(awk 'NF { count++ } END { print count + 0 }' <<<"$container_ids")" -eq 1
    container_id="$(awk 'NF { print; exit }' <<<"$container_ids")"
    source_id="$(docker image inspect --format '{{.Id}}' "$image")"
    container_image_id="$(docker inspect --format '{{.Image}}' "$container_id")"
    test -n "$source_id"
    test "$container_image_id" = "$source_id"
  done
}

wait_for_replicas() {
  local service="$1"
  local expected="$2"
  local deadline=$((SECONDS + 600))
  local replicas update_state
  while (( SECONDS < deadline )); do
    replicas="$(docker service ls --filter "name=$service" --format '{{.Name}} {{.Replicas}}' | awk -v target="$service" '$1 == target {print $2}')"
    update_state="$(docker service inspect --format '{{if .UpdateStatus}}{{.UpdateStatus.State}}{{else}}completed{{end}}' "$service" 2>/dev/null || true)"
    case "$update_state" in
      paused|rollback_paused|rollback_started|rollback_completed)
        echo "$service entered failure state: $update_state" >&2
        docker service ps --no-trunc "$service" >&2 || true
        return 1
        ;;
    esac
    if [[ "$replicas" == "$expected/$expected" && "$update_state" == "completed" ]]; then
      return 0
    fi
    sleep 3
  done
  echo "Timed out waiting for $service=$expected/$expected" >&2
  docker service ps --no-trunc "$service" >&2 || true
  return 1
}

wait_for_completed_service() {
  local service="$1"
  local deadline=$((SECONDS + 1800))
  local task_row state error consecutive_terminal_failures=0
  while (( SECONDS < deadline )); do
    task_row="$(docker service ps --no-trunc \
      --format '{{.CurrentState}}|{{.Error}}' \
      "$service" 2>/dev/null | head -n 1)"
    IFS='|' read -r state error <<<"$task_row"
    case "$state" in
      Complete*) return 0 ;;
      Failed*|Rejected*|Shutdown*)
        consecutive_terminal_failures=$((consecutive_terminal_failures + 1))
        if (( consecutive_terminal_failures >= 10 )); then
          echo "$service failed: ${error:-$state}" >&2
          docker service ps --no-trunc "$service" >&2 || true
          docker service logs --raw --tail 100 "$service" >&2 || true
          return 1
        fi
        ;;
      *) consecutive_terminal_failures=0 ;;
    esac
    sleep 3
  done
  echo "Timed out waiting for completed service: $service" >&2
  docker service ps --no-trunc "$service" >&2 || true
  docker service logs --raw --tail 100 "$service" >&2 || true
  return 1
}

verify_direct_services() {
  local website_container
  website_container="$(docker ps \
    --filter label=com.docker.swarm.service.name=starsnap-company_website \
    --filter status=running \
    --format '{{.ID}}')"
  test "$(awk 'NF {count++} END {print count + 0}' <<<"$website_container")" -eq 1
  docker exec --interactive "$website_container" \
    node --input-type=module <deploy/platform/verify-platform.mjs
}

diagnose_hub_services() {
  local service
  for service in starsnap-hub_postgres starsnap-hub_server; do
    echo "::group::$service state"
    docker service inspect --format \
      'Image={{.Spec.TaskTemplate.ContainerSpec.Image}} Update={{if .UpdateStatus}}{{.UpdateStatus.State}}{{else}}none{{end}} Replicas={{.Spec.Mode.Replicated.Replicas}}' \
      "$service" || true
    docker service ps --no-trunc "$service" || true
    docker service logs --raw --timestamps --tail 200 "$service" || true
    echo '::endgroup::'
  done
}

require_restored_data_marker() {
  local expected_sha="${PLATFORM_DATA_SHA256:-}"
  local marker_name marker_sha
  if [[ ! "$expected_sha" =~ ^[0-9a-f]{64}$ ]]; then
    echo "PLATFORM_DATA_SHA256 must identify the restored encrypted snapshot." >&2
    return 1
  fi
  marker_name="starsnap-platform-data-${expected_sha:0:16}"
  marker_sha="$(docker config inspect --format '{{index .Spec.Labels "com.starsnap.snapshot-sha256"}}' "$marker_name")"
  test "$marker_sha" = "$expected_sha"
}

bash deploy/platform/validate-platform.sh
require_manager
require_dependencies

case "$phase" in
  preflight)
    echo "Platform preflight passed without changing Swarm state."
    ;;
  stage)
    verify_images_on_manager
    create_persistent_resources
    export ERP_POSTGRES_REPLICAS=1 ERP_OLLAMA_REPLICAS=0 ERP_OLLAMA_MODEL_REPLICAS=0
    export ERP_SMTP_MAILER_REPLICAS=0 ERP_WEB_REPLICAS=0 ERP_EMBEDDING_WORKER_REPLICAS=0
    export HUB_POSTGRES_REPLICAS=1 HUB_SERVER_REPLICAS=0 HUB_WEB_REPLICAS=0
    export ADMIN_SERVER_REPLICAS=0 ADMIN_WEB_REPLICAS=0 SNS_WEB_REPLICAS=0
    deploy_stacks
    wait_for_replicas starsnap-erp_postgres 1
    wait_for_replicas starsnap-hub_postgres 1
    echo "Target databases are staged; public routes still point to the desktop."
    ;;
  activate)
    test "${ALLOW_PLATFORM_ACTIVATION:-}" = "ACTIVATE-192.168.1.103"
    require_restored_data_marker
    verify_images_on_manager
    deploy_stacks
    verify_private_service_placements
    refresh_private_image_tasks
    wait_for_replicas starsnap-erp_postgres 1
    wait_for_replicas starsnap-erp_ollama 1
    wait_for_completed_service starsnap-erp_ollama-model
    wait_for_replicas starsnap-erp_smtp-mailer 1
    wait_for_replicas starsnap-erp_web 1
    wait_for_replicas starsnap-erp_embedding-worker 1
    wait_for_replicas starsnap-hub_postgres 1
    wait_for_replicas starsnap-hub_server 1
    wait_for_replicas starsnap-hub_web 1
    wait_for_replicas starsnap-admin_server 1
    wait_for_replicas starsnap-admin_web 1
    wait_for_replicas starsnap-sns_web 1
    verify_private_service_runtime
    verify_direct_services
    echo "Target services are healthy; Caddy has not been switched by this script."
    ;;
  diagnose)
    diagnose_hub_services
    ;;
  verify)
    verify_direct_services
    ;;
  stop-target)
    test "${ALLOW_PLATFORM_STOP:-}" = "STOP-TARGET-KEEP-DATA"
    docker service scale \
      starsnap-sns_web=0 \
      starsnap-admin_web=0 \
      starsnap-admin_server=0 \
      starsnap-hub_web=0 \
      starsnap-hub_server=0 \
      starsnap-erp_embedding-worker=0 \
      starsnap-erp_web=0 \
      starsnap-erp_smtp-mailer=0 \
      starsnap-erp_ollama=0 >/dev/null
    echo "Target application services stopped; target databases and volumes were preserved."
    ;;
esac
