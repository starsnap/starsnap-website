#!/usr/bin/env bash

set -Eeuo pipefail
set +x

readonly source_server='starsnap-hub_server'
readonly source_web='starsnap-hub_web'
readonly target_server='starsnap-log-server'
readonly target_web='starsnap-log-web'
readonly manager_address='192.168.1.103'
readonly caddy_service='starsnap-company_caddy'
readonly caddy_image='docker.io/library/caddy:2.10.2-alpine@sha256:4c6e91c6ed0e2fa03efd5b44747b625fec79bc9cd06ac5235a779726618e530d'
readonly caddy_config_file='deploy/Caddyfile'

server_image=''
web_image=''
previous_caddy_config=''
previous_caddy_hash=''
new_caddy_config=''
new_caddy_digest=''
new_caddy_config_created=0
target_server_preexisting=0
target_web_preexisting=0
target_creation_attempted=0
caddy_update_attempted=0
source_server_removal_attempted=0
source_web_removal_attempted=0
migration_complete=0

service_exists() {
  docker service inspect "$1" >/dev/null 2>&1
}

single_running_container() {
  local service="$1" container_ids
  container_ids="$(docker ps \
    --filter "label=com.docker.swarm.service.name=$service" \
    --filter status=running \
    --format '{{.ID}}')"
  if [[ "$(awk 'NF {count++} END {print count + 0}' <<<"$container_ids")" -ne 1 ]]; then
    return 1
  fi
  awk 'NF {print; exit}' <<<"$container_ids"
}

service_replicas() {
  docker service ls --filter "name=$1" --format '{{.Name}} {{.Replicas}}' \
    | awk -v target="$1" '$1 == target {print $2}'
}

service_update_state() {
  docker service inspect \
    --format '{{if .UpdateStatus}}{{.UpdateStatus.State}}{{else}}completed{{end}}' "$1"
}

service_task_hash() {
  docker service inspect --format '{{json .Spec.TaskTemplate}}' "$1" \
    | sha256sum | awk '{print $1}'
}

caddy_config_name() {
  docker service inspect \
    --format '{{range .Spec.TaskTemplate.ContainerSpec.Configs}}{{if eq .File.Name "/etc/caddy/Caddyfile"}}{{.ConfigName}}{{end}}{{end}}' \
    "$caddy_service"
}

service_core_health_ok() {
  local service="$1" role="$2" container health
  test "$(service_replicas "$service")" = '1/1' || return 1
  [[ "$(service_update_state "$service")" =~ ^(completed|rollback_completed)$ ]] || return 1
  container="$(single_running_container "$service")" || return 1
  health="$(docker inspect \
    --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' \
    "$container")" || return 1
  test "$health" = healthy || return 1
  if [[ "$role" == server ]]; then
    docker exec "$container" bash -ec 'exec 3<>/dev/tcp/127.0.0.1/8081' >/dev/null 2>&1
  else
    test "$role" = web
    docker exec "$container" node -e '
      fetch("http://127.0.0.1:5173/")
        .then((response) => process.exit(response.ok ? 0 : 1))
        .catch(() => process.exit(1));
    ' >/dev/null 2>&1
  fi
}

wait_for_service() {
  local service="$1" role="$2" expected_state="${3:-completed}" deadline=$((SECONDS + 360))
  local replicas update_state observed last_observed=''
  while (( SECONDS < deadline )); do
    replicas="$(service_replicas "$service" 2>/dev/null || true)"
    update_state="$(service_update_state "$service" 2>/dev/null || true)"
    observed="$replicas|$update_state"
    if [[ "$observed" != "$last_observed" ]]; then
      echo "Waiting for $service: replicas=${replicas:-missing} state=${update_state:-missing}" >&2
      last_observed="$observed"
    fi
    case "$update_state" in
      paused|rollback_paused)
        docker service ps --no-trunc "$service" >&2 || true
        docker service logs --raw --tail 100 "$service" >&2 || true
        return 1
        ;;
    esac
    if [[ "$replicas" == '1/1' && "$update_state" == "$expected_state" ]] \
      && service_core_health_ok "$service" "$role"; then
      return 0
    fi
    sleep 3
  done
  echo "Timed out waiting for $service." >&2
  docker service ps --no-trunc "$service" >&2 || true
  return 1
}

caddy_core_health_ok() {
  local expected_config="$1" container health
  test "$(service_replicas "$caddy_service")" = '1/1' || return 1
  [[ "$(service_update_state "$caddy_service")" =~ ^(completed|rollback_completed)$ ]] || return 1
  test "$(caddy_config_name)" = "$expected_config" || return 1
  container="$(single_running_container "$caddy_service")" || return 1
  health="$(docker inspect \
    --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' \
    "$container")" || return 1
  test "$health" = healthy
}

wait_for_caddy() {
  local expected_config="$1" expected_state="${2:-completed}" deadline=$((SECONDS + 300))
  while (( SECONDS < deadline )); do
    if [[ "$(service_replicas "$caddy_service" 2>/dev/null || true)" == '1/1' \
      && "$(service_update_state "$caddy_service" 2>/dev/null || true)" == "$expected_state" ]] \
      && caddy_core_health_ok "$expected_config"; then
      return 0
    fi
    sleep 3
  done
  docker service ps --no-trunc "$caddy_service" >&2 || true
  docker service logs --raw --tail 100 "$caddy_service" >&2 || true
  return 1
}

wait_for_absent() {
  local service="$1" deadline=$((SECONDS + 120))
  while (( SECONDS < deadline )); do
    if ! service_exists "$service"; then return 0; fi
    sleep 2
  done
  return 1
}

compute_new_caddy_config_identity() {
  new_caddy_digest="$(sha256sum "$caddy_config_file" | awk '{print $1}')"
  new_caddy_config="starsnap-company_caddyfile_${new_caddy_digest:0:16}"
}

ensure_caddy_config() {
  local config_names existing_digest
  test -n "$new_caddy_digest"
  test -n "$new_caddy_config"
  config_names="$(docker config ls --format '{{.Name}}')"
  if grep -Fxq "$new_caddy_config" <<<"$config_names"; then
    existing_digest="$(docker config inspect \
      --format '{{index .Spec.Labels "com.starsnap.config-sha256"}}' \
      "$new_caddy_config")"
    test "$existing_digest" = "$new_caddy_digest"
    return 0
  fi
  docker config create \
    --label "com.starsnap.config-sha256=$new_caddy_digest" \
    --label 'com.starsnap.stack=starsnap-company' \
    "$new_caddy_config" "$caddy_config_file" >/dev/null
  new_caddy_config_created=1
}

verify_from_caddy() {
  local container web_body health_body
  container="$(single_running_container "$caddy_service")"
  web_body="$(docker exec "$container" wget --quiet --output-document=- \
    "http://$target_web:5173/")"
  grep -Fq '<title>StarSnap Log Dashboard</title>' <<<"$web_body"
  health_body="$(docker exec "$container" wget --quiet --output-document=- \
    "http://$target_server:8081/actuator/health")"
  grep -Fq '"status":"UP"' <<<"$health_body"
}

verify_caddy_route() {
  local dashboard_body
  dashboard_body="$(curl --silent --show-error --fail --insecure --noproxy '*' \
    --connect-timeout 10 --max-time 30 \
    --resolve "log.starsnap.kr:443:$manager_address" \
    'https://log.starsnap.kr/')"
  grep -Fq '<title>StarSnap Log Dashboard</title>' <<<"$dashboard_body"
}

verify_manager_health() {
  local health_body
  health_body="$(curl --silent --show-error --fail --noproxy '*' \
    --connect-timeout 10 --max-time 30 \
    "http://$manager_address:8081/actuator/health")"
  grep -Fq '"status":"UP"' <<<"$health_body"
}

ensure_target_services() {
  LOG_SERVER_SERVICE_NAME="$target_server" \
  LOG_WEB_SERVICE_NAME="$target_web" \
  LOG_SERVER_LEGACY_ALIAS="$source_server" \
  LOG_WEB_LEGACY_ALIAS="$source_web" \
  LOG_SERVER_PUBLISH_PORT=false \
  LOG_REQUIRE_IMAGE_MATCH=true \
  HUB_SERVER_IMAGE="$server_image" HUB_WEB_IMAGE="$web_image" \
  HUB_SERVER_REPLICAS=1 HUB_WEB_REPLICAS=1 \
    bash deploy/platform/ensure-log-services.sh
}

restore_source_services() {
  if ! LOG_SERVER_SERVICE_NAME="$source_server" \
    LOG_WEB_SERVICE_NAME="$source_web" \
    LOG_SERVER_LEGACY_ALIAS='' LOG_WEB_LEGACY_ALIAS='' \
    LOG_SERVER_PUBLISH_PORT=true \
    LOG_REQUIRE_IMAGE_MATCH=true \
    HUB_SERVER_IMAGE="$server_image" HUB_WEB_IMAGE="$web_image" \
    HUB_SERVER_REPLICAS=1 HUB_WEB_REPLICAS=1 \
      bash deploy/platform/ensure-log-services.sh; then
    return 1
  fi
  wait_for_service "$source_server" server completed
  wait_for_service "$source_web" web completed
}

remove_target_host_port() {
  echo 'Rollback: checking the new server host port.' >&2
  if ! service_exists "$target_server"; then return 0; fi
  if docker service inspect --format '{{range .Endpoint.Ports}}{{println .PublishedPort}}{{end}}' \
    "$target_server" | grep -Fxq '8081'; then
    echo 'Rollback: removing port 8081 from the new server.' >&2
    docker service update --detach=true --publish-rm 8081 "$target_server" >/dev/null
    echo 'Rollback: waiting for the new server after port removal.' >&2
    wait_for_service "$target_server" server completed
  fi
  echo 'Rollback: new server host-port check complete.' >&2
}

rollback_on_error() {
  local status="${1:-1}" current_hash='' rollback_ok=1
  local sources_healthy=1 caddy_restored=1 safe_to_remove_targets=1
  trap - ERR HUP INT TERM
  if (( migration_complete == 1 )); then exit "$status"; fi

  if (( source_server_removal_attempted == 1 || source_web_removal_attempted == 1 )); then
    echo 'Rollback: removing the new server host port and restoring legacy services.' >&2
    if ! remove_target_host_port || ! restore_source_services; then
      sources_healthy=0
      rollback_ok=0
    fi
  fi

  if (( caddy_update_attempted == 1 )); then
    echo 'Rollback: restoring the previous Caddy route.' >&2
    caddy_restored=0
    if (( sources_healthy == 1 )); then
      current_hash="$(service_task_hash "$caddy_service" 2>/dev/null || true)"
      if [[ "$current_hash" == "$previous_caddy_hash" ]] \
        && caddy_core_health_ok "$previous_caddy_config"; then
        caddy_restored=1
      elif docker service rollback --detach=true "$caddy_service" >/dev/null \
        && wait_for_caddy "$previous_caddy_config" rollback_completed; then
        caddy_restored=1
      else
        rollback_ok=0
      fi
    else
      rollback_ok=0
    fi
  elif [[ -n "$previous_caddy_config" && "$previous_caddy_config" == "$new_caddy_config" ]]; then
    caddy_restored=0
    rollback_ok=0
  fi

  if (( sources_healthy == 0 || caddy_restored == 0 )); then
    safe_to_remove_targets=0
  fi
  if (( target_creation_attempted == 1 && safe_to_remove_targets == 1 )); then
    if ! service_core_health_ok "$source_server" server \
      || ! service_core_health_ok "$source_web" web \
      || ! caddy_core_health_ok "$previous_caddy_config"; then
      echo 'Keeping new Log services online because rollback dependencies changed health.' >&2
      safe_to_remove_targets=0
      rollback_ok=0
    fi
  fi
  if (( target_creation_attempted == 1 && safe_to_remove_targets == 1 )); then
    echo 'Rollback: removing newly created Log services.' >&2
    if (( target_web_preexisting == 0 )); then
      service_exists "$target_web" && docker service rm "$target_web" >/dev/null || true
      wait_for_absent "$target_web" || rollback_ok=0
    fi
    if (( target_server_preexisting == 0 )); then
      service_exists "$target_server" && docker service rm "$target_server" >/dev/null || true
      wait_for_absent "$target_server" || rollback_ok=0
    fi
  elif (( target_creation_attempted == 1 )); then
    echo 'Keeping new Log services online because rollback dependencies are not healthy.' >&2
    rollback_ok=0
  fi

  if (( new_caddy_config_created == 1 )) \
    && docker config inspect "$new_caddy_config" >/dev/null 2>&1; then
    docker config rm "$new_caddy_config" >/dev/null 2>&1 || true
  fi
  if (( rollback_ok == 1 )); then
    echo 'Log service rename rollback verified.' >&2
  else
    echo 'CRITICAL: Log service rename rollback could not be fully verified.' >&2
  fi
  exit "$status"
}
trap 'rollback_on_error $?' ERR
trap 'rollback_on_error 129' HUP
trap 'rollback_on_error 130' INT
trap 'rollback_on_error 143' TERM

test "${ALLOW_LOG_SERVICE_RENAME:-}" = 'RENAME-LOG-SERVICES-192.168.1.103'
command -v curl >/dev/null
bash deploy/platform/validate-platform.sh
service_exists "$source_server"
service_exists "$source_web"
service_core_health_ok "$source_server" server
service_core_health_ok "$source_web" web
service_exists "$caddy_service"
previous_caddy_config="$(caddy_config_name)"
previous_caddy_hash="$(service_task_hash "$caddy_service")"
readonly previous_caddy_config previous_caddy_hash
caddy_core_health_ok "$previous_caddy_config"
compute_new_caddy_config_identity
server_image="$(docker service inspect \
  --format '{{.Spec.TaskTemplate.ContainerSpec.Image}}' "$source_server")"
web_image="$(docker service inspect \
  --format '{{.Spec.TaskTemplate.ContainerSpec.Image}}' "$source_web")"
readonly server_image web_image

if service_exists "$target_server"; then
  target_server_preexisting=1
  test "$(docker service inspect --format '{{.Spec.TaskTemplate.ContainerSpec.Image}}' "$target_server")" = "$server_image"
fi
if service_exists "$target_web"; then
  target_web_preexisting=1
  test "$(docker service inspect --format '{{.Spec.TaskTemplate.ContainerSpec.Image}}' "$target_web")" = "$web_image"
fi
if (( target_server_preexisting == 0 || target_web_preexisting == 0 )); then
  target_creation_attempted=1
fi
ensure_target_services
wait_for_service "$target_server" server completed
wait_for_service "$target_web" web completed
test "$(docker inspect --format '{{.Image}}' "$(single_running_container "$target_server")")" \
  = "$(docker inspect --format '{{.Image}}' "$(single_running_container "$source_server")")"
test "$(docker inspect --format '{{.Image}}' "$(single_running_container "$target_web")")" \
  = "$(docker inspect --format '{{.Image}}' "$(single_running_container "$source_web")")"
verify_from_caddy

docker pull "$caddy_image" >/dev/null
docker run --rm --interactive --entrypoint caddy "$caddy_image" \
  validate --config - --adapter caddyfile <"$caddy_config_file"
ensure_caddy_config
if [[ "$previous_caddy_config" != "$new_caddy_config" ]]; then
  caddy_update_attempted=1
  docker service update --detach=true \
    --config-rm "$previous_caddy_config" \
    --config-add "source=$new_caddy_config,target=/etc/caddy/Caddyfile,mode=0444" \
    --force "$caddy_service" >/dev/null
  wait_for_caddy "$new_caddy_config" completed
fi
verify_caddy_route

source_web_removal_attempted=1
docker service rm "$source_web" >/dev/null
wait_for_absent "$source_web"
source_server_removal_attempted=1
docker service rm "$source_server" >/dev/null
wait_for_absent "$source_server"

docker service update --detach=true \
  --publish-add 'published=8081,target=8081,protocol=tcp,mode=host' \
  "$target_server" >/dev/null
wait_for_service "$target_server" server completed
wait_for_service "$target_web" web completed
verify_from_caddy
verify_caddy_route
verify_manager_health

migration_complete=1
trap - ERR HUP INT TERM
printf 'Log service rename verified: %s -> %s, %s -> %s\n' \
  "$source_server" "$target_server" "$source_web" "$target_web"
