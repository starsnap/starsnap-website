#!/usr/bin/env bash

set -Eeuo pipefail
set +x

readonly app_network="starsnap-main_app-net"
readonly transfer_volume="${PLATFORM_TRANSFER_VOLUME_NAME:-starsnap-platform-transfer-20260827}"
readonly source_url="${PLATFORM_TRANSFER_URL:-http://192.168.1.2:48081/starsnap-platform.enc}"
readonly expected_sha="${PLATFORM_DATA_SHA256:-}"
readonly curl_image="docker.io/curlimages/curl:8.16.0@sha256:463eaf6072688fe96ac64fa623fe73e1dbe25d8ad6c34404a669ad3ce1f104b6"
readonly openssl_image="docker.io/alpine/openssl:3.5.4@sha256:42c7389ef077aed0eb4e96d0abbd094083d701bbaff1313073b061c0c9cd8278"
readonly python_image="docker.io/library/python:3.13-alpine@sha256:540c7d91f98ff6880174c40e99067bf5941eb54d818a7a5e094d188b196a934d"
readonly hub_postgres_image="docker.io/library/postgres:16@sha256:c1b3783309b6499c795eed7c20135a1a4d25cae1b575c3d52c6f536129a1b109"
readonly erp_postgres_image="docker.io/pgvector/pgvector:0.8.6-pg17-bookworm@sha256:cf134a767f474095eeba57e0117be8e568e011a63f33fbf252f14c9b760f8e6f"
readonly manager_constraint="node.labels.starsnap.actions-runner==true"
readonly download_service="starsnap-platform-transfer-download"
readonly decrypt_service="starsnap-platform-transfer-decrypt"
readonly manifest_verify_service="starsnap-platform-manifest-verify"
readonly hub_restore_service="starsnap-platform-hub-restore"
readonly erp_restore_service="starsnap-platform-erp-restore"

: "${PLATFORM_TRANSFER_TOKEN_SECRET_NAME:?PLATFORM_TRANSFER_TOKEN_SECRET_NAME is required}"
: "${PLATFORM_TRANSFER_PASSPHRASE_SECRET_NAME:?PLATFORM_TRANSFER_PASSPHRASE_SECRET_NAME is required}"
: "${HUB_DB_PASSWORD_SECRET_NAME:?HUB_DB_PASSWORD_SECRET_NAME is required}"
: "${ERP_DB_PASSWORD_SECRET_NAME:?ERP_DB_PASSWORD_SECRET_NAME is required}"

if [[ ! "$expected_sha" =~ ^[0-9a-f]{64}$ ]]; then
  echo "PLATFORM_DATA_SHA256 must be the encrypted archive sha256." >&2
  exit 1
fi
if [[ "$source_url" != http://192.168.1.2:48081/* ]]; then
  echo "The migration source must be the temporary desktop-only relay." >&2
  exit 1
fi

for secret_name in \
  "$PLATFORM_TRANSFER_TOKEN_SECRET_NAME" \
  "$PLATFORM_TRANSFER_PASSPHRASE_SECRET_NAME" \
  "$HUB_DB_PASSWORD_SECRET_NAME" \
  "$ERP_DB_PASSWORD_SECRET_NAME"; do
  docker secret inspect "$secret_name" >/dev/null
done

for service_name in starsnap-hub_postgres starsnap-erp_postgres; do
  test "$(docker service ls --filter "name=$service_name" --format '{{.Name}} {{.Replicas}}' | awk -v target="$service_name" '$1 == target {print $2}')" = "1/1"
done

remove_service_if_present() {
  local service_name="$1"
  local deadline=$((SECONDS + 90))
  if ! docker service inspect "$service_name" >/dev/null 2>&1; then
    return 0
  fi
  docker service rm "$service_name" >/dev/null
  while (( SECONDS < deadline )); do
    if ! docker service inspect "$service_name" >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done
  echo "Timed out removing transient service: $service_name" >&2
  return 1
}

wait_for_completion() {
  local service_name="$1"
  local deadline=$((SECONDS + 1800))
  local task_row _desired state error
  while (( SECONDS < deadline )); do
    task_row="$(docker service ps --no-trunc --format '{{.DesiredState}}|{{.CurrentState}}|{{.Error}}' "$service_name" | head -n 1)"
    IFS='|' read -r _desired state error <<<"$task_row"
    case "$state" in
      Complete*) return 0 ;;
      Failed*|Rejected*|Shutdown*)
        echo "$service_name failed: ${error:-$state}" >&2
        docker service logs --raw --tail 100 "$service_name" >&2 || true
        return 1
        ;;
    esac
    sleep 3
  done
  echo "Timed out waiting for transient service: $service_name" >&2
  docker service ps --no-trunc "$service_name" >&2 || true
  docker service logs --raw --tail 100 "$service_name" >&2 || true
  return 1
}

run_completed_service() {
  local service_name="$1"
  shift
  remove_service_if_present "$service_name"
  docker service create \
    --detach \
    --name "$service_name" \
    --constraint "$manager_constraint" \
    --restart-condition none \
    "$@" >/dev/null
  wait_for_completion "$service_name"
}

docker volume create \
  --label starsnap.migration=server-20260827 \
  "$transfer_volume" >/dev/null

# The single-quoted program is intentionally expanded inside the service task.
# shellcheck disable=SC2016
run_completed_service "$download_service" \
  --network "$app_network" \
  --user 0:0 \
  --mount "type=volume,source=$transfer_volume,target=/transfer" \
  --secret "source=$PLATFORM_TRANSFER_TOKEN_SECRET_NAME,target=transfer-token,mode=0400" \
  --env "SOURCE_URL=$source_url" \
  --env "EXPECTED_SHA256=$expected_sha" \
  --entrypoint /bin/sh \
  "$curl_image" \
  -ec '
    token="$(cat /run/secrets/transfer-token)"
    curl --fail --silent --show-error --location \
      --retry 5 --retry-delay 2 --connect-timeout 10 --max-time 1800 \
      --header "Authorization: Bearer $token" \
      --output /transfer/starsnap-platform.enc.part \
      "$SOURCE_URL"
    actual="$(sha256sum /transfer/starsnap-platform.enc.part | awk "{print \$1}")"
    test "$actual" = "$EXPECTED_SHA256"
    mv /transfer/starsnap-platform.enc.part /transfer/starsnap-platform.enc
  '

run_completed_service "$decrypt_service" \
  --mount "type=volume,source=$transfer_volume,target=/transfer" \
  --secret "source=$PLATFORM_TRANSFER_PASSPHRASE_SECRET_NAME,target=transfer-passphrase,mode=0400" \
  --entrypoint /bin/sh \
  "$openssl_image" \
  -ec '
    rm -f /transfer/starsnap-platform.tar.part
    openssl enc -d -aes-256-cbc -pbkdf2 -iter 250000 \
      -pass file:/run/secrets/transfer-passphrase \
      -in /transfer/starsnap-platform.enc \
      -out /transfer/starsnap-platform.tar.part
    tar -tf /transfer/starsnap-platform.tar.part >/dev/null
    mv /transfer/starsnap-platform.tar.part /transfer/starsnap-platform.tar
    tar -xf /transfer/starsnap-platform.tar -C /transfer
    test -s /transfer/starsnap-hub.dump
    test -s /transfer/starsnap-erp.dump
    test -s /transfer/manifest.json
  '

run_completed_service "$manifest_verify_service" \
  --mount "type=volume,source=$transfer_volume,target=/transfer" \
  --entrypoint python \
  "$python_image" \
  -c '
import hashlib
import json
from pathlib import Path

root = Path("/transfer")
manifest = json.loads((root / "manifest.json").read_text(encoding="utf-8"))
if manifest.get("schemaVersion") != 1:
    raise SystemExit("unsupported snapshot manifest schema")

databases = manifest.get("databases", {})
expected = {
    "hub": ("starsnap-hub.dump", ("accessLogs",)),
    "erp": ("starsnap-erp.dump", ("products", "tenants", "schemaMigrations")),
}
for database, (expected_name, count_names) in expected.items():
    details = databases.get(database, {})
    if details.get("file") != expected_name:
        raise SystemExit(f"unexpected {database} dump name")
    dump_path = root / expected_name
    if dump_path.stat().st_size != int(details.get("bytes", -1)):
        raise SystemExit(f"{database} dump size mismatch")
    with dump_path.open("rb") as dump_file:
        actual_sha = hashlib.file_digest(dump_file, "sha256").hexdigest()
    if actual_sha != details.get("sha256"):
        raise SystemExit(f"{database} dump sha256 mismatch")
    for count_name in count_names:
        count = int(details.get(count_name, -1))
        if count <= 0:
            raise SystemExit(f"invalid {database} {count_name} count")
        (root / f"expected-{database}-{count_name}").write_text(str(count), encoding="ascii")

print("Snapshot manifest and database dump hashes verified.")
  '

# The single-quoted program is intentionally expanded inside the service task.
# shellcheck disable=SC2016
run_completed_service "$hub_restore_service" \
  --network starsnap-hub_database \
  --mount "type=volume,source=$transfer_volume,target=/transfer,readonly" \
  --secret "source=$HUB_DB_PASSWORD_SECRET_NAME,target=hub-db-password,mode=0400" \
  --entrypoint /bin/sh \
  "$hub_postgres_image" \
  -ec '
    export PGPASSWORD="$(cat /run/secrets/hub-db-password)"
    until pg_isready -h starsnap-hub_postgres -U starsnap -d starsnap_hub; do sleep 2; done
    pg_restore --clean --if-exists --exit-on-error --no-owner --no-privileges \
      -h starsnap-hub_postgres -U starsnap -d starsnap_hub \
      /transfer/starsnap-hub.dump
    count="$(psql -h starsnap-hub_postgres -U starsnap -d starsnap_hub -Atc "SELECT count(*) FROM public.access_logs")"
    expected_count="$(cat /transfer/expected-hub-accessLogs)"
    test "$count" = "$expected_count"
    printf "restored_hub_access_logs=%s\n" "$count"
  '

# The single-quoted program is intentionally expanded inside the service task.
# shellcheck disable=SC2016
run_completed_service "$erp_restore_service" \
  --network starsnap-erp_database \
  --mount "type=volume,source=$transfer_volume,target=/transfer,readonly" \
  --secret "source=$ERP_DB_PASSWORD_SECRET_NAME,target=erp-db-password,mode=0400" \
  --entrypoint /bin/sh \
  "$erp_postgres_image" \
  -ec '
    export PGPASSWORD="$(cat /run/secrets/erp-db-password)"
    until pg_isready -h starsnap-erp_postgres -U mealops -d mealops; do sleep 2; done
    pg_restore --clean --if-exists --exit-on-error --no-owner --no-privileges \
      -h starsnap-erp_postgres -U mealops -d mealops \
      /transfer/starsnap-erp.dump
    product_count="$(psql -h starsnap-erp_postgres -U mealops -d mealops -Atc "SELECT count(*) FROM public.products")"
    tenant_count="$(psql -h starsnap-erp_postgres -U mealops -d mealops -Atc "SELECT count(*) FROM public.tenants")"
    migration_count="$(psql -h starsnap-erp_postgres -U mealops -d mealops -Atc "SELECT count(*) FROM public.schema_migrations")"
    test "$product_count" = "$(cat /transfer/expected-erp-products)"
    test "$tenant_count" = "$(cat /transfer/expected-erp-tenants)"
    test "$migration_count" = "$(cat /transfer/expected-erp-schemaMigrations)"
    printf "restored_erp_products=%s tenants=%s migrations=%s\n" \
      "$product_count" "$tenant_count" "$migration_count"
  '

marker_name="starsnap-platform-data-${expected_sha:0:16}"
if docker config inspect "$marker_name" >/dev/null 2>&1; then
  test "$(docker config inspect --format '{{index .Spec.Labels "com.starsnap.snapshot-sha256"}}' "$marker_name")" = "$expected_sha"
else
  printf 'encrypted_snapshot_sha256=%s\n' "$expected_sha" | docker config create \
    --label "com.starsnap.snapshot-sha256=$expected_sha" \
    "$marker_name" - >/dev/null
fi

for service_name in \
  "$download_service" \
  "$decrypt_service" \
  "$manifest_verify_service" \
  "$hub_restore_service" \
  "$erp_restore_service"; do
  remove_service_if_present "$service_name"
done

echo "Encrypted desktop snapshot restored and marked: $marker_name"
