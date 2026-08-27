#!/usr/bin/env bash

set -Eeuo pipefail

readonly apex_http_url="http://starsnap.kr"
readonly apex_https_url="https://starsnap.kr"
readonly www_http_url="http://www.starsnap.kr"
readonly www_https_url="https://www.starsnap.kr"
readonly api_http_url="http://api.starsnap.kr"
readonly api_https_url="https://api.starsnap.kr"
readonly erp_http_url="http://erp.starsnap.kr"
readonly erp_https_url="https://erp.starsnap.kr"
readonly sns_http_url="http://sns.starsnap.kr"
readonly sns_https_url="https://sns.starsnap.kr"
readonly chat_http_url="http://chat.starsnap.kr"
readonly chat_https_url="https://chat.starsnap.kr"
readonly admin_http_url="http://admin.starsnap.kr"
readonly admin_https_url="https://admin.starsnap.kr"
readonly log_http_url="http://log.starsnap.kr"
readonly log_https_url="https://log.starsnap.kr"
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
readonly erp_index_file="$temp_dir/erp-index.html"
readonly sns_index_file="$temp_dir/sns-index.html"
readonly sns_health_file="$temp_dir/sns-health.json"
readonly chat_index_file="$temp_dir/chat-index.html"
readonly chat_health_file="$temp_dir/chat-health.json"
readonly admin_index_file="$temp_dir/admin-index.html"
readonly admin_health_file="$temp_dir/admin-health.json"

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

verify_status() {
  local request_url="$1"
  local expected_status="$2"
  local status=""

  if ! curl "${curl_common[@]}" \
    --dump-header "$headers_file" \
    --output /dev/null \
    "$request_url"; then
    echo "Status request failed: $request_url" >&2
    return 1
  fi

  status="$(awk 'toupper($1) ~ /^HTTP\// { value=$2 } END { print value }' "$headers_file")"
  if [[ "$status" != "$expected_status" ]]; then
    echo "Unexpected status for $request_url: status=$status" >&2
    return 1
  fi
}

verify_ok_json() {
  local request_url="$1"
  local output_file="$2"
  local label="$3"
  local status=""

  if ! curl "${curl_common[@]}" \
    --dump-header "$headers_file" \
    --output "$output_file" \
    "$request_url"; then
    echo "$label request failed." >&2
    return 1
  fi

  status="$(awk 'toupper($1) ~ /^HTTP\// { value=$2 } END { print value }' "$headers_file")"
  if [[ "$status" != "200" ]]; then
    echo "$label returned HTTP $status." >&2
    return 1
  fi
  if ! node -e '
    const fs = require("fs");
    try {
      const payload = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      if (!payload || payload.status !== "ok") process.exit(1);
    } catch {
      process.exit(1);
    }
  ' "$output_file"; then
    echo "$label response was not ok." >&2
    return 1
  fi
}

verify_cloudflare_access_gate() {
  local request_url="$1"
  local auth_header=""
  local location=""
  local status=""

  if ! curl "${curl_common[@]}" \
    --dump-header "$headers_file" \
    --output /dev/null \
    "$request_url"; then
    echo "Cloudflare Access gate request failed: $request_url" >&2
    return 1
  fi

  status="$(awk 'toupper($1) ~ /^HTTP\// { value=$2 } END { print value }' "$headers_file")"
  location="$(awk 'tolower($1) == "location:" { $1=""; sub(/^[[:space:]]+/, ""); sub(/\r$/, ""); value=$0 } END { print value }' "$headers_file")"
  auth_header="$(awk 'tolower($1) == "www-authenticate:" { $1=""; sub(/^[[:space:]]+/, ""); sub(/\r$/, ""); value=$0 } END { print value }' "$headers_file")"

  if [[ "$status" != "302" \
    || ! "$location" =~ ^https://[a-zA-Z0-9.-]+\.cloudflareaccess\.com/cdn-cgi/access/login/log\.starsnap\.kr\? \
    || "$auth_header" != Cloudflare-Access* ]]; then
    echo "Unexpected Log Hub Access gate: status=$status location=$location auth=${auth_header%% *}" >&2
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
  verify_redirect \
    "${erp_http_url}/api/health" \
    "308" \
    "${erp_https_url}/api/health" || return 1
  verify_redirect \
    "${sns_http_url}/api/health" \
    "308" \
    "${sns_https_url}/api/health" || return 1
  verify_redirect \
    "${chat_http_url}/api/health" \
    "308" \
    "${chat_https_url}/api/health" || return 1
  verify_redirect \
    "${admin_http_url}/api/health" \
    "308" \
    "${admin_https_url}/api/health" || return 1

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

  if ! curl "${curl_common[@]}" --fail --output "$erp_index_file" "${erp_https_url}/"; then
    echo "Public ERP root request failed." >&2
    return 1
  fi
  if ! grep -Fq "StarSnap ERP" "$erp_index_file"; then
    echo "Public ERP root response did not contain the StarSnap ERP marker." >&2
    return 1
  fi

  if ! verify_status "${erp_https_url}/api/health" "404"; then
    echo "Public ERP detailed health endpoint was not hidden." >&2
    return 1
  fi
  if ! verify_status "${erp_https_url}/api/health/" "404"; then
    echo "Public ERP trailing-slash health endpoint was not hidden." >&2
    return 1
  fi

  if ! curl "${curl_common[@]}" --fail --output "$sns_index_file" "${sns_https_url}/"; then
    echo "Public SNS root request failed." >&2
    return 1
  fi
  if ! grep -Fq "<title>StarSnap</title>" "$sns_index_file"; then
    echo "Public SNS root response did not contain the StarSnap marker." >&2
    return 1
  fi

  if ! curl "${curl_common[@]}" --fail --output "$sns_health_file" "${sns_https_url}/api/health"; then
    echo "Public SNS API health request failed." >&2
    return 1
  fi
  if ! grep -Eq '"status"[[:space:]]*:[[:space:]]*"ok"' "$sns_health_file"; then
    echo "Public SNS API health response was not ok." >&2
    return 1
  fi

  if ! curl "${curl_common[@]}" \
    --fail \
    --dump-header "$headers_file" \
    --output "$chat_index_file" \
    "${chat_https_url}/"; then
    echo "Public Chat root request failed." >&2
    return 1
  fi
  if ! grep -Fq 'name="starsnap-app-surfaces" content="social chat"' "$chat_index_file"; then
    echo "Public Chat root response did not contain the Chat surface capability marker." >&2
    return 1
  fi
  local chat_surface=""
  chat_surface="$(awk 'tolower($1) == "x-starsnap-app-surface:" { $1=""; sub(/^[[:space:]]+/, ""); sub(/\r$/, ""); value=$0 } END { print value }' "$headers_file")"
  if [[ "$chat_surface" != "chat" ]]; then
    echo "Public Chat root response did not identify the Chat surface." >&2
    return 1
  fi

  verify_ok_json \
    "${chat_https_url}/api/health" \
    "$chat_health_file" \
    "Public Chat API health" || return 1

  if ! curl "${curl_common[@]}" --fail --output "$admin_index_file" "${admin_https_url}/"; then
    echo "Public Admin root request failed." >&2
    return 1
  fi
  if ! grep -Fq "StarSnap Admin" "$admin_index_file"; then
    echo "Public Admin root response did not contain the StarSnap Admin marker." >&2
    return 1
  fi

  verify_ok_json \
    "${admin_https_url}/api/health" \
    "$admin_health_file" \
    "Public Admin API health" || return 1

  verify_redirect \
    "${log_http_url}/" \
    "301" \
    "${log_https_url}/" || return 1
  verify_cloudflare_access_gate "${log_https_url}/" || return 1
}

attempt=1
while (( attempt <= attempts )); do
  echo "External verification attempt $attempt/$attempts"
  if verify_once; then
    echo "External verification passed for starsnap.kr, www.starsnap.kr, api.starsnap.kr, erp.starsnap.kr, sns.starsnap.kr, chat.starsnap.kr, admin.starsnap.kr, and log.starsnap.kr."
    exit 0
  fi

  if (( attempt < attempts )); then
    sleep "$delay_seconds"
  fi
  attempt=$((attempt + 1))
done

echo "External verification failed after $attempts attempts." >&2
exit 1
