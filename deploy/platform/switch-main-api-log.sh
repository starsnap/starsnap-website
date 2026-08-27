#!/usr/bin/env bash

set -Eeuo pipefail

readonly mode="${1:-}"
readonly api_service="starsnap-main_api"
readonly hub_service="starsnap-hub_server"
readonly new_url="http://starsnap-hub_server:8081"
readonly marker_name="starsnap-main-api-log-route-pre-20260827"
readonly route_timeout_seconds="${STARSNAP_API_LOG_ROUTE_TIMEOUT_SECONDS:-900}"
readonly stable_observations_required="${STARSNAP_API_LOG_ROUTE_STABLE_OBSERVATIONS:-20}"

if [[ ! "$mode" =~ ^(switch|restore)$ ]]; then
  echo "Usage: $0 switch|restore" >&2
  exit 2
fi
if [[ ! "$route_timeout_seconds" =~ ^[1-9][0-9]*$ ]]; then
  echo "STARSNAP_API_LOG_ROUTE_TIMEOUT_SECONDS must be a positive integer." >&2
  exit 2
fi
if [[ ! "$stable_observations_required" =~ ^[1-9][0-9]*$ ]]; then
  echo "STARSNAP_API_LOG_ROUTE_STABLE_OBSERVATIONS must be a positive integer." >&2
  exit 2
fi

service_env_line() {
  docker service inspect \
    --format '{{range .Spec.TaskTemplate.ContainerSpec.Env}}{{println .}}{{end}}' \
    "$api_service" \
    | awk -F= '$1 == "SERVER_LOG_BASE_URL" {print; count++} END {if (count > 1) exit 2}'
}

running_service_container_id() {
  local service="$1"
  docker ps \
    --filter "label=com.docker.swarm.service.name=$service" \
    --filter status=running \
    --format '{{.ID}}' \
    | awk 'NF {id=$0; count++} END {if (count == 1) print id; else exit 1}'
}

container_env_line() {
  local container_id="$1"
  docker inspect \
    --format '{{range .Config.Env}}{{println .}}{{end}}' \
    "$container_id" \
    | awk -F= '$1 == "SERVER_LOG_BASE_URL" {print; count++} END {if (count > 1) exit 2}'
}

wait_for_api() {
  local expected_present="$1"
  local expected_url="$2"
  local allow_extended_monitoring="$3"
  local expected_line=""
  local expected_replicas deadline replicas update_state website_container api_container running_line
  local running_env_valid
  local stable_observations=0
  if [[ "$expected_present" == "true" ]]; then
    expected_line="SERVER_LOG_BASE_URL=$expected_url"
  fi
  expected_replicas="$(docker service inspect --format '{{.Spec.Mode.Replicated.Replicas}}' "$api_service")"
  test "$expected_replicas" -ge 1
  deadline=$((SECONDS + route_timeout_seconds))
  while (( SECONDS < deadline )); do
    replicas="$(docker service ls --filter "name=$api_service" --format '{{.Name}} {{.Replicas}}' | awk -v target="$api_service" '$1 == target {print $2}')"
    update_state="$(docker service inspect --format '{{if .UpdateStatus}}{{.UpdateStatus.State}}{{else}}completed{{end}}' "$api_service")"
    case "$update_state" in
      paused|rollback_paused|rollback_started|rollback_completed)
        docker service ps --no-trunc "$api_service" >&2 || true
        return 1
        ;;
    esac
    if [[ "$replicas" == "$expected_replicas/$expected_replicas" ]]; then
      api_container="$(running_service_container_id "$api_service" 2>/dev/null || true)"
      website_container="$(running_service_container_id starsnap-company_website 2>/dev/null || true)"
      running_line=""
      running_env_valid=false
      if [[ -n "$api_container" ]]; then
        if running_line="$(container_env_line "$api_container" 2>/dev/null)"; then
          running_env_valid=true
        fi
      fi
      if [[ -n "$website_container" \
        && "$running_env_valid" == "true" \
        && "$running_line" == "$expected_line" ]] \
        && docker exec "$website_container" node -e '
          fetch("http://starsnap-main_api:8080/api/health")
            .then(async (response) => {
              const body = await response.json();
              process.exit(response.ok && body.status === "ok" ? 0 : 1);
            })
            .catch(() => process.exit(1));
        '; then
        if [[ "$update_state" == "completed" ]]; then
          return 0
        fi
        if [[ "$allow_extended_monitoring" == "true" && "$update_state" == "updating" ]]; then
          stable_observations=$((stable_observations + 1))
          if (( stable_observations >= stable_observations_required )); then
            echo "$api_service is healthy with the expected log route while Swarm continues its extended update monitor."
            return 0
          fi
        else
          stable_observations=0
        fi
      else
        stable_observations=0
      fi
    else
      stable_observations=0
    fi
    sleep 3
  done
  echo "Timed out waiting for $api_service after ${route_timeout_seconds}s." >&2
  docker service ps --no-trunc "$api_service" >&2 || true
  docker service logs --raw --tail 100 "$api_service" >&2 || true
  return 1
}

apply_route() {
  local target_present="$1"
  local target_url="$2"
  local allow_extended_monitoring="${3:-false}"
  local current_line update_args=(--detach)
  current_line="$(service_env_line)"
  if [[ -n "$current_line" ]]; then
    update_args+=(--env-rm SERVER_LOG_BASE_URL)
  fi
  if [[ "$target_present" == "true" ]]; then
    update_args+=(--env-add "SERVER_LOG_BASE_URL=$target_url")
  fi
  docker service update "${update_args[@]}" "$api_service" >/dev/null
  wait_for_api "$target_present" "$target_url" "$allow_extended_monitoring"
}

docker service inspect "$api_service" >/dev/null

case "$mode" in
  switch)
    test "${ALLOW_API_LOG_ROUTE:-}" = "SWITCH-MAIN-API-LOG"
    test "$(docker service ls --filter "name=$hub_service" --format '{{.Name}} {{.Replicas}}' | awk -v target="$hub_service" '$1 == target {print $2}')" = "1/1"
    current_line="$(service_env_line)"
    current_present=false
    current_url=""
    if [[ -n "$current_line" ]]; then
      current_present=true
      current_url="${current_line#SERVER_LOG_BASE_URL=}"
    fi
    if [[ "$current_present" == "true" && "$current_url" == "$new_url" ]]; then
      if docker config inspect "$marker_name" >/dev/null 2>&1; then
        wait_for_api true "$new_url" true
        echo "SNS API log destination already uses the target Hub and rollback state is present."
        exit 0
      fi
      echo "SNS API log destination uses the target Hub but rollback state is missing." >&2
      exit 1
    fi
    if docker config inspect "$marker_name" >/dev/null 2>&1; then
      previous_present="$(docker config inspect --format '{{index .Spec.Labels "com.starsnap.previous-present"}}' "$marker_name")"
      previous_url="$(docker config inspect --format '{{index .Spec.Labels "com.starsnap.previous-url"}}' "$marker_name")"
      test "$previous_present" = "true" || test "$previous_present" = "false"
      previous_line=""
      if [[ "$previous_present" == "true" ]]; then
        previous_line="SERVER_LOG_BASE_URL=$previous_url"
      fi
      if [[ "$current_line" != "$previous_line" ]]; then
        echo "Previous-route marker exists but the service specification does not match it; refusing to overwrite rollback state." >&2
        exit 1
      fi
      if ! wait_for_api "$previous_present" "$previous_url" false; then
        echo "Previous-route marker exists but the restored runtime is not terminal and healthy; preserving rollback state." >&2
        exit 1
      fi
      docker config rm "$marker_name" >/dev/null
      echo "Removed a completed stale rollback marker before retrying the switch."
    fi
    printf 'previous_present=%s\nprevious_url=%s\n' "$current_present" "$current_url" \
      | docker config create \
        --label "com.starsnap.previous-present=$current_present" \
        --label "com.starsnap.previous-url=$current_url" \
        "$marker_name" - >/dev/null
    if ! apply_route true "$new_url" true; then
      if apply_route "$current_present" "$current_url"; then
        docker config rm "$marker_name" >/dev/null
        echo "SNS API log destination switch failed and rollback completed." >&2
      else
        echo "SNS API log destination switch and rollback verification failed; rollback state was preserved." >&2
      fi
      exit 1
    fi
    echo "SNS API log destination now uses starsnap-hub_server over the Swarm overlay."
    ;;
  restore)
    case "${ALLOW_API_LOG_ROUTE:-}" in
      RESTORE-MAIN-API-LOG|STOP-TARGET-KEEP-DATA) ;;
      *) echo "API log route restore confirmation is missing." >&2; exit 1 ;;
    esac
    if ! docker config inspect "$marker_name" >/dev/null 2>&1; then
      current_line="$(service_env_line)"
      if [[ "$current_line" == "SERVER_LOG_BASE_URL=$new_url" ]]; then
        echo "Cannot restore the SNS API log destination because rollback state is missing." >&2
        exit 1
      fi
      echo "No SNS API log-route rollback marker exists."
      exit 0
    fi
    previous_present="$(docker config inspect --format '{{index .Spec.Labels "com.starsnap.previous-present"}}' "$marker_name")"
    previous_url="$(docker config inspect --format '{{index .Spec.Labels "com.starsnap.previous-url"}}' "$marker_name")"
    test "$previous_present" = "true" || test "$previous_present" = "false"
    apply_route "$previous_present" "$previous_url"
    docker config rm "$marker_name" >/dev/null
    echo "SNS API log destination restored to its pre-migration setting."
    ;;
esac
