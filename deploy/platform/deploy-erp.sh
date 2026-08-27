#!/usr/bin/env bash

set -Eeuo pipefail
set +x

readonly manager_address='192.168.1.103'
readonly manager_label='starsnap.actions-runner'
readonly web_service='starsnap-erp_web'
readonly postgres_service='starsnap-erp_postgres'
readonly manager_local_image_registry='starsnap.invalid'
readonly backup_volume="${ERP_BACKUP_VOLUME_NAME:-starsnap-erp-backups-v1}"

previous_image=''
previous_task_template_hash=''
previous_update_failure_action=''
previous_service_healthy=0
service_updated=0
local_image=''

single_running_container() {
  local service="$1" container_ids
  container_ids="$(docker ps \
    --filter "label=com.docker.swarm.service.name=$service" \
    --filter status=running \
    --format '{{.ID}}')"
  if [[ "$(awk 'NF {count++} END {print count + 0}' <<<"$container_ids")" -ne 1 ]]; then
    echo "Expected exactly one running container for $service." >&2
    return 1
  fi
  awk 'NF {print; exit}' <<<"$container_ids"
}

web_core_health_ok() {
  local replicas update_state container health
  replicas="$(docker service ls \
    --filter "name=$web_service" \
    --format '{{.Name}} {{.Replicas}}' \
    | awk -v target="$web_service" '$1 == target {print $2}')" || return 1
  test "$replicas" = '1/1' || return 1
  update_state="$(docker service inspect \
    --format '{{if .UpdateStatus}}{{.UpdateStatus.State}}{{else}}completed{{end}}' \
    "$web_service" 2>/dev/null)" || return 1
  [[ "$update_state" =~ ^(completed|rollback_completed)$ ]] || return 1
  container="$(single_running_container "$web_service" 2>/dev/null)" || return 1
  health="$(docker inspect \
    --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' \
    "$container" 2>/dev/null)" || return 1
  test "$health" = 'healthy' || return 1
  docker exec "$container" node -e '
    fetch("http://127.0.0.1:3000/api/health", { headers: { host: "erp.starsnap.kr" } })
      .then(async (response) => ({ response, body: await response.json() }))
      .then(({ response, body }) => {
        if (!response.ok || body?.ok !== true) process.exit(1);
      })
      .catch(() => process.exit(1));
  ' >/dev/null 2>&1
}

candidate_web_core_health_ok() {
  local service_image container running_image_id candidate_image_id
  test -n "$local_image" || return 1
  service_image="$(docker service inspect \
    --format '{{.Spec.TaskTemplate.ContainerSpec.Image}}' \
    "$web_service" 2>/dev/null)" || return 1
  test "$service_image" = "$local_image" || return 1
  container="$(single_running_container "$web_service" 2>/dev/null)" || return 1
  running_image_id="$(docker inspect --format '{{.Image}}' "$container" 2>/dev/null)" || return 1
  candidate_image_id="$(docker image inspect --format '{{.Id}}' "$local_image" 2>/dev/null)" || return 1
  test "$running_image_id" = "$candidate_image_id" || return 1
  web_core_health_ok
}

wait_for_web() {
  local expected_state="${1:-completed}"
  local deadline=$((SECONDS + 600)) replicas update_state
  [[ "$expected_state" =~ ^(completed|rollback_completed)$ ]]
  while (( SECONDS < deadline )); do
    replicas="$(docker service ls \
      --filter "name=$web_service" \
      --format '{{.Name}} {{.Replicas}}' \
      | awk -v target="$web_service" '$1 == target {print $2}')"
    update_state="$(docker service inspect \
      --format '{{if .UpdateStatus}}{{.UpdateStatus.State}}{{else}}completed{{end}}' \
      "$web_service" 2>/dev/null || true)"
    case "$update_state" in
      paused|rollback_paused)
        echo "$web_service entered failure state: $update_state" >&2
        docker service ps --no-trunc "$web_service" >&2 || true
        docker service logs --raw --tail 100 "$web_service" >&2 || true
        return 1
        ;;
      rollback_completed)
        if [[ "$expected_state" != 'rollback_completed' ]]; then
          echo "$web_service rolled back instead of completing the candidate deployment." >&2
          docker service ps --no-trunc "$web_service" >&2 || true
          return 1
        fi
        ;;
    esac
    if [[ "$replicas" == '1/1' && "$update_state" == "$expected_state" ]]; then
      return 0
    fi
    sleep 3
  done
  echo "Timed out waiting for $web_service." >&2
  docker service ps --no-trunc "$web_service" >&2 || true
  docker service logs --raw --tail 100 "$web_service" >&2 || true
  return 1
}

service_task_template_hash() {
  docker service inspect \
    --format '{{json .Spec.TaskTemplate}}' \
    "$web_service" \
    | sha256sum \
    | awk '{print $1}'
}

rollback_on_error() {
  local status=$? current_hash='' restored_hash='' restored_image=''
  local restored_container='' restored_running_image=''
  local rollback_ok=1
  trap - ERR
  if (( service_updated == 1 )); then
    if (( previous_service_healthy == 0 )); then
      echo "The pre-deploy ERP service was not healthy; refusing to roll back to its unavailable specification." >&2
      if candidate_web_core_health_ok; then
        echo "The candidate ERP image is running and core-healthy; it will remain online for incident recovery." >&2
      else
        echo "CRITICAL: no healthy pre-deploy ERP target exists and the candidate image is absent or not core-healthy; inspect $web_service immediately." >&2
      fi
      exit "$status"
    fi
    if ! current_hash="$(service_task_template_hash 2>/dev/null)"; then
      echo "Could not inspect $web_service while preparing rollback." >&2
      rollback_ok=0
    elif [[ "$current_hash" != "$previous_task_template_hash" ]]; then
      echo "ERP verification failed; rolling $web_service back to its previous specification." >&2
      if ! docker service rollback --detach=true "$web_service" >/dev/null; then
        echo "Rollback command failed for $web_service." >&2
        rollback_ok=0
      elif ! wait_for_web rollback_completed; then
        echo "Rollback did not converge for $web_service." >&2
        rollback_ok=0
      fi
    else
      echo "$web_service already matches its pre-deploy task specification." >&2
    fi

    if ! restored_hash="$(service_task_template_hash 2>/dev/null)"; then
      rollback_ok=0
    elif [[ "$restored_hash" != "$previous_task_template_hash" ]]; then
      echo "$web_service task specification was not restored." >&2
      rollback_ok=0
    fi
    if ! restored_image="$(docker service inspect \
      --format '{{.Spec.TaskTemplate.ContainerSpec.Image}}' \
      "$web_service" 2>/dev/null)"; then
      rollback_ok=0
    elif [[ "$restored_image" != "$previous_image" ]]; then
      echo "$web_service image was not restored to $previous_image." >&2
      rollback_ok=0
    fi
    if ! restored_container="$(single_running_container "$web_service" 2>/dev/null)"; then
      rollback_ok=0
    elif ! restored_running_image="$(docker inspect \
      --format '{{.Config.Image}}' \
      "$restored_container" 2>/dev/null)"; then
      rollback_ok=0
    elif [[ "$restored_running_image" != "$previous_image" ]]; then
      echo "$web_service running container does not use the restored image." >&2
      rollback_ok=0
    fi
    if (( rollback_ok == 1 )); then
      echo "ERP rollback verified: image=$previous_image replicas=1/1" >&2
    else
      echo "CRITICAL: ERP rollback could not be fully verified; inspect $web_service immediately." >&2
    fi
  fi
  exit "$status"
}
trap rollback_on_error ERR

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

verify_image() {
  local architecture operating_system
  docker pull "$ERP_WEB_IMAGE" >/dev/null
  architecture="$(docker image inspect --format '{{.Architecture}}' "$ERP_WEB_IMAGE")"
  operating_system="$(docker image inspect --format '{{.Os}}' "$ERP_WEB_IMAGE")"
  [[ "$architecture" =~ ^(arm64|aarch64)$ ]]
  test "$operating_system" = 'linux'
}

manager_local_image_reference() {
  local digest="${ERP_WEB_IMAGE##*@sha256:}"
  [[ "$digest" =~ ^[0-9a-f]{64}$ ]]
  printf '%s/starsnap-platform-local/starsnap-erp-web:sha-%s\n' \
    "$manager_local_image_registry" "$digest"
}

back_up_database() {
  local postgres_container postgres_image stamp backup_name partial_name
  local backup_path backup_hash backup_bytes
  postgres_container="$(single_running_container "$postgres_service")"
  postgres_image="$(docker service inspect \
    --format '{{.Spec.TaskTemplate.ContainerSpec.Image}}' \
    "$postgres_service")"
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  backup_name="pre-erp-eat-$stamp.dump"
  partial_name="$backup_name.partial"
  backup_path="/backups/$backup_name"

  docker volume create \
    --label starsnap.backup=erp-production \
    "$backup_volume" >/dev/null
  docker exec "$postgres_container" \
    pg_dump --username mealops --dbname mealops --format=custom \
      --no-owner --no-privileges \
    | docker run --rm --interactive \
      --entrypoint /bin/sh \
      --mount "type=volume,source=$backup_volume,target=/backups" \
      "$postgres_image" \
      -ceu 'umask 077; cat > "/backups/$1"' sh "$partial_name"

  docker run --rm \
    --entrypoint pg_restore \
    --mount "type=volume,source=$backup_volume,target=/backups,readonly" \
    "$postgres_image" \
    --list "/backups/$partial_name" >/dev/null
  docker run --rm \
    --entrypoint /bin/sh \
    --mount "type=volume,source=$backup_volume,target=/backups" \
    "$postgres_image" \
    -ceu 'test ! -e "$2"; mv "$1" "$2"; chmod 0600 "$2"' \
    sh "/backups/$partial_name" "$backup_path"

  backup_hash="$(docker run --rm \
    --entrypoint sha256sum \
    --mount "type=volume,source=$backup_volume,target=/backups,readonly" \
    "$postgres_image" "$backup_path" | awk '{print $1}')"
  backup_bytes="$(docker run --rm \
    --entrypoint stat \
    --mount "type=volume,source=$backup_volume,target=/backups,readonly" \
    "$postgres_image" -c '%s' "$backup_path")"
  [[ "$backup_hash" =~ ^[0-9a-f]{64}$ ]]
  [[ "$backup_bytes" =~ ^[1-9][0-9]*$ ]]
  printf 'ERP database backup: volume=%s file=%s bytes=%s sha256=%s\n' \
    "$backup_volume" "$backup_name" "$backup_bytes" "$backup_hash"
}

test "${ALLOW_ERP_DEPLOY:-}" = 'DEPLOY-ERP-192.168.1.103'
bash deploy/platform/validate-platform.sh
require_manager
docker secret inspect "$ERP_EAT_API_SECRET_NAME" >/dev/null
docker service inspect "$web_service" "$postgres_service" >/dev/null
verify_image
back_up_database

previous_image="$(docker service inspect \
  --format '{{.Spec.TaskTemplate.ContainerSpec.Image}}' \
  "$web_service")"
readonly previous_image
previous_task_template_hash="$(service_task_template_hash)"
readonly previous_task_template_hash
[[ "$previous_task_template_hash" =~ ^[0-9a-f]{64}$ ]]
previous_update_failure_action="$(docker service inspect \
  --format '{{if .Spec.UpdateConfig}}{{.Spec.UpdateConfig.FailureAction}}{{else}}pause{{end}}' \
  "$web_service")"
readonly previous_update_failure_action
[[ "$previous_update_failure_action" =~ ^(continue|pause|rollback)$ ]]
if web_core_health_ok; then
  previous_service_healthy=1
fi
readonly previous_service_healthy
local_image="$(manager_local_image_reference)"
readonly local_image
docker tag "$ERP_WEB_IMAGE" "$local_image"
test "$(docker image inspect --format '{{.Id}}' "$ERP_WEB_IMAGE")" \
  = "$(docker image inspect --format '{{.Id}}' "$local_image")"

secret_specs="$(docker service inspect \
  --format '{{range .Spec.TaskTemplate.ContainerSpec.Secrets}}{{printf "%s|%s|%s|%s|%d\n" .SecretName .File.Name .File.UID .File.GID .File.Mode}}{{end}}' \
  "$web_service")"
readonly secret_specs
secret_update=()
mapfile -t existing_eat_secret_names < <(
  awk -F'|' -v target='eat-api-service-key' '$2 == target {print $1}' <<<"$secret_specs"
)
if (( ${#existing_eat_secret_names[@]} > 1 )); then
  echo 'Multiple Docker secrets are mounted at the eAT secret target.' >&2
  exit 1
fi
if awk -F'|' -v name="$ERP_EAT_API_SECRET_NAME" -v target='eat-api-service-key' \
  '$1 == name && $2 == target && $3 == "1000" && $4 == "1000" && $5 == "256" {found=1} END {exit found ? 0 : 1}' \
  <<<"$secret_specs"; then
  :
elif awk -F'|' -v name="$ERP_EAT_API_SECRET_NAME" \
  '$1 == name {found=1} END {exit found ? 0 : 1}' \
  <<<"$secret_specs"; then
  echo 'The requested eAT secret is already mounted with an unexpected target or permission.' >&2
  exit 1
else
  if (( ${#existing_eat_secret_names[@]} == 1 )); then
    echo "Rotating eAT secret mount: ${existing_eat_secret_names[0]} -> $ERP_EAT_API_SECRET_NAME"
    secret_update+=(--secret-rm "${existing_eat_secret_names[0]}")
  fi
  secret_update+=(
    --secret-add
    "source=$ERP_EAT_API_SECRET_NAME,target=eat-api-service-key,uid=1000,gid=1000,mode=0400"
  )
fi

update_failure_args=()
if (( previous_service_healthy == 0 )); then
  update_failure_args+=(--update-failure-action pause)
fi
readonly update_failure_args

docker service update \
  --detach=true \
  --no-resolve-image \
  --image "$local_image" \
  --env-add 'EAT_API_SERVICE_KEY_FILE=/run/secrets/eat-api-service-key' \
  --env-add 'EAT_CACHE_TTL_MINUTES=360' \
  "${secret_update[@]}" \
  "${update_failure_args[@]}" \
  --force \
  "$web_service" >/dev/null
service_updated=1
wait_for_web

deployed_image="$(docker service inspect \
  --format '{{.Spec.TaskTemplate.ContainerSpec.Image}}' \
  "$web_service")"
test "$deployed_image" = "$local_image"
deployed_secret_specs="$(docker service inspect \
  --format '{{range .Spec.TaskTemplate.ContainerSpec.Secrets}}{{printf "%s|%s|%s|%s|%d\n" .SecretName .File.Name .File.UID .File.GID .File.Mode}}{{end}}' \
  "$web_service")"
grep -Fxq "$ERP_EAT_API_SECRET_NAME|eat-api-service-key|1000|1000|256" \
  <<<"$deployed_secret_specs"
test "$(awk -F'|' '$2 == "eat-api-service-key" {count++} END {print count + 0}' <<<"$deployed_secret_specs")" -eq 1
service_env="$(docker service inspect \
  --format '{{range .Spec.TaskTemplate.ContainerSpec.Env}}{{println .}}{{end}}' \
  "$web_service")"
test "$(grep -Fxc 'EAT_API_SERVICE_KEY_FILE=/run/secrets/eat-api-service-key' <<<"$service_env")" -eq 1
test "$(grep -Fxc 'EAT_CACHE_TTL_MINUTES=360' <<<"$service_env")" -eq 1

web_container="$(single_running_container "$web_service")"
test "$(docker inspect --format '{{.Image}}' "$web_container")" \
  = "$(docker image inspect --format '{{.Id}}' "$ERP_WEB_IMAGE")"
bash deploy/platform/verify-erp-eat.sh

if (( previous_service_healthy == 0 )) \
  && [[ "$previous_update_failure_action" != 'pause' ]]; then
  docker service update \
    --detach=true \
    --update-failure-action "$previous_update_failure_action" \
    "$web_service" >/dev/null
  test "$(docker service inspect \
    --format '{{.Spec.UpdateConfig.FailureAction}}' \
    "$web_service")" = "$previous_update_failure_action"
fi

trap - ERR
printf 'ERP-only deployment verified: image=%s\n' "$ERP_WEB_IMAGE"
