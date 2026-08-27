#!/usr/bin/env bash

set -Eeuo pipefail

readonly mode="${1:-}"
readonly web_service='starsnap-erp_web'
readonly ollama_service='starsnap-erp_ollama'
readonly model_service='starsnap-erp_ollama-model'
readonly manager_address='192.168.1.103'
readonly internal_url='http://ollama:11434'
readonly expected_external_url='http://mac-mini.hamtory.com:11434'
readonly external_url="${ERP_EMBEDDING_BASE_URL:-}"
readonly marker_name='starsnap-erp-ollama-route-pre-mac-mini-20260827'
readonly switch_timeout_seconds="${STARSNAP_OLLAMA_SWITCH_TIMEOUT_SECONDS:-900}"
readonly poll_seconds="${STARSNAP_OLLAMA_SWITCH_POLL_SECONDS:-3}"

previous_url=''
previous_ollama_replicas=''
previous_model_replicas=''
rollback_armed=false
preflight_completed=false
internal_verified=false

fail() {
  echo "$1" >&2
  exit 1
}

service_env_value() {
  docker service inspect \
    --format '{{range .Spec.TaskTemplate.ContainerSpec.Env}}{{println .}}{{end}}' \
    "$web_service" \
    | awk -F= '
        $1 == "ERP_EMBEDDING_BASE_URL" {
          value = substr($0, index($0, "=") + 1)
          count++
        }
        END {
          if (count == 1) print value
          else exit 1
        }
      '
}

service_desired_replicas() {
  docker service inspect \
    --format '{{.Spec.Mode.Replicated.Replicas}}' \
    "$1"
}

running_service_container_id() {
  local service="$1"
  docker ps \
    --filter "label=com.docker.swarm.service.name=$service" \
    --filter status=running \
    --format '{{.ID}}' \
    | awk 'NF {id=$0; count++} END {if (count == 1) print id; else exit 1}'
}

container_env_value() {
  local container_id="$1"
  docker inspect \
    --format '{{range .Config.Env}}{{println .}}{{end}}' \
    "$container_id" \
    | awk -F= '
        $1 == "ERP_EMBEDDING_BASE_URL" {
          value = substr($0, index($0, "=") + 1)
          count++
        }
        END {
          if (count == 1) print value
          else exit 1
        }
      '
}

wait_for_replicas() {
  local service="$1"
  local expected="$2"
  local deadline=$((SECONDS + switch_timeout_seconds))
  local replicas update_state
  while (( SECONDS < deadline )); do
    replicas="$(docker service ls \
      --filter "name=$service" \
      --format '{{.Name}} {{.Replicas}}' \
      | awk -v target="$service" '$1 == target {print $2}')"
    update_state="$(docker service inspect \
      --format '{{if .UpdateStatus}}{{.UpdateStatus.State}}{{else}}completed{{end}}' \
      "$service" 2>/dev/null || true)"
    case "$update_state" in
      paused|rollback_paused)
        echo "$service entered failure state: $update_state" >&2
        docker service ps --no-trunc "$service" >&2 || true
        return 1
        ;;
    esac
    if [[ "$replicas" == "$expected/$expected" \
      && ( "$update_state" == 'completed' || "$update_state" == 'rollback_completed' ) ]]; then
      return 0
    fi
    if [[ "$update_state" == 'rollback_completed' ]]; then
      echo "$service rolled back without reaching $expected/$expected." >&2
      docker service ps --no-trunc "$service" >&2 || true
      return 1
    fi
    sleep "$poll_seconds"
  done
  echo "Timed out waiting for $service=$expected/$expected." >&2
  docker service ps --no-trunc "$service" >&2 || true
  return 1
}

wait_for_completed_service() {
  local service="$1"
  local expected="$2"
  local deadline=$((SECONDS + switch_timeout_seconds))
  local state desired
  while (( SECONDS < deadline )); do
    desired="$(service_desired_replicas "$service" 2>/dev/null || true)"
    state="$(docker service ps \
      --no-trunc \
      --format '{{.CurrentState}}' \
      "$service" 2>/dev/null | head -n 1)"
    if [[ "$desired" == "$expected" && "$state" == Complete* ]]; then
      return 0
    fi
    case "$state" in
      Failed*|Rejected*)
        echo "$service model preparation failed." >&2
        docker service ps --no-trunc "$service" >&2 || true
        return 1
        ;;
    esac
    sleep "$poll_seconds"
  done
  echo "Timed out waiting for completed service: $service." >&2
  docker service ps --no-trunc "$service" >&2 || true
  return 1
}

wait_for_web() {
  local expected_url="$1"
  local expected_replicas deadline replicas update_state container_id running_url
  expected_replicas="$(service_desired_replicas "$web_service")"
  test "$expected_replicas" -ge 1
  deadline=$((SECONDS + switch_timeout_seconds))
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
        return 1
        ;;
    esac
    if [[ "$replicas" == "$expected_replicas/$expected_replicas" ]]; then
      container_id="$(running_service_container_id "$web_service" 2>/dev/null || true)"
      running_url=''
      if [[ -n "$container_id" ]]; then
        running_url="$(container_env_value "$container_id" 2>/dev/null || true)"
      fi
      if [[ "$running_url" == "$expected_url" \
        && ( "$update_state" == 'completed' || "$update_state" == 'rollback_completed' ) ]]; then
        return 0
      fi
    fi
    if [[ "$update_state" == 'rollback_completed' ]]; then
      echo "$web_service rolled back without reaching the expected Ollama endpoint." >&2
      docker service ps --no-trunc "$web_service" >&2 || true
      return 1
    fi
    sleep "$poll_seconds"
  done
  echo "Timed out waiting for $web_service to use the expected Ollama endpoint." >&2
  docker service ps --no-trunc "$web_service" >&2 || true
  return 1
}

verify_endpoint_from_web() {
  local endpoint_url="$1"
  local container_id
  container_id="$(running_service_container_id "$web_service")"
  docker exec \
    --interactive \
    --env "ERP_EMBEDDING_BASE_URL=$endpoint_url" \
    "$container_id" \
    node --input-type=module <deploy/platform/verify-ollama.mjs
}

verify_live_web_endpoint() {
  local expected_url="$1"
  local container_id running_url
  container_id="$(running_service_container_id "$web_service")"
  running_url="$(container_env_value "$container_id")"
  if [[ "$running_url" != "$expected_url" ]]; then
    echo "$web_service runtime does not use the expected Ollama endpoint." >&2
    return 1
  fi
  docker exec \
    --interactive \
    "$container_id" \
    node --input-type=module <deploy/platform/verify-ollama.mjs
}

update_web_endpoint() {
  local target_url="$1"
  local current_url
  current_url="$(service_env_value)"
  if [[ "$current_url" != "$target_url" ]]; then
    docker service update \
      --detach=true \
      --env-rm ERP_EMBEDDING_BASE_URL \
      --env-add "ERP_EMBEDDING_BASE_URL=$target_url" \
      "$web_service" >/dev/null
  fi
  wait_for_web "$target_url"
}

scale_running_service() {
  local service="$1"
  local target="$2"
  if [[ "$(service_desired_replicas "$service")" != "$target" ]]; then
    docker service scale --detach=true "$service=$target" >/dev/null
  fi
  wait_for_replicas "$service" "$target"
}

scale_model_service() {
  local target="$1"
  if [[ "$(service_desired_replicas "$model_service")" != "$target" ]]; then
    docker service scale --detach=true "$model_service=$target" >/dev/null
  fi
  if [[ "$target" == '0' ]]; then
    wait_for_replicas "$model_service" 0
  else
    wait_for_completed_service "$model_service" "$target"
  fi
}

marker_label() {
  docker config inspect \
    --format "{{index .Spec.Labels \"$1\"}}" \
    "$marker_name"
}

load_marker() {
  previous_url="$(marker_label 'com.starsnap.previous-url')"
  previous_ollama_replicas="$(marker_label 'com.starsnap.previous-ollama-replicas')"
  previous_model_replicas="$(marker_label 'com.starsnap.previous-model-replicas')"
  local target_url
  target_url="$(marker_label 'com.starsnap.target-url')"
  [[ "$previous_url" == "$internal_url" \
    && "$target_url" == "$external_url" \
    && "$previous_ollama_replicas" =~ ^[1-9][0-9]*$ \
    && "$previous_model_replicas" =~ ^[0-9]+$ ]]
}

create_marker() {
  printf '%s\n' 'StarSnap ERP Ollama route rollback metadata; no secrets.' \
    | docker config create \
      --label "com.starsnap.previous-url=$previous_url" \
      --label "com.starsnap.previous-ollama-replicas=$previous_ollama_replicas" \
      --label "com.starsnap.previous-model-replicas=$previous_model_replicas" \
      --label "com.starsnap.target-url=$external_url" \
      "$marker_name" - >/dev/null
}

rollback_switch() {
  local status=0
  echo 'Restoring the previous ERP Ollama route and internal service replicas.' >&2

  scale_running_service "$ollama_service" "$previous_ollama_replicas" || status=1
  scale_model_service "$previous_model_replicas" || status=1
  update_web_endpoint "$previous_url" || status=1
  if (( status == 0 )); then
    verify_live_web_endpoint "$previous_url" || status=1
  fi

  if (( status == 0 )); then
    docker config rm "$marker_name" >/dev/null || status=1
  fi
  if (( status == 0 )); then
    echo 'ERP Ollama route rollback completed.' >&2
  else
    echo "ERP Ollama route rollback could not be fully verified; preserving $marker_name." >&2
  fi
  return "$status"
}

handle_error() {
  local status=$?
  trap - ERR
  set +e
  if [[ "$rollback_armed" == 'true' ]]; then
    rollback_switch
  fi
  exit "$status"
}
trap handle_error ERR

if [[ "$mode" != 'switch' ]]; then
  echo "Usage: $0 switch" >&2
  exit 2
fi
if [[ ! "$switch_timeout_seconds" =~ ^[1-9][0-9]*$ ]]; then
  echo 'STARSNAP_OLLAMA_SWITCH_TIMEOUT_SECONDS must be a positive integer.' >&2
  exit 2
fi
if [[ ! "$poll_seconds" =~ ^[0-9]+([.][0-9]+)?$ ]]; then
  echo 'STARSNAP_OLLAMA_SWITCH_POLL_SECONDS must be a non-negative number.' >&2
  exit 2
fi
if [[ "${ALLOW_OLLAMA_ROUTE:-}" != 'SWITCH-OLLAMA-192.168.1.6' ]]; then
  fail 'Ollama route switch confirmation is missing.'
fi
if [[ "$external_url" != "$expected_external_url" ]]; then
  fail "ERP_EMBEDDING_BASE_URL must be $expected_external_url."
fi
if [[ "${ERP_OLLAMA_REPLICAS:-}" != '0' \
  || "${ERP_OLLAMA_MODEL_REPLICAS:-}" != '0' ]]; then
  fail 'ERP_OLLAMA_REPLICAS and ERP_OLLAMA_MODEL_REPLICAS must both be 0.'
fi
if [[ "$(docker info --format '{{.Swarm.ControlAvailable}}')" != 'true' ]]; then
  fail 'The Ollama route switch must run on a Swarm manager.'
fi
actual_manager_address="$(docker node inspect self --format '{{.Status.Addr}}')"
if [[ "$actual_manager_address" != "$manager_address" ]]; then
  fail "Expected Swarm manager address $manager_address, got $actual_manager_address."
fi

docker service inspect "$web_service" "$ollama_service" "$model_service" >/dev/null
current_url="$(service_env_value)"
current_ollama_replicas="$(service_desired_replicas "$ollama_service")"
current_model_replicas="$(service_desired_replicas "$model_service")"

if docker config inspect "$marker_name" >/dev/null 2>&1; then
  if ! load_marker; then
    fail "Rollback marker $marker_name is invalid; preserving it for manual inspection."
  fi
  if [[ "$current_url" != "$previous_url" && "$current_url" != "$external_url" ]]; then
    fail "Rollback marker exists but $web_service has an unexpected endpoint; refusing to overwrite it."
  fi
  rollback_armed=true
else
  if [[ "$current_url" == "$external_url" \
    && "$current_ollama_replicas" == '0' \
    && "$current_model_replicas" == '0' ]]; then
    wait_for_web "$external_url"
    verify_live_web_endpoint "$external_url"
    echo 'ERP already uses the native macOS Ollama endpoint; internal services remain at zero replicas.'
    exit 0
  fi
  if [[ "$current_url" != "$internal_url" ]]; then
    fail 'ERP Ollama endpoint is neither the known internal route nor a completed target state.'
  fi
  if [[ ! "$current_ollama_replicas" =~ ^[1-9][0-9]*$ \
    || ! "$current_model_replicas" =~ ^[0-9]+$ ]]; then
    fail 'Internal Ollama must still be available before the first external preflight.'
  fi

  wait_for_replicas "$ollama_service" "$current_ollama_replicas"
  wait_for_web "$internal_url"
  verify_live_web_endpoint "$internal_url"
  internal_verified=true
  echo 'Preflighting native macOS Ollama from the live ERP web task.'
  verify_endpoint_from_web "$external_url"
  preflight_completed=true

  previous_url="$current_url"
  previous_ollama_replicas="$current_ollama_replicas"
  previous_model_replicas="$current_model_replicas"
  create_marker
  rollback_armed=true
fi

current_url="$(service_env_value)"
if [[ "$current_url" == "$previous_url" ]]; then
  scale_running_service "$ollama_service" "$previous_ollama_replicas"
  scale_model_service "$previous_model_replicas"
  if [[ "$internal_verified" != 'true' ]]; then
    verify_live_web_endpoint "$previous_url"
  fi
  if [[ "$preflight_completed" != 'true' ]]; then
    echo 'Preflighting native macOS Ollama from the live ERP web task.'
    verify_endpoint_from_web "$external_url"
  fi
  update_web_endpoint "$external_url"
else
  wait_for_web "$external_url"
fi

verify_live_web_endpoint "$external_url"
scale_model_service 0
scale_running_service "$ollama_service" 0
verify_live_web_endpoint "$external_url"

docker config rm "$marker_name" >/dev/null
rollback_armed=false
echo 'ERP now uses native macOS Ollama; internal Ollama services are at zero replicas.'
