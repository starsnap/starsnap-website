#!/usr/bin/env bash

set -Eeuo pipefail

test_root="$(mktemp -d)"
export FAKE_SECRET_ROOT="$test_root"

cleanup() {
  if [[ "$test_root" == /tmp/* || "$test_root" == /var/folders/* ]]; then
    find "$test_root" -depth -delete
  fi
}
trap cleanup EXIT

docker() {
  local object="${1:-}" operation="${2:-}" secret_name byte_count
  shift 2 || true
  case "$object:$operation" in
    secret:inspect)
      test -f "$FAKE_SECRET_ROOT/secret-$1"
      ;;
    secret:create)
      secret_name="$1"
      cat >"$FAKE_SECRET_ROOT/secret-$secret_name"
      ;;
    service:inspect)
      case "$*" in
        *ContainerSpec.Env*starsnap-main_api)
          printf '%s\n' \
            'AWS_ACCESS_KEY_ID=derived-aws-id' \
            'AWS_SECRET_ACCESS_KEY=derived-aws-secret' \
            'HUB_SERVER_LOG_SECRET=derived-hub-ingest'
          ;;
        *ContainerSpec.Env*starsnap-main_starsnap-postgres)
          printf '%s\n' 'POSTGRES_PASSWORD_FILE=/run/secrets/main-db'
          ;;
      esac
      ;;
    ps:--filter)
      case "$*" in
        *starsnap-main_api*) printf '%s\n' 'api-container' ;;
        *starsnap-main_starsnap-postgres*) printf '%s\n' 'db-container' ;;
      esac
      ;;
    exec:api-container)
      return 1
      ;;
    exec:db-container)
      printf '%s' 'derived-main-db'
      ;;
    run:--rm)
      byte_count="${*: -1}"
      printf '%*s' "$((byte_count * 2))" '' | tr ' ' a
      printf '\n'
      ;;
    *)
      printf 'Unexpected fake docker call: %s %s %s\n' "$object" "$operation" "$*" >&2
      return 2
      ;;
  esac
}
export -f docker

export MAIN_DB_PASSWORD_SECRET_NAME=test-main-db
export ERP_DB_PASSWORD_SECRET_NAME=test-erp-db
export ADMIN_JWT_SECRET_NAME=test-admin-jwt
export AWS_ACCESS_KEY_ID_SECRET_NAME=test-aws-id
export AWS_SECRET_ACCESS_KEY_SECRET_NAME=test-aws-secret
export HUB_INGEST_SECRET_NAME=test-hub-ingest
export HUB_DB_PASSWORD_SECRET_NAME=test-hub-db
export CLOUDFLARE_ACCESS_TEAM_DOMAIN_SECRET_NAME=test-cf-team
export CLOUDFLARE_ACCESS_AUDIENCE_SECRET_NAME=test-cf-audience
export ERP_AUTH_CODE_SECRET_NAME=test-auth-code
export ERP_SMTP_MAILER_TOKEN_SECRET_NAME=test-mailer-token
export ERP_SMTP_USERNAME_SECRET_NAME=test-smtp-user
export ERP_SMTP_PASSWORD_SECRET_NAME=test-smtp-password
export ERP_EMBEDDING_WORKER_TOKEN_SECRET_NAME=test-embedding-token
export ERP_EAT_API_SECRET_NAME=test-eat-api

export AWS_ACCESS_KEY_ID_VALUE='provided-aws-id'
export AWS_SECRET_ACCESS_KEY_VALUE='provided-aws-secret'
export CLOUDFLARE_ACCESS_TEAM_DOMAIN_VALUE='https://example.cloudflareaccess.com'
export CLOUDFLARE_ACCESS_AUDIENCE_VALUE='provided-cf-audience'
export ERP_SMTP_USERNAME_VALUE='provided-smtp-user'
export ERP_SMTP_PASSWORD_VALUE='provided-smtp-password'
export ERP_EAT_API_VALUE='provided-eat-api-key'

output="$(bash deploy/platform/provision-secrets.sh)"

for secret_value in \
  derived-main-db \
  derived-hub-ingest \
  provided-aws-id \
  provided-aws-secret \
  provided-cf-audience \
  provided-smtp-user \
  provided-smtp-password \
  provided-eat-api-key; do
  if grep -Fq "$secret_value" <<<"$output"; then
    echo 'Provisioning output exposed secret material.' >&2
    exit 1
  fi
done

test "$(cat "$FAKE_SECRET_ROOT/secret-test-main-db")" = 'derived-main-db'
test "$(cat "$FAKE_SECRET_ROOT/secret-test-aws-id")" = 'provided-aws-id'
test "$(cat "$FAKE_SECRET_ROOT/secret-test-hub-ingest")" = 'derived-hub-ingest'
test "$(cat "$FAKE_SECRET_ROOT/secret-test-smtp-password")" = 'provided-smtp-password'
test "$(cat "$FAKE_SECRET_ROOT/secret-test-eat-api")" = 'provided-eat-api-key'
test "$(wc -c <"$FAKE_SECRET_ROOT/secret-test-erp-db")" -eq 64
test "$(wc -c <"$FAKE_SECRET_ROOT/secret-test-admin-jwt")" -eq 96

second_output="$(bash deploy/platform/provision-secrets.sh)"
grep -Fq 'Reusing existing Docker secret: test-main-db' <<<"$second_output"
grep -Fq 'Reusing existing Docker secret: test-embedding-token' <<<"$second_output"
grep -Fq 'Reusing existing Docker secret: test-eat-api' <<<"$second_output"

echo 'provision-secrets tests passed'
