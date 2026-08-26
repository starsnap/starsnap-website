#!/usr/bin/env bash

set -Eeuo pipefail
set +x

readonly api_service="starsnap-main_api"
readonly openssl_image="docker.io/alpine/openssl:3.5.4@sha256:42c7389ef077aed0eb4e96d0abbd094083d701bbaff1313073b061c0c9cd8278"

secret_exists() {
  docker secret inspect "$1" >/dev/null 2>&1
}

secret_name_from() {
  local name_variable="$1"
  local secret_name="${!name_variable:-}"
  if [[ ! "$secret_name" =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,254}$ ]]; then
    echo "Invalid or missing Docker secret name: $name_variable" >&2
    return 1
  fi
  printf '%s' "$secret_name"
}

create_secret_value() {
  local secret_name="$1"
  local secret_value="$2"
  local source_label="$3"
  if [[ -z "$secret_value" ]]; then
    echo "Missing secret material from $source_label" >&2
    return 1
  fi
  printf '%s' "$secret_value" | docker secret create "$secret_name" - >/dev/null
  docker secret inspect "$secret_name" >/dev/null
  echo "Created Docker secret from $source_label: $secret_name"
}

service_env_value() {
  local service_name="$1"
  local env_name="$2"
  local env_rows matches
  docker service inspect "$service_name" >/dev/null 2>&1 || return 1
  env_rows="$(docker service inspect \
    --format '{{range .Spec.TaskTemplate.ContainerSpec.Env}}{{println .}}{{end}}' \
    "$service_name")"
  matches="$(awk -v prefix="$env_name=" \
    'index($0, prefix) == 1 {print substr($0, length(prefix) + 1); count++} END {if (count != 1) exit 2}' \
    <<<"$env_rows")" || return 1
  [[ -n "$matches" ]] || return 1
  printf '%s' "$matches"
}

ensure_service_or_provided_secret() {
  local name_variable="$1"
  local value_variable="$2"
  shift 2
  local secret_name secret_value source_label="GitHub production environment"
  secret_name="$(secret_name_from "$name_variable")"
  if secret_exists "$secret_name"; then
    echo "Reusing existing Docker secret: $secret_name"
    return 0
  fi
  secret_value="${!value_variable:-}"
  if [[ -z "$secret_value" ]]; then
    source_label="existing Swarm service specification"
    while (( $# >= 2 )); do
      if secret_value="$(service_env_value "$1" "$2")"; then
        break
      fi
      shift 2
    done
  fi
  if [[ -z "$secret_value" ]]; then
    echo "Could not derive or receive secret material for $secret_name." >&2
    return 1
  fi
  create_secret_value "$secret_name" "$secret_value" "$source_label"
  printf -v "$value_variable" ''
}

ensure_random_secret() {
  local name_variable="$1"
  local byte_count="$2"
  local secret_name secret_value
  secret_name="$(secret_name_from "$name_variable")"
  if secret_exists "$secret_name"; then
    echo "Reusing existing Docker secret: $secret_name"
    return 0
  fi
  secret_value="$(docker run --rm "$openssl_image" rand -hex "$byte_count")"
  if [[ ! "$secret_value" =~ ^[0-9a-f]+$ ]] || [[ "${#secret_value}" -ne $((byte_count * 2)) ]]; then
    echo "Secure random generation failed for $secret_name." >&2
    return 1
  fi
  create_secret_value "$secret_name" "$secret_value" "server-side random generation"
}

ensure_provided_secret() {
  local name_variable="$1"
  local value_variable="$2"
  local secret_name secret_value
  secret_name="$(secret_name_from "$name_variable")"
  if secret_exists "$secret_name"; then
    echo "Reusing existing Docker secret: $secret_name"
    return 0
  fi
  secret_value="${!value_variable:-}"
  create_secret_value "$secret_name" "$secret_value" "GitHub production environment"
  printf -v "$value_variable" ''
}

ensure_service_or_provided_secret \
  MAIN_DB_PASSWORD_SECRET_NAME MAIN_DB_PASSWORD_VALUE \
  "$api_service" SPRING_DATASOURCE_PASSWORD \
  starsnap-main_starsnap-postgres POSTGRES_PASSWORD
ensure_random_secret ERP_DB_PASSWORD_SECRET_NAME 32
ensure_random_secret ADMIN_JWT_SECRET_NAME 48
ensure_service_or_provided_secret AWS_ACCESS_KEY_ID_SECRET_NAME AWS_ACCESS_KEY_ID_VALUE "$api_service" AWS_ACCESS_KEY_ID
ensure_service_or_provided_secret AWS_SECRET_ACCESS_KEY_SECRET_NAME AWS_SECRET_ACCESS_KEY_VALUE "$api_service" AWS_SECRET_ACCESS_KEY
ensure_service_or_provided_secret HUB_INGEST_SECRET_NAME HUB_INGEST_VALUE "$api_service" HUB_SERVER_LOG_SECRET
ensure_random_secret HUB_DB_PASSWORD_SECRET_NAME 32
ensure_provided_secret CLOUDFLARE_ACCESS_TEAM_DOMAIN_SECRET_NAME CLOUDFLARE_ACCESS_TEAM_DOMAIN_VALUE
ensure_provided_secret CLOUDFLARE_ACCESS_AUDIENCE_SECRET_NAME CLOUDFLARE_ACCESS_AUDIENCE_VALUE
ensure_random_secret ERP_AUTH_CODE_SECRET_NAME 48
ensure_random_secret ERP_SMTP_MAILER_TOKEN_SECRET_NAME 32
ensure_provided_secret ERP_SMTP_USERNAME_SECRET_NAME ERP_SMTP_USERNAME_VALUE
ensure_provided_secret ERP_SMTP_PASSWORD_SECRET_NAME ERP_SMTP_PASSWORD_VALUE
ensure_random_secret ERP_EMBEDDING_WORKER_TOKEN_SECRET_NAME 32

if [[ -n "${PLATFORM_TRANSFER_TOKEN_VALUE:-}" ]]; then
  ensure_provided_secret PLATFORM_TRANSFER_TOKEN_SECRET_NAME PLATFORM_TRANSFER_TOKEN_VALUE
fi
if [[ -n "${PLATFORM_TRANSFER_PASSPHRASE_VALUE:-}" ]]; then
  ensure_provided_secret PLATFORM_TRANSFER_PASSPHRASE_SECRET_NAME PLATFORM_TRANSFER_PASSPHRASE_VALUE
fi

echo "Required platform secrets are present."
