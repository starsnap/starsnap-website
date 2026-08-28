#!/usr/bin/env bash

set -euo pipefail

readonly candidate_image="ghcr.io/starsnap/starsnap-website@sha256:1111111111111111111111111111111111111111111111111111111111111111"
readonly previous_image="ghcr.io/starsnap/starsnap-website@sha256:2222222222222222222222222222222222222222222222222222222222222222"
readonly caddy_image="docker.io/library/caddy:2.10.2-alpine@sha256:4c6e91c6ed0e2fa03efd5b44747b625fec79bc9cd06ac5235a779726618e530d"
readonly caddy_service_image="${caddy_image#docker.io/library/}"
export candidate_image previous_image caddy_image caddy_service_image

test_root="$(mktemp -d)"
export FAKE_SWARM_STATE="$test_root/swarm"
export FAKE_FAIL_CANDIDATE=false
export FAKE_FAIL_CADDY_HEALTH=false
export FAKE_FAIL_INTERNAL_ROUTES=false
export FAKE_SERVICE_LIST_ERROR=false
export FAKE_API_NETWORK_MISSING=false
export FAKE_API_SERVICE_NETWORK_MISSING=false
export FAKE_RUNNER_NODE_LABEL=true
export FAKE_RUNNER_NODE_IDS=fake-runner-node-id
export FAKE_CADDY_SERVICE_IMAGE="$caddy_service_image"

cleanup() {
  if [[ "$test_root" == /tmp/* || "$test_root" == /var/folders/* ]]; then
    find "$test_root" -depth -delete
  fi
}
trap cleanup EXIT
trap 'echo "test-deploy-swarm failed at line $LINENO" >&2' ERR

reset_state() {
  mkdir -p "$FAKE_SWARM_STATE"
  mkdir -p "$FAKE_SWARM_STATE/configs"
  printf '%s' "$previous_image" >"$FAKE_SWARM_STATE/current-image"
  printf '%s' "completed" >"$FAKE_SWARM_STATE/update-state"
  printf '%s' "1/1" >"$FAKE_SWARM_STATE/replicas"
  touch "$FAKE_SWARM_STATE/stack-exists"
  rm -f -- "$FAKE_SWARM_STATE/caddy-image"
  rm -f -- "$FAKE_SWARM_STATE/caddy-config"
  rm -f -- "$FAKE_SWARM_STATE/caddy-update-state"
  rm -f -- "$FAKE_SWARM_STATE/caddy-replicas"
  rm -f -- "$FAKE_SWARM_STATE/caddy-spec"
  rm -f -- "$FAKE_SWARM_STATE/previous-caddy-config"
  rm -f -- "$FAKE_SWARM_STATE/previous-caddy-spec"
  find "$FAKE_SWARM_STATE/configs" -type f -delete
  rm -f -- "$FAKE_SWARM_STATE/rollback-requested"
  rm -f -- "$FAKE_SWARM_STATE/caddy-rollback-requested"
  rm -f -- "$FAKE_SWARM_STATE/stack-remove-requested"
  rm -f -- "$FAKE_SWARM_STATE/pulled-image"
  export FAKE_FAIL_CANDIDATE=false
  export FAKE_FAIL_CADDY_HEALTH=false
  export FAKE_FAIL_INTERNAL_ROUTES=false
  export FAKE_SERVICE_LIST_ERROR=false
  export FAKE_API_NETWORK_MISSING=false
  export FAKE_API_SERVICE_NETWORK_MISSING=false
  export FAKE_RUNNER_NODE_LABEL=true
  export FAKE_RUNNER_NODE_IDS=fake-runner-node-id
  export FAKE_CADDY_SERVICE_IMAGE="$caddy_service_image"
}

seed_previous_caddy() {
  local config_digest=""
  local config_name=""

  config_digest="$(sha256sum deploy/Caddyfile | awk '{print $1}')"
  config_name="starsnap-company_caddyfile_${config_digest:0:16}"
  printf '%s' "$caddy_service_image" >"$FAKE_SWARM_STATE/caddy-image"
  printf '%s' "$config_name" >"$FAKE_SWARM_STATE/caddy-config"
  printf '%s' "$config_name" >"$FAKE_SWARM_STATE/previous-caddy-config"
  printf '%s' "completed" >"$FAKE_SWARM_STATE/caddy-update-state"
  printf '%s' "1/1" >"$FAKE_SWARM_STATE/caddy-replicas"
  printf '%s' '{"Name":"starsnap-company_caddy","Labels":{"spec":"previous"}}' >"$FAKE_SWARM_STATE/caddy-spec"
  cp "$FAKE_SWARM_STATE/caddy-spec" "$FAKE_SWARM_STATE/previous-caddy-spec"
  cp deploy/Caddyfile "$FAKE_SWARM_STATE/configs/$config_name.data"
  printf '%s' "$config_digest" >"$FAKE_SWARM_STATE/configs/$config_name.digest"
}

docker() {
  local config_name=""
  local config_source=""
  local digest_label=""
  local target=""
  local verifier_source=""

  case "$1 $2" in
    "info --format")
      if [[ " $* " == *".Swarm.NodeID"* ]]; then
        printf '%s\n' "fake-runner-node-id"
      else
        printf '%s\n' "true"
      fi
      ;;
    "node inspect")
      printf '%s\n' "$FAKE_RUNNER_NODE_LABEL"
      ;;
    "node ls")
      if [[ " $* " != *" --filter node.label=starsnap.actions-runner=true "* \
        || " $* " != *" --format {{.ID}} "* \
        || " $* " == *" --no-trunc "* ]]; then
        echo "Expected a supported full-ID node label query." >&2
        return 1
      fi
      printf '%s\n' "$FAKE_RUNNER_NODE_IDS"
      ;;
    "service inspect")
      target="${!#}"
      if [[ "$target" == "starsnap-main_api" ]]; then
        if [[ "$FAKE_API_SERVICE_NETWORK_MISSING" == "true" ]]; then
          printf '%s\n' "unrelated-network-id"
        elif [[ " $* " == *"TaskTemplate.Networks"* ]]; then
          printf '%s\n' "fake-api-network-id"
        fi
        return 0
      fi

      if [[ "$target" == "starsnap-company_website" ]]; then
        if [[ ! -f "$FAKE_SWARM_STATE/current-image" ]]; then
          return 1
        fi
        if [[ " $* " == *" --format "* ]]; then
          if [[ " $* " == *"ContainerSpec.Image"* ]]; then
            cat "$FAKE_SWARM_STATE/current-image"
          elif [[ " $* " == *"{{json .Spec}}"* ]]; then
            printf '%s' '{"Name":"starsnap-company_website"}'
          else
            cat "$FAKE_SWARM_STATE/update-state"
          fi
        fi
        return 0
      fi

      if [[ "$target" != "starsnap-company_caddy" || ! -f "$FAKE_SWARM_STATE/caddy-image" ]]; then
        return 1
      fi
      if [[ " $* " == *" --format "* ]]; then
        if [[ " $* " == *"ContainerSpec.Image"* ]]; then
          cat "$FAKE_SWARM_STATE/caddy-image"
        elif [[ " $* " == *"ContainerSpec.Configs"* ]]; then
          cat "$FAKE_SWARM_STATE/caddy-config"
        elif [[ " $* " == *"{{json .Spec}}"* ]]; then
          cat "$FAKE_SWARM_STATE/caddy-spec"
        else
          cat "$FAKE_SWARM_STATE/caddy-update-state"
        fi
      fi
      ;;
    "service ls")
      if [[ "$FAKE_SERVICE_LIST_ERROR" == "true" ]]; then
        return 1
      fi

      if [[ " $* " == *"name=starsnap-company_website"* ]]; then
        if [[ -f "$FAKE_SWARM_STATE/current-image" ]]; then
          printf '%s %s\n' "starsnap-company_website" "$(cat "$FAKE_SWARM_STATE/replicas")"
        fi
        return 0
      fi
      if [[ " $* " == *"name=starsnap-company_caddy"* ]]; then
        if [[ -f "$FAKE_SWARM_STATE/caddy-image" ]]; then
          printf '%s %s\n' "starsnap-company_caddy" "$(cat "$FAKE_SWARM_STATE/caddy-replicas")"
        fi
        return 0
      fi

      if [[ -f "$FAKE_SWARM_STATE/current-image" ]]; then
        printf '%s\n' "starsnap-company_website"
      fi
      if [[ -f "$FAKE_SWARM_STATE/caddy-image" ]]; then
        printf '%s\n' "starsnap-company_caddy"
      fi
      ;;
    "service ps")
      ;;
    "ps --filter")
      if [[ " $* " == *"com.docker.swarm.service.name=starsnap-erp_web"* ]]; then
        printf '%s\n' "erp-container"
      elif [[ " $* " == *"com.docker.swarm.service.name=starsnap-company_website"* \
        && -f "$FAKE_SWARM_STATE/current-image" ]]; then
        printf '%s\n' "website-container"
      elif [[ " $* " == *"com.docker.swarm.service.name=starsnap-company_caddy"* \
        && -f "$FAKE_SWARM_STATE/caddy-image" ]]; then
        printf '%s\n' "caddy-container"
      fi
      ;;
    "inspect --format")
      target="${!#}"
      if [[ "$target" == "website-container" ]]; then
        if [[ "$FAKE_FAIL_CANDIDATE" == "true" \
          && "$(cat "$FAKE_SWARM_STATE/current-image")" == "$candidate_image" ]]; then
          printf '%s\n' "unhealthy"
        else
          printf '%s\n' "healthy"
        fi
      elif [[ "$target" == "caddy-container" ]]; then
        if [[ "$FAKE_FAIL_CADDY_HEALTH" == "true" \
          && "$(cat "$FAKE_SWARM_STATE/caddy-spec")" == *'"spec":"candidate"'* ]]; then
          printf '%s\n' "unhealthy"
        else
          printf '%s\n' "healthy"
        fi
      else
        return 1
      fi
      ;;
    "exec --interactive")
      verifier_source="$(cat)"
      if [[ "$3" != "erp-container" ]]; then
        echo "Expected the route verifier to run from the ERP application network." >&2
        return 1
      fi
      grep -Fq 'hostname: "caddy"' <<<"$verifier_source"
      grep -Fq 'rejectUnauthorized: true' <<<"$verifier_source"
      if [[ " $* " != *" node --input-type=module "* ]]; then
        echo "Expected the route verifier to run as an ES module." >&2
        return 1
      fi
      if [[ "$FAKE_FAIL_INTERNAL_ROUTES" == "true" ]]; then
        return 1
      fi
      ;;
    "service rollback")
      target="${!#}"
      if [[ "$target" == "starsnap-company_website" ]]; then
        printf '%s' "$previous_image" >"$FAKE_SWARM_STATE/current-image"
        printf '%s' "rollback_completed" >"$FAKE_SWARM_STATE/update-state"
        touch "$FAKE_SWARM_STATE/rollback-requested"
      else
        printf '%s' "$caddy_service_image" >"$FAKE_SWARM_STATE/caddy-image"
        cat "$FAKE_SWARM_STATE/previous-caddy-config" >"$FAKE_SWARM_STATE/caddy-config"
        cat "$FAKE_SWARM_STATE/previous-caddy-spec" >"$FAKE_SWARM_STATE/caddy-spec"
        printf '%s' "rollback_completed" >"$FAKE_SWARM_STATE/caddy-update-state"
        touch "$FAKE_SWARM_STATE/caddy-rollback-requested"
      fi
      ;;
    "service rm")
      target="$3"
      if [[ "$target" == "starsnap-company_website" ]]; then
        rm -f -- "$FAKE_SWARM_STATE/current-image"
      else
        rm -f -- "$FAKE_SWARM_STATE/caddy-image"
        rm -f -- "$FAKE_SWARM_STATE/caddy-config"
        rm -f -- "$FAKE_SWARM_STATE/caddy-update-state"
        rm -f -- "$FAKE_SWARM_STATE/caddy-replicas"
        rm -f -- "$FAKE_SWARM_STATE/caddy-spec"
      fi
      ;;
    "stack config")
      printf 'services:\n  caddy:\n    deploy:\n      placement:\n        constraints:\n          - node.role == manager\n          - node.labels.starsnap.actions-runner == true\n    image: %s\n    networks:\n      default: null\n      starsnap_main_app_net: null\n  website:\n    deploy:\n      placement:\n        constraints:\n          - node.role == manager\n          - node.labels.starsnap.actions-runner == true\n    image: %s\nconfigs:\n  caddyfile:\n    name: %s\nnetworks:\n  starsnap_main_app_net:\n    name: starsnap-main_app-net\n    external: true\n' \
        "$caddy_image" "$STARSNAP_WEBSITE_IMAGE" "$CADDY_CONFIG_NAME"
      ;;
    "stack ls")
      if [[ -f "$FAKE_SWARM_STATE/stack-exists" ]]; then
        printf '%s\n' "starsnap-company"
      fi
      ;;
    pull\ *)
      printf '%s\n' "$2" >>"$FAKE_SWARM_STATE/pulled-image"
      ;;
    "run --rm")
      if [[ " $* " != *" $caddy_image "* || " $* " != *" validate --config - --adapter caddyfile "* ]]; then
        echo "Expected the pinned Caddy image to validate stdin." >&2
        return 1
      fi
      cat >/dev/null
      ;;
    "network inspect")
      if [[ "$FAKE_API_NETWORK_MISSING" == "true" ]]; then
        return 1
      fi
      printf '%s\n' "overlay swarm fake-api-network-id"
      ;;
    "config ls")
      find "$FAKE_SWARM_STATE/configs" -type f -name '*.data' -printf '%f\n' \
        | sed 's/\.data$//'
      ;;
    "config inspect")
      target="${!#}"
      if [[ ! -f "$FAKE_SWARM_STATE/configs/$target.data" ]]; then
        return 1
      fi
      if [[ " $* " == *" --format "* ]]; then
        cat "$FAKE_SWARM_STATE/configs/$target.digest"
      fi
      ;;
    "config create")
      config_name="${*: -2:1}"
      config_source="${*: -1}"
      digest_label=""
      for target in "$@"; do
        if [[ "$target" == com.starsnap.config-sha256=* ]]; then
          digest_label="${target#*=}"
        fi
      done
      cp "$config_source" "$FAKE_SWARM_STATE/configs/$config_name.data"
      printf '%s' "$digest_label" >"$FAKE_SWARM_STATE/configs/$config_name.digest"
      ;;
    "config rm")
      target="$3"
      rm -f -- "$FAKE_SWARM_STATE/configs/$target.data" "$FAKE_SWARM_STATE/configs/$target.digest"
      ;;
    "stack deploy")
      if [[ " $* " != *" --with-registry-auth "* ]]; then
        echo "Expected registry credentials to be forwarded to Swarm." >&2
        return 1
      fi
      if ! grep -Fxq "$STARSNAP_WEBSITE_IMAGE" "$FAKE_SWARM_STATE/pulled-image" \
        || ! grep -Fxq "$caddy_image" "$FAKE_SWARM_STATE/pulled-image"; then
        echo "Expected both immutable images to be pulled before deployment." >&2
        return 1
      fi
      touch "$FAKE_SWARM_STATE/stack-exists"
      printf '%s' "$STARSNAP_WEBSITE_IMAGE" >"$FAKE_SWARM_STATE/current-image"
      printf '%s' "completed" >"$FAKE_SWARM_STATE/update-state"
      printf '%s' "$FAKE_CADDY_SERVICE_IMAGE" >"$FAKE_SWARM_STATE/caddy-image"
      printf '%s' "$CADDY_CONFIG_NAME" >"$FAKE_SWARM_STATE/caddy-config"
      printf '%s' "completed" >"$FAKE_SWARM_STATE/caddy-update-state"
      printf '%s' "1/1" >"$FAKE_SWARM_STATE/caddy-replicas"
      printf '%s' '{"Name":"starsnap-company_caddy","Labels":{"spec":"candidate"}}' >"$FAKE_SWARM_STATE/caddy-spec"
      ;;
    "stack rm")
      rm -f -- "$FAKE_SWARM_STATE/current-image"
      rm -f -- "$FAKE_SWARM_STATE/caddy-image"
      rm -f -- "$FAKE_SWARM_STATE/caddy-config"
      rm -f -- "$FAKE_SWARM_STATE/caddy-update-state"
      rm -f -- "$FAKE_SWARM_STATE/caddy-replicas"
      rm -f -- "$FAKE_SWARM_STATE/caddy-spec"
      rm -f -- "$FAKE_SWARM_STATE/stack-exists"
      touch "$FAKE_SWARM_STATE/stack-remove-requested"
      ;;
    *)
      printf 'Unexpected fake Docker call: %s\n' "$*" >&2
      return 1
      ;;
  esac
}

sleep() {
  SECONDS=$((SECONDS + 60))
}

export -f docker sleep

run_deploy() {
  STACK_NAME="starsnap-company" \
  SERVICE_NAME="starsnap-company_website" \
  STARSNAP_ROLLOUT_TIMEOUT_SECONDS=30 \
  STARSNAP_ROLLBACK_TIMEOUT_SECONDS=30 \
  STARSNAP_CLEANUP_TIMEOUT_SECONDS=30 \
  STARSNAP_WEBSITE_IMAGE="$candidate_image" \
    bash deploy/deploy-swarm.sh
}

reset_state
success_output="$(run_deploy 2>&1)"
grep -Fq "Deployment verified: $candidate_image" <<<"$success_output"
grep -Fq "Caddy verified: $caddy_image" <<<"$success_output"
test ! -e "$FAKE_SWARM_STATE/rollback-requested"
test -e "$FAKE_SWARM_STATE/caddy-image"
test -e "$FAKE_SWARM_STATE/caddy-config"
test "$(cat "$FAKE_SWARM_STATE/caddy-image")" = "$caddy_service_image"
test "$caddy_service_image" != "$caddy_image"

reset_state
export FAKE_CADDY_SERVICE_IMAGE="registry.invalid/library/$caddy_service_image"
if wrong_caddy_repository_output="$(run_deploy 2>&1)"; then
  echo "Expected the same Caddy digest from another repository to be rejected." >&2
  exit 1
fi
grep -Fq "Timed out waiting for the Caddy deploy operation" \
  <<<"$wrong_caddy_repository_output"
grep -Fq "Website rollback verified: $previous_image" \
  <<<"$wrong_caddy_repository_output"
test ! -e "$FAKE_SWARM_STATE/caddy-image"

grep -Fq "reverse_proxy starsnap-main_api:8080" deploy/Caddyfile
grep -Fq "reverse_proxy starsnap-erp_web:3000" deploy/Caddyfile
grep -Fq "reverse_proxy starsnap-sns_web:3000" deploy/Caddyfile
grep -Fq "chat.starsnap.kr {" deploy/Caddyfile
chat_caddy_block="$(sed -n '/^chat\.starsnap\.kr {$/,/^admin\.starsnap\.kr {$/p' deploy/Caddyfile)"
grep -Fq "reverse_proxy starsnap-sns_web:3000" <<<"$chat_caddy_block"
grep -Fq 'Content-Security-Policy "frame-ancestors '\''none'\''"' <<<"$chat_caddy_block"
grep -Fq 'X-Content-Type-Options "nosniff"' <<<"$chat_caddy_block"
grep -Fq 'X-Frame-Options "DENY"' <<<"$chat_caddy_block"
grep -Fq 'X-StarSnap-App-Surface "chat"' <<<"$chat_caddy_block"
grep -Fq "admin.starsnap.kr {" deploy/Caddyfile
grep -Fq "@admin_api path /api/*" deploy/Caddyfile
grep -Fq "reverse_proxy starsnap-admin_server:8082" deploy/Caddyfile
grep -Fq "reverse_proxy starsnap-admin_web:5174" deploy/Caddyfile
grep -Fq 'hostname: "starsnap-erp_web"' deploy/verify-internal.mjs
grep -Fq 'port: 3000' deploy/verify-internal.mjs
grep -Fq 'headers: { host: "erp.starsnap.kr" }' deploy/verify-internal.mjs
grep -Fq 'caddyHttps("erp.starsnap.kr", "/api/health/")' deploy/verify-internal.mjs
grep -Fq 'caddyHttps("sns.starsnap.kr", "/api/health")' deploy/verify-internal.mjs
grep -Fq 'caddyHttp("chat.starsnap.kr", "/api/health")' deploy/verify-internal.mjs
grep -Fq 'caddyHttps("chat.starsnap.kr", "/")' deploy/verify-internal.mjs
grep -Fq 'caddyHttps("chat.starsnap.kr", "/api/health")' deploy/verify-internal.mjs
grep -Fq 'expectHeader(chatRoot, "x-starsnap-app-surface", "chat"' deploy/verify-internal.mjs
grep -Fq 'caddyHttp("admin.starsnap.kr", "/api/health")' deploy/verify-internal.mjs
grep -Fq 'caddyHttps("admin.starsnap.kr", "/")' deploy/verify-internal.mjs
grep -Fq 'caddyHttps("admin.starsnap.kr", "/api/health")' deploy/verify-internal.mjs
grep -Fq "log.starsnap.kr {" deploy/Caddyfile
grep -Fq "@log_dashboard_api path /api/dashboard/*" deploy/Caddyfile
grep -Fq "reverse_proxy starsnap-log-server:8081" deploy/Caddyfile
grep -Fq "@log_blocked_api path /api/*" deploy/Caddyfile
grep -Fq "reverse_proxy starsnap-log-web:5173" deploy/Caddyfile
grep -Fq 'caddyHttp("log.starsnap.kr", "/")' deploy/verify-internal.mjs
grep -Fq 'caddyHttps("log.starsnap.kr", "/")' deploy/verify-internal.mjs
grep -Fq 'await caddyHttps("log.starsnap.kr", logServicesPath)' deploy/verify-internal.mjs
grep -Fq '"Log Hub dashboard Access gate"' deploy/verify-internal.mjs
grep -Fq 'hostname: "starsnap-log-server"' deploy/verify-internal.mjs
grep -Fq 'port: 8081' deploy/verify-internal.mjs
grep -Fq 'headers: { host: "log.starsnap.kr" }' deploy/verify-internal.mjs
grep -Fq 'expectStatus(logHealth, 200, "Log Hub service health")' deploy/verify-internal.mjs
grep -Fq 'if (logHealthPayload.status !== "UP")' deploy/verify-internal.mjs
grep -Fq 'caddyHttps("log.starsnap.kr", "/api/server-logs")' deploy/verify-internal.mjs
if grep -Fq "reverse_proxy 192.168.1.103:8080" deploy/Caddyfile; then
  echo "Caddy must reach the API over the shared Swarm overlay." >&2
  exit 1
fi
if grep -Fq "192.168.1.2" deploy/Caddyfile deploy/verify-internal.mjs; then
  echo "Production routes must not depend on the desktop host." >&2
  exit 1
fi

reset_state
export FAKE_RUNNER_NODE_LABEL=false
if unlabeled_node_output="$(run_deploy 2>&1)"; then
  echo "Expected an unlabeled manager to stop deployment." >&2
  exit 1
fi
grep -Fq "Current Swarm manager must have starsnap.actions-runner=true" <<<"$unlabeled_node_output"
test ! -e "$FAKE_SWARM_STATE/caddy-image"
test ! -e "$FAKE_SWARM_STATE/rollback-requested"

reset_state
export FAKE_RUNNER_NODE_IDS=$'fake-runner-node-id\nsecond-runner-node-id'
if duplicate_labeled_node_output="$(run_deploy 2>&1)"; then
  echo "Expected multiple labeled nodes to stop deployment." >&2
  exit 1
fi
grep -Fq "Expected exactly one Swarm node with starsnap.actions-runner=true; found 2" \
  <<<"$duplicate_labeled_node_output"
test ! -e "$FAKE_SWARM_STATE/caddy-image"
test ! -e "$FAKE_SWARM_STATE/rollback-requested"

reset_state
export FAKE_RUNNER_NODE_IDS=other-runner-node-id
if mismatched_labeled_node_output="$(run_deploy 2>&1)"; then
  echo "Expected a label on a different node to stop deployment." >&2
  exit 1
fi
grep -Fq "The sole starsnap.actions-runner node must be the current manager" \
  <<<"$mismatched_labeled_node_output"
test ! -e "$FAKE_SWARM_STATE/caddy-image"
test ! -e "$FAKE_SWARM_STATE/rollback-requested"

if grep -Eq 'STARSNAP_(HEALTH|PROXY_HEALTH)_URL|(^|[[:space:]])curl([[:space:]]|$)' deploy/deploy-swarm.sh; then
  echo "Swarm convergence must not depend on LAN HTTP requests." >&2
  exit 1
fi

reset_state
export FAKE_API_NETWORK_MISSING=true
if missing_network_output="$(run_deploy 2>&1)"; then
  echo "Expected a missing API overlay to stop deployment." >&2
  exit 1
fi
grep -Fq "Required API overlay network is missing" <<<"$missing_network_output"
test ! -e "$FAKE_SWARM_STATE/caddy-image"
test ! -e "$FAKE_SWARM_STATE/rollback-requested"

reset_state
export FAKE_API_SERVICE_NETWORK_MISSING=true
if detached_api_output="$(run_deploy 2>&1)"; then
  echo "Expected a detached API service to stop deployment." >&2
  exit 1
fi
grep -Fq "starsnap-main_api is not attached to starsnap-main_app-net" <<<"$detached_api_output"
test ! -e "$FAKE_SWARM_STATE/caddy-image"
test ! -e "$FAKE_SWARM_STATE/rollback-requested"

reset_state
export FAKE_FAIL_CANDIDATE=true
if failure_output="$(run_deploy 2>&1)"; then
  echo "Expected the failed health verification to fail the deployment." >&2
  exit 1
fi
grep -Fq "Website rollback verified: $previous_image" <<<"$failure_output"
test -e "$FAKE_SWARM_STATE/rollback-requested"
test "$(cat "$FAKE_SWARM_STATE/current-image")" = "$previous_image"
test ! -e "$FAKE_SWARM_STATE/caddy-image"
test -z "$(find "$FAKE_SWARM_STATE/configs" -type f -name '*.data' -print -quit)"

reset_state
export FAKE_FAIL_CADDY_HEALTH=true
if caddy_health_failure_output="$(run_deploy 2>&1)"; then
  echo "Expected an unhealthy Caddy task to fail the deployment." >&2
  exit 1
fi
grep -Fq "Timed out waiting for the Caddy deploy operation" <<<"$caddy_health_failure_output"
test ! -e "$FAKE_SWARM_STATE/caddy-image"

reset_state
export FAKE_FAIL_INTERNAL_ROUTES=true
if route_failure_output="$(run_deploy 2>&1)"; then
  echo "Expected failed internal routes to fail and roll back deployment." >&2
  exit 1
fi
grep -Fq "Timed out waiting for the Caddy deploy operation" <<<"$route_failure_output"
grep -Fq "Website rollback verified: $previous_image" <<<"$route_failure_output"
test -e "$FAKE_SWARM_STATE/rollback-requested"
test ! -e "$FAKE_SWARM_STATE/caddy-image"

reset_state
seed_previous_caddy
export FAKE_FAIL_CADDY_HEALTH=true
if existing_caddy_failure_output="$(run_deploy 2>&1)"; then
  echo "Expected a failed update to restore the full previous Caddy spec." >&2
  exit 1
fi
grep -Fq "Caddy rollback verified" <<<"$existing_caddy_failure_output"
test -e "$FAKE_SWARM_STATE/caddy-rollback-requested"
cmp -s "$FAKE_SWARM_STATE/caddy-spec" "$FAKE_SWARM_STATE/previous-caddy-spec"

reset_state
rm -f -- "$FAKE_SWARM_STATE/current-image"
rm -f -- "$FAKE_SWARM_STATE/stack-exists"
export FAKE_FAIL_CANDIDATE=true
if initial_failure_output="$(run_deploy 2>&1)"; then
  echo "Expected the failed initial deployment to fail." >&2
  exit 1
fi
grep -Fq "Initial deployment cleanup verified." <<<"$initial_failure_output"
test -e "$FAKE_SWARM_STATE/stack-remove-requested"
test ! -e "$FAKE_SWARM_STATE/current-image"
test ! -e "$FAKE_SWARM_STATE/caddy-image"
test ! -e "$FAKE_SWARM_STATE/stack-exists"

reset_state
export FAKE_SERVICE_LIST_ERROR=true
if run_deploy >/dev/null 2>&1; then
  echo "Expected a Swarm service-list API failure to stop deployment." >&2
  exit 1
fi
test "$(cat "$FAKE_SWARM_STATE/current-image")" = "$previous_image"
test ! -e "$FAKE_SWARM_STATE/rollback-requested"
test ! -e "$FAKE_SWARM_STATE/stack-remove-requested"

echo "deploy-swarm tests passed"
