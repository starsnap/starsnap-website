#!/usr/bin/env bash

set -Eeuo pipefail

readonly mode="${1:-}"
readonly api_service="starsnap-main_api"
readonly hub_service="starsnap-hub_server"
readonly new_url="http://starsnap-hub_server:8081"
readonly marker_name="starsnap-main-api-log-route-pre-20260827"

if [[ ! "$mode" =~ ^(switch|restore)$ ]]; then
  echo "Usage: $0 switch|restore" >&2
  exit 2
fi

service_env_line() {
  docker service inspect \
    --format '{{range .Spec.TaskTemplate.ContainerSpec.Env}}{{println .}}{{end}}' \
    "$api_service" \
    | awk -F= '$1 == "SERVER_LOG_BASE_URL" {print; count++} END {if (count > 1) exit 2}'
}

wait_for_api() {
  local expected_replicas deadline replicas update_state website_container
  expected_replicas="$(docker service inspect --format '{{.Spec.Mode.Replicated.Replicas}}' "$api_service")"
  test "$expected_replicas" -ge 1
  deadline=$((SECONDS + 600))
  while (( SECONDS < deadline )); do
    replicas="$(docker service ls --filter "name=$api_service" --format '{{.Name}} {{.Replicas}}' | awk -v target="$api_service" '$1 == target {print $2}')"
    update_state="$(docker service inspect --format '{{if .UpdateStatus}}{{.UpdateStatus.State}}{{else}}completed{{end}}' "$api_service")"
    case "$update_state" in
      paused|rollback_paused|rollback_started|rollback_completed)
        docker service ps --no-trunc "$api_service" >&2 || true
        return 1
        ;;
    esac
    if [[ "$replicas" == "$expected_replicas/$expected_replicas" && "$update_state" == "completed" ]]; then
      website_container="$(docker ps \
        --filter label=com.docker.swarm.service.name=starsnap-company_website \
        --filter status=running \
        --format '{{.ID}}')"
      if [[ "$(awk 'NF {count++} END {print count + 0}' <<<"$website_container")" -eq 1 ]] \
        && docker exec "$website_container" node -e '
          fetch("http://starsnap-main_api:8080/api/health")
            .then(async (response) => {
              const body = await response.json();
              process.exit(response.ok && body.status === "ok" ? 0 : 1);
            })
            .catch(() => process.exit(1));
        '; then
        return 0
      fi
    fi
    sleep 3
  done
  docker service ps --no-trunc "$api_service" >&2 || true
  return 1
}

apply_route() {
  local target_present="$1"
  local target_url="$2"
  local current_line update_args=(--detach)
  current_line="$(service_env_line)"
  if [[ -n "$current_line" ]]; then
    update_args+=(--env-rm SERVER_LOG_BASE_URL)
  fi
  if [[ "$target_present" == "true" ]]; then
    update_args+=(--env-add "SERVER_LOG_BASE_URL=$target_url")
  fi
  docker service update "${update_args[@]}" "$api_service" >/dev/null
  wait_for_api
}

docker service inspect "$api_service" >/dev/null
test "$(docker service ls --filter "name=$hub_service" --format '{{.Name}} {{.Replicas}}' | awk -v target="$hub_service" '$1 == target {print $2}')" = "1/1"

case "$mode" in
  switch)
    test "${ALLOW_API_LOG_ROUTE:-}" = "SWITCH-MAIN-API-LOG"
    current_line="$(service_env_line)"
    current_present=false
    current_url=""
    if [[ -n "$current_line" ]]; then
      current_present=true
      current_url="${current_line#SERVER_LOG_BASE_URL=}"
    fi
    if [[ "$current_present" == "true" && "$current_url" == "$new_url" ]]; then
      if docker config inspect "$marker_name" >/dev/null 2>&1; then
        echo "SNS API log destination already uses the target Hub and rollback state is present."
        exit 0
      fi
      echo "SNS API log destination uses the target Hub but rollback state is missing." >&2
      exit 1
    fi
    if docker config inspect "$marker_name" >/dev/null 2>&1; then
      echo "Previous-route marker already exists; refusing to overwrite rollback state." >&2
      exit 1
    fi
    printf 'previous_present=%s\nprevious_url=%s\n' "$current_present" "$current_url" \
      | docker config create \
        --label "com.starsnap.previous-present=$current_present" \
        --label "com.starsnap.previous-url=$current_url" \
        "$marker_name" - >/dev/null
    if ! apply_route true "$new_url"; then
      apply_route "$current_present" "$current_url" || true
      docker config rm "$marker_name" >/dev/null 2>&1 || true
      echo "SNS API log destination switch failed and rollback was requested." >&2
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
