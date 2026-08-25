#!/usr/bin/env bash

set -Eeuo pipefail

readonly apex_http_url="http://starsnap.kr"
readonly apex_https_url="https://starsnap.kr"
readonly www_http_url="http://www.starsnap.kr"
readonly www_https_url="https://www.starsnap.kr"
readonly api_http_url="http://api.starsnap.kr"
readonly api_https_url="https://api.starsnap.kr"
readonly redirect_uri='/__starsnap_external_verify__/path?source=github&value=1'
readonly attempts="${STARSNAP_EXTERNAL_VERIFY_ATTEMPTS:-36}"
readonly delay_seconds="${STARSNAP_EXTERNAL_VERIFY_DELAY_SECONDS:-10}"
readonly connect_timeout_seconds="${STARSNAP_EXTERNAL_CONNECT_TIMEOUT_SECONDS:-5}"
readonly request_timeout_seconds="${STARSNAP_EXTERNAL_REQUEST_TIMEOUT_SECONDS:-20}"

if [[ ! "$attempts" =~ ^[1-9][0-9]*$ \
  || ! "$delay_seconds" =~ ^[0-9]+$ \
  || ! "$connect_timeout_seconds" =~ ^[1-9][0-9]*$ \
  || ! "$request_timeout_seconds" =~ ^[1-9][0-9]*$ ]]; then
  echo "Attempts and timeouts must be positive integers; retry delay may be zero." >&2
  exit 1
fi

temp_dir="$(mktemp -d)"
readonly headers_file="$temp_dir/headers.txt"
readonly index_file="$temp_dir/index.html"
readonly icon_file="$temp_dir/icon.png"
readonly api_file="$temp_dir/api-health.json"

# Invoked indirectly by the EXIT trap.
# shellcheck disable=SC2329
cleanup() {
  if [[ "$temp_dir" == /tmp/* || "$temp_dir" == /var/folders/* ]]; then
    find "$temp_dir" -depth -delete
  fi
}
trap cleanup EXIT

curl_common=(
  --silent
  --show-error
  --connect-timeout "$connect_timeout_seconds"
  --max-time "$request_timeout_seconds"
  --proto '=http,https'
)

verify_redirect() {
  local request_url="$1"
  local expected_status="$2"
  local expected_location="$3"
  local location=""
  local status=""

  if ! curl "${curl_common[@]}" \
    --dump-header "$headers_file" \
    --output /dev/null \
    "$request_url"; then
    echo "Redirect request failed: $request_url" >&2
    return 1
  fi

  status="$(awk 'toupper($1) ~ /^HTTP\// { value=$2 } END { print value }' "$headers_file")"
  location="$(awk 'tolower($1) == "location:" { $1=""; sub(/^[[:space:]]+/, ""); sub(/\r$/, ""); value=$0 } END { print value }' "$headers_file")"

  if [[ "$status" != "$expected_status" || "$location" != "$expected_location" ]]; then
    echo "Unexpected redirect for $request_url: status=$status location=$location" >&2
    return 1
  fi
}

verify_once() {
  verify_redirect \
    "${apex_http_url}${redirect_uri}" \
    "308" \
    "${apex_https_url}${redirect_uri}" || return 1
  verify_redirect \
    "${api_http_url}/api/health" \
    "308" \
    "${api_https_url}/api/health" || return 1
  verify_redirect \
    "${www_http_url}${redirect_uri}" \
    "301" \
    "${apex_https_url}${redirect_uri}" || return 1
  verify_redirect \
    "${www_https_url}${redirect_uri}" \
    "301" \
    "${apex_https_url}${redirect_uri}" || return 1

  # Curl's normal CA and hostname validation is intentionally retained here.
  # Do not add --insecure or --resolve; this job must exercise public DNS/TLS.
  if ! curl "${curl_common[@]}" --fail --output "$index_file" "${apex_https_url}/"; then
    echo "Apex HTTPS request failed." >&2
    return 1
  fi
  if ! grep -Fq "StarSnap" "$index_file"; then
    echo "Apex HTTPS response did not contain the StarSnap marker." >&2
    return 1
  fi

  if ! curl "${curl_common[@]}" --fail --output "$icon_file" "${apex_https_url}/icon.png"; then
    echo "Apex icon request failed." >&2
    return 1
  fi
  if [[ ! -s "$icon_file" ]]; then
    echo "Apex icon response was empty." >&2
    return 1
  fi

  if ! curl "${curl_common[@]}" --fail --output "$api_file" "${api_https_url}/api/health"; then
    echo "Public API health request failed." >&2
    return 1
  fi
  if ! grep -Eq '"status"[[:space:]]*:[[:space:]]*"ok"' "$api_file"; then
    echo "Public API health response was not ok." >&2
    return 1
  fi
}

attempt=1
while (( attempt <= attempts )); do
  echo "External verification attempt $attempt/$attempts"
  if verify_once; then
    echo "External verification passed for starsnap.kr, www.starsnap.kr, and api.starsnap.kr."
    exit 0
  fi

  if (( attempt < attempts )); then
    sleep "$delay_seconds"
  fi
  attempt=$((attempt + 1))
done

echo "External verification failed after $attempts attempts." >&2
exit 1
