#!/usr/bin/env bash

set -Eeuo pipefail
set +x

readonly manager_address='192.168.1.103'
readonly manager_label='starsnap.actions-runner'
readonly app_network='starsnap-main_app-net'
readonly database_network='starsnap-hub_database'
readonly server_service="${LOG_SERVER_SERVICE_NAME:-starsnap-log-server}"
readonly web_service="${LOG_WEB_SERVICE_NAME:-starsnap-log-web}"
readonly server_legacy_alias="${LOG_SERVER_LEGACY_ALIAS-starsnap-hub_server}"
readonly web_legacy_alias="${LOG_WEB_LEGACY_ALIAS-starsnap-hub_web}"
readonly publish_server_port="${LOG_SERVER_PUBLISH_PORT:-true}"
readonly require_image_match="${LOG_REQUIRE_IMAGE_MATCH:-false}"
readonly server_replicas="${HUB_SERVER_REPLICAS:-1}"
readonly web_replicas="${HUB_WEB_REPLICAS:-1}"
# shellcheck disable=SC2016 # Secret substitutions must execute inside the service container.
readonly server_command='export SPRING_DATASOURCE_PASSWORD="$(< /run/secrets/hub-db-password)"; export HUB_SERVER_LOG_SECRET="$(< /run/secrets/hub-ingest-secret)"; export CLOUDFLARE_ACCESS_TEAM_DOMAIN="$(< /run/secrets/cloudflare-access-team-domain)"; export CLOUDFLARE_ACCESS_AUDIENCE="$(< /run/secrets/cloudflare-access-audience)"; exec java -jar /app/starsnap-log.jar'
node_binary=''

validate_name() {
  [[ "$1" =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,254}$ ]]
}

require_manager() {
  local node_id
  test "$(docker info --format '{{.Swarm.ControlAvailable}}')" = 'true'
  test "$(docker node inspect self --format '{{.Status.Addr}}')" = "$manager_address"
  node_id="$(docker info --format '{{.Swarm.NodeID}}')"
  test -n "$node_id"
  test "$(docker node inspect --format '{{.Spec.Role}}' "$node_id")" = 'manager'
  test "$(docker node inspect \
    --format "{{with index .Spec.Labels \"$manager_label\"}}{{.}}{{end}}" \
    "$node_id")" = 'true'
}

service_exists() {
  docker service inspect "$1" >/dev/null 2>&1
}

resolve_node_binary() {
  local runner_root candidate
  if command -v node >/dev/null 2>&1; then
    node_binary='node'
    return 0
  fi
  if [[ -n "${RUNNER_TEMP:-}" ]]; then
    runner_root="$(cd "$(dirname "$(dirname "$RUNNER_TEMP")")" && pwd -P)"
    for candidate in "$runner_root"/externals/node*/bin/node; do
      if [[ -x "$candidate" ]]; then
        node_binary="$candidate"
        return 0
      fi
    done
  fi
  echo 'Node.js is required to verify existing Log service specifications.' >&2
  return 1
}

network_attachment() {
  local network="$1" alias="$2"
  if [[ -n "$alias" ]]; then
    printf 'name=%s,alias=%s\n' "$network" "$alias"
  else
    printf '%s\n' "$network"
  fi
}

verify_existing_service() {
  local service="$1" kind="$2" legacy_alias="$3"
  local app_network_id database_network_id
  app_network_id="$(docker network inspect --format '{{.ID}}' "$app_network")"
  database_network_id="$(docker network inspect --format '{{.ID}}' "$database_network")"
  EXPECTED_SERVICE="$service" \
  EXPECTED_KIND="$kind" \
  EXPECTED_LEGACY_ALIAS="$legacy_alias" \
  EXPECTED_APP_NETWORK_ID="$app_network_id" \
  EXPECTED_DATABASE_NETWORK_ID="$database_network_id" \
  EXPECTED_PUBLISH_PORT="$publish_server_port" \
  EXPECTED_IMAGE_MATCH="$require_image_match" \
  EXPECTED_IMAGE="$([[ "$kind" == server ]] && printf '%s' "$HUB_SERVER_IMAGE" || printf '%s' "$HUB_WEB_IMAGE")" \
  EXPECTED_SERVER_COMMAND="$server_command" \
    "$node_binary" deploy/platform/verify-log-service-spec.mjs < <(docker service inspect "$service")
}

scale_if_needed() {
  local service="$1" replicas="$2" current_replicas
  current_replicas="$(docker service inspect \
    --format '{{.Spec.Mode.Replicated.Replicas}}' "$service" 2>/dev/null || true)"
  if [[ "$current_replicas" != "$replicas" ]]; then
    docker service scale "$service=$replicas" >/dev/null
  fi
}

ensure_server() {
  local app_attachment
  local -a publish_args=()
  if service_exists "$server_service"; then
    verify_existing_service "$server_service" server "$server_legacy_alias" || return 1
    scale_if_needed "$server_service" "$server_replicas"
    return 0
  fi

  app_attachment="$(network_attachment "$app_network" "$server_legacy_alias")"
  if [[ "$publish_server_port" == true ]]; then
    publish_args+=(--publish 'published=8081,target=8081,protocol=tcp,mode=host')
  else
    test "$publish_server_port" = false
  fi

  docker service create --detach --no-resolve-image --with-registry-auth \
    --name "$server_service" \
    --replicas "$server_replicas" \
    --constraint 'node.role == manager' \
    --constraint 'node.labels.starsnap.actions-runner == true' \
    --network "$app_attachment" \
    --network "$database_network" \
    "${publish_args[@]}" \
    --env 'SPRING_DATASOURCE_URL=jdbc:postgresql://postgres:5432/starsnap_hub' \
    --env 'SPRING_DATASOURCE_USERNAME=starsnap' \
    --secret "source=$HUB_DB_PASSWORD_SECRET_NAME,target=hub-db-password,uid=1000,gid=1000,mode=0400" \
    --secret "source=$HUB_INGEST_SECRET_NAME,target=hub-ingest-secret,uid=1000,gid=1000,mode=0400" \
    --secret "source=$CLOUDFLARE_ACCESS_TEAM_DOMAIN_SECRET_NAME,target=cloudflare-access-team-domain,uid=1000,gid=1000,mode=0400" \
    --secret "source=$CLOUDFLARE_ACCESS_AUDIENCE_SECRET_NAME,target=cloudflare-access-audience,uid=1000,gid=1000,mode=0400" \
    --entrypoint /bin/bash \
    --health-cmd "bash -ec 'exec 3<>/dev/tcp/127.0.0.1/8081'" \
    --health-interval 10s \
    --health-timeout 5s \
    --health-start-period 180s \
    --health-retries 8 \
    --stop-grace-period 30s \
    --update-parallelism 1 \
    --update-order stop-first \
    --update-failure-action rollback \
    --update-monitor 240s \
    --rollback-parallelism 1 \
    --rollback-order stop-first \
    --rollback-monitor 240s \
    --restart-condition on-failure \
    --restart-delay 5s \
    --restart-max-attempts 8 \
    --restart-window 180s \
    --reserve-cpu 0.10 \
    --reserve-memory 256M \
    --limit-cpu 1.00 \
    --limit-memory 1G \
    "$HUB_SERVER_IMAGE" -ec "$server_command" >/dev/null
}

ensure_web() {
  local app_attachment
  if service_exists "$web_service"; then
    verify_existing_service "$web_service" web "$web_legacy_alias" || return 1
    scale_if_needed "$web_service" "$web_replicas"
    return 0
  fi

  app_attachment="$(network_attachment "$app_network" "$web_legacy_alias")"
  docker service create --detach --no-resolve-image --with-registry-auth \
    --name "$web_service" \
    --replicas "$web_replicas" \
    --constraint 'node.role == manager' \
    --constraint 'node.labels.starsnap.actions-runner == true' \
    --network "$app_attachment" \
    --health-cmd "node -e \"fetch('http://127.0.0.1:5173/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\"" \
    --health-interval 10s \
    --health-timeout 5s \
    --health-start-period 15s \
    --health-retries 5 \
    --stop-grace-period 20s \
    --update-parallelism 1 \
    --update-order start-first \
    --update-failure-action rollback \
    --update-monitor 60s \
    --rollback-parallelism 1 \
    --rollback-order stop-first \
    --rollback-monitor 60s \
    --restart-condition on-failure \
    --restart-delay 5s \
    --restart-max-attempts 5 \
    --restart-window 120s \
    --reserve-cpu 0.05 \
    --reserve-memory 32M \
    --limit-cpu 0.50 \
    --limit-memory 256M \
    "$HUB_WEB_IMAGE" >/dev/null
}

validate_name "$server_service"
validate_name "$web_service"
if [[ -n "$server_legacy_alias" ]]; then validate_name "$server_legacy_alias"; fi
if [[ -n "$web_legacy_alias" ]]; then validate_name "$web_legacy_alias"; fi
[[ "$server_replicas" =~ ^[0-9]+$ ]]
[[ "$web_replicas" =~ ^[0-9]+$ ]]
[[ "$require_image_match" =~ ^(true|false)$ ]]
test -n "${HUB_SERVER_IMAGE:-}"
test -n "${HUB_WEB_IMAGE:-}"
for variable in HUB_DB_PASSWORD_SECRET_NAME HUB_INGEST_SECRET_NAME \
  CLOUDFLARE_ACCESS_TEAM_DOMAIN_SECRET_NAME CLOUDFLARE_ACCESS_AUDIENCE_SECRET_NAME; do
  validate_name "${!variable:-}"
done
require_manager
resolve_node_binary
docker network inspect "$app_network" "$database_network" >/dev/null
for secret in "$HUB_DB_PASSWORD_SECRET_NAME" "$HUB_INGEST_SECRET_NAME" \
  "$CLOUDFLARE_ACCESS_TEAM_DOMAIN_SECRET_NAME" "$CLOUDFLARE_ACCESS_AUDIENCE_SECRET_NAME"; do
  docker secret inspect "$secret" >/dev/null
done

ensure_server || exit 1
ensure_web || exit 1
printf 'Log services ensured: server=%s(%s) web=%s(%s) host_port=%s\n' \
  "$server_service" "$server_replicas" "$web_service" "$web_replicas" "$publish_server_port"
