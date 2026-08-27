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

usage() {
  echo "Usage: $0 preflight|stage|activate|verify|stop-target" >&2
}

if [[ ! "$phase" =~ ^(preflight|stage|activate|verify|stop-target)$ ]]; then
  usage
  exit 2
fi

require_manager() {
  local current_node_id labeled_nodes
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
  local variable image architecture
  for variable in "${image_variables[@]}"; do
    image="${!variable}"
    echo "Verifying $variable image on the Swarm manager."
    docker pull "$image" >/dev/null
    architecture="$(docker image inspect --format '{{.Architecture}}' "$image")"
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
    deploy_stacks
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
    verify_direct_services
    echo "Target services are healthy; Caddy has not been switched by this script."
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
