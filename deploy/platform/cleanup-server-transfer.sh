#!/usr/bin/env bash

set -Eeuo pipefail

readonly expected_sha="${PLATFORM_DATA_SHA256:-}"
readonly transfer_volume="${PLATFORM_TRANSFER_VOLUME_NAME:-starsnap-platform-transfer-20260827}"
readonly transient_services=(
  starsnap-platform-transfer-download
  starsnap-platform-transfer-decrypt
  starsnap-platform-manifest-verify
  starsnap-platform-hub-restore
  starsnap-platform-erp-restore
)

test "${ALLOW_TRANSFER_CLEANUP:-}" = "PURGE-RESTORED-TRANSFER-COPY"
if [[ ! "$expected_sha" =~ ^[0-9a-f]{64}$ ]]; then
  echo "PLATFORM_DATA_SHA256 must identify the restored snapshot." >&2
  exit 1
fi
: "${PLATFORM_TRANSFER_TOKEN_SECRET_NAME:?PLATFORM_TRANSFER_TOKEN_SECRET_NAME is required}"
: "${PLATFORM_TRANSFER_PASSPHRASE_SECRET_NAME:?PLATFORM_TRANSFER_PASSPHRASE_SECRET_NAME is required}"

marker_name="starsnap-platform-data-${expected_sha:0:16}"
test "$(docker config inspect \
  --format '{{index .Spec.Labels "com.starsnap.snapshot-sha256"}}' \
  "$marker_name")" = "$expected_sha"

for service_name in "${transient_services[@]}"; do
  if docker service inspect "$service_name" >/dev/null 2>&1; then
    echo "Transient restore service still exists: $service_name" >&2
    exit 1
  fi
done

if docker volume inspect "$transfer_volume" >/dev/null 2>&1; then
  test "$(docker volume inspect \
    --format '{{index .Labels "starsnap.migration"}}' \
    "$transfer_volume")" = "server-20260827"
  attached_containers="$(docker ps --all --quiet --filter "volume=$transfer_volume")"
  test "$(awk 'NF {count++} END {print count + 0}' <<<"$attached_containers")" -eq 0
  docker volume rm "$transfer_volume" >/dev/null
fi

for secret_name in \
  "$PLATFORM_TRANSFER_TOKEN_SECRET_NAME" \
  "$PLATFORM_TRANSFER_PASSPHRASE_SECRET_NAME"; do
  if docker secret inspect "$secret_name" >/dev/null 2>&1; then
    docker secret rm "$secret_name" >/dev/null
  fi
done

echo "Removed the server-side plaintext transfer volume and transient transfer secrets; restored databases were preserved."
