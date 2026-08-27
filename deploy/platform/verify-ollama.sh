#!/usr/bin/env bash

set -Eeuo pipefail

readonly service_name='starsnap-erp_web'
container_ids="$(docker ps \
  --filter "label=com.docker.swarm.service.name=$service_name" \
  --filter status=running \
  --format '{{.ID}}')"
mapfile -t containers < <(awk 'NF' <<<"$container_ids")

if [[ "${#containers[@]}" -ne 1 ]]; then
  echo "Expected exactly one running $service_name task; found ${#containers[@]}." >&2
  exit 1
fi

docker exec --interactive "${containers[0]}" \
  node --input-type=module <deploy/platform/verify-ollama.mjs
