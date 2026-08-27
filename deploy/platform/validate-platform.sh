#!/usr/bin/env bash

set -Eeuo pipefail

readonly digest_pattern='^[a-z0-9]+([._/-][a-z0-9]+)*(:[A-Za-z0-9_][A-Za-z0-9._-]*)?@sha256:[0-9a-f]{64}$'
zero_digest="sha256:$(printf '0%.0s' {1..64})"
readonly zero_digest
readonly stack_files=(
  deploy/platform/starsnap-erp.yml
  deploy/platform/starsnap-hub.yml
  deploy/platform/starsnap-admin.yml
  deploy/platform/starsnap-sns.yml
)
readonly image_variables=(
  SNS_WEB_IMAGE
  ADMIN_WEB_IMAGE
  ADMIN_SERVER_IMAGE
  HUB_WEB_IMAGE
  HUB_SERVER_IMAGE
  ERP_WEB_IMAGE
  ERP_SMTP_MAILER_IMAGE
  ERP_EMBEDDING_WORKER_IMAGE
)
readonly secret_name_variables=(
  MAIN_DB_PASSWORD_SECRET_NAME
  ERP_DB_PASSWORD_SECRET_NAME
  ADMIN_JWT_SECRET_NAME
  AWS_ACCESS_KEY_ID_SECRET_NAME
  AWS_SECRET_ACCESS_KEY_SECRET_NAME
  HUB_INGEST_SECRET_NAME
  HUB_DB_PASSWORD_SECRET_NAME
  CLOUDFLARE_ACCESS_TEAM_DOMAIN_SECRET_NAME
  CLOUDFLARE_ACCESS_AUDIENCE_SECRET_NAME
  ERP_AUTH_CODE_SECRET_NAME
  ERP_SMTP_MAILER_TOKEN_SECRET_NAME
  ERP_SMTP_USERNAME_SECRET_NAME
  ERP_SMTP_PASSWORD_SECRET_NAME
  ERP_EMBEDDING_WORKER_TOKEN_SECRET_NAME
)

if [[ "${1:-}" == "--ci" ]]; then
  export SNS_WEB_IMAGE="ghcr.io/starsnap/starsnap-sns-web@$zero_digest"
  export ADMIN_WEB_IMAGE="ghcr.io/starsnap/starsnap-admin-web@$zero_digest"
  export ADMIN_SERVER_IMAGE="ghcr.io/starsnap/starsnap-admin-server@$zero_digest"
  export HUB_WEB_IMAGE="ghcr.io/starsnap/starsnap-log-web@$zero_digest"
  export HUB_SERVER_IMAGE="ghcr.io/starsnap/starsnap-log-server@$zero_digest"
  export ERP_WEB_IMAGE="ghcr.io/starsnap/starsnap-erp-web@$zero_digest"
  export ERP_SMTP_MAILER_IMAGE="ghcr.io/starsnap/starsnap-erp-smtp-mailer@$zero_digest"
  export ERP_EMBEDDING_WORKER_IMAGE="ghcr.io/starsnap/starsnap-erp-embedding-worker@$zero_digest"
  for variable in "${secret_name_variables[@]}"; do
    printf -v "$variable" 'ci-%s' "${variable,,}"
    export "${variable?}"
  done
fi

for variable in "${image_variables[@]}"; do
  value="${!variable:-}"
  if [[ ! "$value" =~ $digest_pattern ]]; then
    echo "$variable must be an immutable sha256 image reference." >&2
    exit 1
  fi
done

for variable in "${secret_name_variables[@]}"; do
  value="${!variable:-}"
  if [[ ! "$value" =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,254}$ ]]; then
    echo "$variable must name a versioned Docker secret." >&2
    exit 1
  fi
done

for file in "${stack_files[@]}"; do
  docker stack config --compose-file "$file" >/dev/null
done

if command -v node >/dev/null 2>&1; then
  node --check deploy/verify-internal.mjs
  node --check deploy/platform/verify-platform.mjs
else
  echo "Node.js is unavailable on the deployment host; CI owns JavaScript syntax validation."
fi

if grep -Fq '192.168.1.2' \
  deploy/platform/starsnap-sns.yml \
  deploy/platform/starsnap-admin.yml \
  deploy/platform/starsnap-hub.yml \
  deploy/platform/starsnap-erp.yml \
  deploy/platform/verify-platform.mjs; then
  echo "The target deployment must not route application traffic through the desktop." >&2
  exit 1
fi

grep -Fq 'starsnap-main_starsnap-postgres:5432' deploy/platform/starsnap-admin.yml
grep -Fq 'node.labels.starsnap.actions-runner == true' deploy/platform/starsnap-hub.yml
grep -Fq 'node.labels.starsnap.actions-runner == true' deploy/platform/starsnap-erp.yml
grep -Fq 'starsnap-main_api:8080' deploy/platform/build-platform-images.ps1
grep -Fq 'sourceImageId' deploy/platform/build-platform-images.ps1
grep -Fq 'wait_for_completed_service starsnap-erp_ollama-model' deploy/platform/deploy-platform.sh
grep -Fq 'docker service update --with-registry-auth --force "$service"' deploy/platform/deploy-platform.sh
grep -Fq 'Snapshot manifest and database dump hashes verified.' deploy/platform/restore-platform-data.sh

echo "Platform stack configuration passed static validation."
