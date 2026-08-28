#!/usr/bin/env bash

set -Eeuo pipefail
set +x

readonly manager_address='192.168.1.103'
readonly manager_label='starsnap.actions-runner'
readonly web_service='starsnap-hub_web'
readonly manager_local_image_registry='starsnap.invalid'
readonly expected_icon_sha256='61432c716c06942f957481e9bf7af211081cf3c28ad4b2ecf16dfbb16d7eb8f9'

previous_image=''
previous_task_template_hash=''
previous_update_failure_action=''
previous_service_healthy=0
update_attempted=0
deployment_complete=0
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
    fetch("http://127.0.0.1:5173/")
      .then((response) => process.exit(response.ok ? 0 : 1))
      .catch(() => process.exit(1));
  ' >/dev/null 2>&1
}

candidate_web_core_health_ok() {
  local service_image container running_image_id candidate_image_id icon_hash
  test -n "$local_image" || return 1
  service_image="$(docker service inspect \
    --format '{{.Spec.TaskTemplate.ContainerSpec.Image}}' \
    "$web_service" 2>/dev/null)" || return 1
  test "$service_image" = "$local_image" || return 1
  container="$(single_running_container "$web_service" 2>/dev/null)" || return 1
  running_image_id="$(docker inspect --format '{{.Image}}' "$container" 2>/dev/null)" || return 1
  candidate_image_id="$(docker image inspect --format '{{.Id}}' "$local_image" 2>/dev/null)" || return 1
  test "$running_image_id" = "$candidate_image_id" || return 1
  web_core_health_ok || return 1
  icon_hash="$(docker exec "$container" sha256sum /app/icon-96.png | awk '{print $1}')" || return 1
  test "$icon_hash" = "$expected_icon_sha256" || return 1
  docker exec "$container" node -e '
    const { createHash } = require("node:crypto");
    fetch("http://127.0.0.1:5173/icon-96.png")
      .then(async (response) => ({ response, bytes: Buffer.from(await response.arrayBuffer()) }))
      .then(({ response, bytes }) => {
        const contentType = response.headers.get("content-type") || "";
        const digest = createHash("sha256").update(bytes).digest("hex");
        if (!response.ok || !contentType.startsWith("image/png") || bytes.length !== 8344 || digest !== "61432c716c06942f957481e9bf7af211081cf3c28ad4b2ecf16dfbb16d7eb8f9") process.exit(1);
      })
      .catch(() => process.exit(1));
  ' >/dev/null 2>&1
}

wait_for_web() {
  local expected_state="${1:-completed}"
  local deadline=$((SECONDS + 300)) replicas update_state
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
  local status="${1:-1}" current_hash='' restored_hash='' restored_image=''
  local restored_container='' restored_running_image=''
  local rollback_ok=1
  trap - ERR HUP INT TERM
  if (( deployment_complete == 1 )); then
    exit "$status"
  fi
  if (( update_attempted == 1 )); then
    if (( previous_service_healthy == 0 )); then
      echo 'The pre-deploy Hub web service was not healthy; refusing to roll back to its unavailable specification.' >&2
      if candidate_web_core_health_ok; then
        echo 'The candidate Hub web image is running and core-healthy; it will remain online for incident recovery.' >&2
      else
        echo "CRITICAL: no healthy Hub web target exists; inspect $web_service immediately." >&2
      fi
      exit "$status"
    fi
    if ! current_hash="$(service_task_template_hash 2>/dev/null)"; then
      echo "Could not inspect $web_service while preparing rollback." >&2
      rollback_ok=0
    elif [[ "$current_hash" != "$previous_task_template_hash" ]]; then
      echo "Hub web verification failed; rolling $web_service back to its previous specification." >&2
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

    restored_hash="$(service_task_template_hash 2>/dev/null || true)"
    restored_image="$(docker service inspect \
      --format '{{.Spec.TaskTemplate.ContainerSpec.Image}}' \
      "$web_service" 2>/dev/null || true)"
    if [[ "$restored_hash" != "$previous_task_template_hash" || "$restored_image" != "$previous_image" ]]; then
      rollback_ok=0
    fi
    if ! restored_container="$(single_running_container "$web_service" 2>/dev/null)"; then
      rollback_ok=0
    else
      restored_running_image="$(docker inspect --format '{{.Config.Image}}' "$restored_container" 2>/dev/null || true)"
      if [[ "$restored_running_image" != "$previous_image" ]]; then
        rollback_ok=0
      fi
    fi
    if ! web_core_health_ok; then
      echo "The restored $web_service task is not core-healthy." >&2
      rollback_ok=0
    fi
    if (( rollback_ok == 1 )); then
      echo "Hub web rollback verified: image=$previous_image replicas=1/1" >&2
    else
      echo "CRITICAL: Hub web rollback could not be fully verified; inspect $web_service immediately." >&2
    fi
  fi
  exit "$status"
}
trap 'rollback_on_error $?' ERR
trap 'rollback_on_error 129' HUP
trap 'rollback_on_error 130' INT
trap 'rollback_on_error 143' TERM

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
  local architecture operating_system expected_repo_digest repo_digests
  [[ "$HUB_WEB_IMAGE" =~ ^ghcr\.io/starsnap/starsnap-log-web@sha256:[0-9a-f]{64}$ ]]
  [[ "$HUB_WEB_PULL_IMAGE" =~ ^ghcr\.io/starsnap/starsnap-log-web:[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$ ]]
  docker pull "$HUB_WEB_PULL_IMAGE" >/dev/null
  architecture="$(docker image inspect --format '{{.Architecture}}' "$HUB_WEB_PULL_IMAGE")"
  operating_system="$(docker image inspect --format '{{.Os}}' "$HUB_WEB_PULL_IMAGE")"
  [[ "$architecture" =~ ^(arm64|aarch64)$ ]]
  test "$operating_system" = 'linux'
  expected_repo_digest="$HUB_WEB_IMAGE"
  repo_digests="$(docker image inspect \
    --format '{{range .RepoDigests}}{{println .}}{{end}}' \
    "$HUB_WEB_PULL_IMAGE")"
  test "$(grep -Fxc "$expected_repo_digest" <<<"$repo_digests")" -eq 1
}

manager_local_image_reference() {
  local digest="${HUB_WEB_IMAGE##*@sha256:}"
  [[ "$digest" =~ ^[0-9a-f]{64}$ ]]
  printf '%s/starsnap-platform-local/starsnap-log-web:sha-%s\n' \
    "$manager_local_image_registry" "$digest"
}

test "${ALLOW_HUB_DEPLOY:-}" = 'DEPLOY-HUB-WEB-192.168.1.103'
bash deploy/platform/validate-platform.sh
require_manager
docker service inspect "$web_service" >/dev/null
verify_image

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
docker tag "$HUB_WEB_PULL_IMAGE" "$local_image"
test "$(docker image inspect --format '{{.Id}}' "$HUB_WEB_PULL_IMAGE")" \
  = "$(docker image inspect --format '{{.Id}}' "$local_image")"

update_failure_args=()
if (( previous_service_healthy == 0 )); then
  update_failure_args+=(--update-failure-action pause)
fi
readonly update_failure_args

update_attempted=1
docker service update \
  --detach=true \
  --no-resolve-image \
  --image "$local_image" \
  "${update_failure_args[@]}" \
  --force \
  "$web_service" >/dev/null
wait_for_web
candidate_web_core_health_ok

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

deployment_complete=1
trap - ERR HUP INT TERM
printf 'Hub web deployment verified: image=%s icon_sha256=%s\n' \
  "$HUB_WEB_IMAGE" "$expected_icon_sha256"
