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
ERP_EMBEDDING_BASE_URL='http://mac-mini.hamtory.com:11434' \
ERP_OLLAMA_REPLICAS=0 \
ERP_OLLAMA_MODEL_REPLICAS=0 \
  docker stack config --compose-file deploy/platform/starsnap-erp.yml >/dev/null

if command -v node >/dev/null 2>&1; then
  node --check deploy/verify-internal.mjs
  node --check deploy/platform/verify-platform.mjs
  node --check deploy/platform/verify-ollama.mjs
  node --check deploy/platform/test-verify-ollama.mjs
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
test "$(grep -Fc 'node.labels.starsnap.actions-runner == true' deploy/platform/starsnap-erp.yml)" -eq 6
test "$(grep -Fc 'node.labels.starsnap.actions-runner == true' deploy/platform/starsnap-hub.yml)" -eq 3
test "$(grep -Fc 'node.labels.starsnap.actions-runner == true' deploy/platform/starsnap-admin.yml)" -eq 2
test "$(grep -Fc 'node.labels.starsnap.actions-runner == true' deploy/platform/starsnap-sns.yml)" -eq 1
test "$(grep -Fc 'node.role == manager' deploy/platform/starsnap-erp.yml)" -eq 6
test "$(grep -Fc 'node.role == manager' deploy/platform/starsnap-hub.yml)" -eq 3
test "$(grep -Fc 'node.role == manager' deploy/platform/starsnap-admin.yml)" -eq 2
test "$(grep -Fc 'node.role == manager' deploy/platform/starsnap-sns.yml)" -eq 1
grep -Fq 'starsnap-main_api:8080' deploy/platform/build-platform-images.ps1
grep -Fq 'sourceImageId' deploy/platform/build-platform-images.ps1
grep -Fq 'wait_for_completed_service starsnap-erp_ollama-model' deploy/platform/deploy-platform.sh
grep -Fq 'const modelName = "bge-m3:567m-fp16";' deploy/platform/verify-ollama.mjs
grep -Fq 'const expectedDigest = "7907646426070047a77226ac3e684fbbe8410524f7b4a74d02837e43f2146bab";' deploy/platform/verify-ollama.mjs
grep -Fq 'const expectedDimension = 1024;' deploy/platform/verify-ollama.mjs
grep -Fq 'const unitNormTolerance = 1e-3;' deploy/platform/verify-ollama.mjs
grep -Fq "ERP_EMBEDDING_BASE_URL: \${ERP_EMBEDDING_BASE_URL:-http://ollama:11434}" deploy/platform/starsnap-erp.yml
grep -Fq "expected_external_url='http://mac-mini.hamtory.com:11434'" deploy/platform/switch-ollama.sh
grep -Fq "manager_address='192.168.1.103'" deploy/platform/switch-ollama.sh
grep -Fq 'SWITCH-OLLAMA-192.168.1.6' deploy/platform/switch-ollama.sh
grep -Fq "verify_endpoint_from_web \"\$external_url\"" deploy/platform/switch-ollama.sh
grep -Fq "verify_live_web_endpoint \"\$external_url\"" deploy/platform/switch-ollama.sh
test "$(grep -Fc 'docker service scale --detach=true' deploy/platform/switch-ollama.sh)" -eq 2
grep -Fq 'com.docker.swarm.service.name=starsnap-erp_web' deploy/platform/deploy-platform.sh
grep -Fq "docker image inspect --format '{{.Os}}'" deploy/platform/deploy-platform.sh
grep -Fq "docker tag \"\$image\" \"\$local_image\"" deploy/platform/deploy-platform.sh
grep -Fq "manager_local_image_registry='starsnap.invalid'" deploy/platform/deploy-platform.sh
grep -Fq "docker service update --detach=true --no-resolve-image --image \"\$local_image\" --force" deploy/platform/deploy-platform.sh
grep -Fq 'verify_private_service_runtime' deploy/platform/deploy-platform.sh
grep -Fq 'Snapshot manifest and database dump hashes verified.' deploy/platform/restore-platform-data.sh

echo "Platform stack configuration passed static validation."
