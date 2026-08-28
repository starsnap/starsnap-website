#!/usr/bin/env bash

set -Eeuo pipefail
set +x

readonly manager_address='192.168.1.103'
readonly manager_label='starsnap.actions-runner'
readonly server_service='starsnap-log_server'
readonly manager_local_image_registry='starsnap.invalid'

previous_image=''
previous_spec_hash=''
previous_version=''
previous_update_failure_action=''
previous_service_healthy=0
update_attempted=0
deployment_complete=0
local_image=''
candidate_spec_hash=''
candidate_version=''
candidate_spec_file=''
baseline_spec_file=''
node_binary=''

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

server_core_health_ok() {
  local replicas update_state container health response
  replicas="$(docker service ls \
    --filter "name=$server_service" \
    --format '{{.Name}} {{.Replicas}}' \
    | awk -v target="$server_service" '$1 == target {print $2}')" || return 1
  test "$replicas" = '1/1' || return 1
  update_state="$(docker service inspect \
    --format '{{if .UpdateStatus}}{{.UpdateStatus.State}}{{else}}completed{{end}}' \
    "$server_service" 2>/dev/null)" || return 1
  [[ "$update_state" =~ ^(completed|rollback_completed)$ ]] || return 1
  container="$(single_running_container "$server_service" 2>/dev/null)" || return 1
  health="$(docker inspect \
    --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' \
    "$container" 2>/dev/null)" || return 1
  test "$health" = 'healthy' || return 1
  response="$(curl --fail --silent --show-error --max-time 10 --noproxy '*' \
    http://127.0.0.1:8081/actuator/health)" || return 1
  test "$(tr -d '[:space:]' <<<"$response")" = '{"status":"UP"}'
}

candidate_server_core_health_ok() {
  local service_image container running_image_id candidate_image_id
  test -n "$local_image" || return 1
  service_image="$(docker service inspect \
    --format '{{.Spec.TaskTemplate.ContainerSpec.Image}}' \
    "$server_service" 2>/dev/null)" || return 1
  test "$service_image" = "$local_image" || return 1
  container="$(single_running_container "$server_service" 2>/dev/null)" || return 1
  running_image_id="$(docker inspect --format '{{.Image}}' "$container" 2>/dev/null)" || return 1
  candidate_image_id="$(docker image inspect --format '{{.Id}}' "$local_image" 2>/dev/null)" || return 1
  test "$running_image_id" = "$candidate_image_id" || return 1
  server_core_health_ok
}

wait_for_server() {
  local expected_state="${1:-completed}"
  local deadline=$((SECONDS + 360)) replicas update_state
  [[ "$expected_state" =~ ^(completed|rollback_completed)$ ]]
  while (( SECONDS < deadline )); do
    replicas="$(docker service ls \
      --filter "name=$server_service" \
      --format '{{.Name}} {{.Replicas}}' \
      | awk -v target="$server_service" '$1 == target {print $2}')"
    update_state="$(docker service inspect \
      --format '{{if .UpdateStatus}}{{.UpdateStatus.State}}{{else}}completed{{end}}' \
      "$server_service" 2>/dev/null || true)"
    case "$update_state" in
      paused|rollback_paused)
        echo "$server_service entered failure state: $update_state" >&2
        docker service ps --no-trunc "$server_service" >&2 || true
        docker service logs --raw --tail 100 "$server_service" >&2 || true
        return 1
        ;;
      rollback_completed)
        if [[ "$expected_state" != 'rollback_completed' ]]; then
          echo "$server_service rolled back instead of completing the candidate deployment." >&2
          docker service ps --no-trunc "$server_service" >&2 || true
          return 1
        fi
        ;;
    esac
    if [[ "$replicas" == '1/1' && "$update_state" == "$expected_state" ]]; then
      return 0
    fi
    sleep 3
  done
  echo "Timed out waiting for $server_service." >&2
  docker service ps --no-trunc "$server_service" >&2 || true
  docker service logs --raw --tail 100 "$server_service" >&2 || true
  return 1
}

service_spec_hash() {
  docker service inspect \
    --format '{{json .Spec}}' \
    "$server_service" \
    | "$node_binary" deploy/platform/canonical-json-sha256.mjs
}

candidate_file_hash() {
  "$node_binary" deploy/platform/canonical-json-sha256.mjs <"$candidate_spec_file"
}

service_version() {
  docker service inspect --format '{{.Version.Index}}' "$server_service"
}

rollback_on_error() {
  local status="${1:-1}" current_hash='' current_version='' current_image=''
  local restored_hash='' restored_image=''
  local restored_container='' restored_running_image='' rollback_ok=1
  trap - ERR HUP INT TERM
  if [[ -z "$candidate_spec_hash" && -s "$candidate_spec_file" ]]; then
    candidate_spec_hash="$(candidate_file_hash)"
  fi
  if (( deployment_complete == 1 )); then
    exit "$status"
  fi
  if (( update_attempted == 1 )); then
    if (( previous_service_healthy == 0 )); then
      echo 'The pre-deploy Hub server was not healthy; refusing to roll back to its unavailable specification.' >&2
      if candidate_server_core_health_ok; then
        echo 'The candidate Hub server image is running and core-healthy; it will remain online for incident recovery.' >&2
      else
        echo "CRITICAL: no healthy Hub server target exists; inspect $server_service immediately." >&2
      fi
      cleanup_candidate_spec || true
      exit "$status"
    fi
    if ! current_hash="$(service_spec_hash 2>/dev/null)" \
      || ! current_version="$(service_version 2>/dev/null)" \
      || ! current_image="$(docker service inspect \
        --format '{{.Spec.TaskTemplate.ContainerSpec.Image}}' \
        "$server_service" 2>/dev/null)"; then
      echo "Could not inspect $server_service while preparing rollback." >&2
      rollback_ok=0
    elif [[ "$current_hash" == "$previous_spec_hash" ]]; then
      echo "$server_service already matches its pre-deploy specification." >&2
    elif [[ -n "$candidate_spec_hash" \
      && "$current_hash" == "$candidate_spec_hash" \
      && "$current_image" == "$local_image" \
      && ( ( -n "$candidate_version" && "$current_version" == "$candidate_version" ) \
        || ( -z "$candidate_version" && "$current_version" != "$previous_version" ) ) ]]; then
      echo "Hub server verification failed; rolling $server_service back to its previous specification." >&2
      if ! restore_service_spec_cas "$current_version" "$baseline_spec_file" >/dev/null; then
        echo "Versioned restore command failed for $server_service." >&2
        rollback_ok=0
      elif ! wait_for_server completed; then
        echo "Versioned restore did not converge for $server_service." >&2
        rollback_ok=0
      fi
    else
      echo "CRITICAL: $server_service changed outside this deployment; refusing to roll back an unowned specification." >&2
      rollback_ok=0
    fi

    restored_hash="$(service_spec_hash 2>/dev/null || true)"
    restored_image="$(docker service inspect \
      --format '{{.Spec.TaskTemplate.ContainerSpec.Image}}' \
      "$server_service" 2>/dev/null || true)"
    if [[ "$restored_hash" != "$previous_spec_hash" || "$restored_image" != "$previous_image" ]]; then
      rollback_ok=0
    fi
    if ! restored_container="$(single_running_container "$server_service" 2>/dev/null)"; then
      rollback_ok=0
    else
      restored_running_image="$(docker inspect --format '{{.Config.Image}}' "$restored_container" 2>/dev/null || true)"
      if [[ "$restored_running_image" != "$previous_image" ]]; then
        rollback_ok=0
      fi
    fi
    if ! server_core_health_ok; then
      echo "The restored $server_service task is not core-healthy." >&2
      rollback_ok=0
    fi
    if (( rollback_ok == 1 )); then
      echo "Hub server rollback verified: image=$previous_image replicas=1/1" >&2
    else
      echo 'CRITICAL: Hub server rollback could not be fully verified; inspect it immediately.' >&2
    fi
  fi
  cleanup_candidate_spec || true
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
  echo 'Node.js is required for the versioned Hub server update.' >&2
  return 1
}

update_service_image_cas() {
  local expected_version="$1" image="$2" spec_file="$3"
  if declare -F hub_server_cas_update_override >/dev/null 2>&1; then
    hub_server_cas_update_override "$expected_version" "$image" "$spec_file"
    return
  fi
  "$node_binary" deploy/platform/update-log-service-cas.mjs \
    "$server_service" "$expected_version" "$image" "$spec_file"
}

cleanup_candidate_spec() {
  local temp_root resolved path
  temp_root="$(cd "${RUNNER_TEMP:-/tmp}" && pwd -P)/"
  for path in "$candidate_spec_file" "$baseline_spec_file"; do
    test -n "$path" || continue
    resolved="$(cd "$(dirname "$path")" && pwd -P)/$(basename "$path")"
    case "$resolved" in
      "$temp_root"starsnap-log-server-spec.*|"$temp_root"starsnap-log-server-baseline.*)
        rm -f -- "$resolved"
        ;;
      *) echo "Refusing to remove unexpected service spec path: $resolved" >&2; return 1 ;;
    esac
  done
}

restore_service_spec_cas() {
  local expected_version="$1" spec_file="$2"
  if declare -F hub_server_cas_restore_override >/dev/null 2>&1; then
    hub_server_cas_restore_override "$expected_version" "$spec_file"
    return
  fi
  "$node_binary" deploy/platform/restore-log-service-cas.mjs \
    "$server_service" "$expected_version" "$spec_file"
}

verify_image() {
  local architecture operating_system expected_repo_digest repo_digests
  [[ "$HUB_SERVER_IMAGE" =~ ^ghcr\.io/starsnap/starsnap-log-server-runtime@sha256:[0-9a-f]{64}$ ]]
  [[ "$HUB_SERVER_PULL_IMAGE" =~ ^ghcr\.io/starsnap/starsnap-log-server-runtime:[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$ ]]
  docker pull "$HUB_SERVER_PULL_IMAGE" >/dev/null
  architecture="$(docker image inspect --format '{{.Architecture}}' "$HUB_SERVER_PULL_IMAGE")"
  operating_system="$(docker image inspect --format '{{.Os}}' "$HUB_SERVER_PULL_IMAGE")"
  [[ "$architecture" =~ ^(arm64|aarch64)$ ]]
  test "$operating_system" = 'linux'
  expected_repo_digest="$HUB_SERVER_IMAGE"
  repo_digests="$(docker image inspect \
    --format '{{range .RepoDigests}}{{println .}}{{end}}' \
    "$HUB_SERVER_PULL_IMAGE")"
  test "$(grep -Fxc "$expected_repo_digest" <<<"$repo_digests")" -eq 1
}

manager_local_image_reference() {
  local digest="${HUB_SERVER_IMAGE##*@sha256:}"
  [[ "$digest" =~ ^[0-9a-f]{64}$ ]]
  printf '%s/starsnap-platform-local/starsnap-log-server:sha-%s\n' \
    "$manager_local_image_registry" "$digest"
}

test "${ALLOW_HUB_SERVER_DEPLOY:-}" = 'DEPLOY-HUB-SERVER-192.168.1.103'
bash deploy/platform/validate-platform.sh
require_manager
resolve_node_binary
docker service inspect "$server_service" >/dev/null
verify_image

baseline_spec_file="$(mktemp "${RUNNER_TEMP:-/tmp}/starsnap-log-server-baseline.XXXXXX")"
docker service inspect --format '{{json .Spec}}' "$server_service" >"$baseline_spec_file"
previous_image="$(docker service inspect \
  --format '{{.Spec.TaskTemplate.ContainerSpec.Image}}' \
  "$server_service")"
readonly previous_image
previous_spec_hash="$("$node_binary" deploy/platform/canonical-json-sha256.mjs <"$baseline_spec_file")"
readonly previous_spec_hash
[[ "$previous_spec_hash" =~ ^[0-9a-f]{64}$ ]]
previous_version="$(service_version)"
readonly previous_version
[[ "$previous_version" =~ ^[0-9]+$ ]]
previous_update_failure_action="$(docker service inspect \
  --format '{{if .Spec.UpdateConfig}}{{.Spec.UpdateConfig.FailureAction}}{{else}}pause{{end}}' \
  "$server_service")"
readonly previous_update_failure_action
test "$previous_update_failure_action" = 'rollback'
if server_core_health_ok; then
  previous_service_healthy=1
fi
readonly previous_service_healthy

local_image="$(manager_local_image_reference)"
readonly local_image
docker tag "$HUB_SERVER_PULL_IMAGE" "$local_image"
test "$(docker image inspect --format '{{.Id}}' "$HUB_SERVER_PULL_IMAGE")" \
  = "$(docker image inspect --format '{{.Id}}' "$local_image")"

update_attempted=1
candidate_spec_file="$(mktemp "${RUNNER_TEMP:-/tmp}/starsnap-log-server-spec.XXXXXX")"
test "$(service_spec_hash)" = "$previous_spec_hash"
test "$(service_version)" = "$previous_version"
update_service_image_cas "$previous_version" "$local_image" "$candidate_spec_file" >/dev/null
candidate_spec_hash="$(candidate_file_hash)"
[[ "$candidate_spec_hash" =~ ^[0-9a-f]{64}$ ]]
test "$candidate_spec_hash" != "$previous_spec_hash"
test "$(service_spec_hash)" = "$candidate_spec_hash"
candidate_version="$(service_version)"
[[ "$candidate_version" =~ ^[0-9]+$ ]]
test "$candidate_version" -gt "$previous_version"
wait_for_server
candidate_server_core_health_ok
test "$(service_spec_hash)" = "$candidate_spec_hash"
test "$(service_version)" = "$candidate_version"

deployment_complete=1
trap - ERR HUP INT TERM
cleanup_candidate_spec
printf 'Hub server deployment verified: image=%s health=UP replicas=1/1\n' "$HUB_SERVER_IMAGE"
