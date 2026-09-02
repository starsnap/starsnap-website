#!/usr/bin/env bash

set -euo pipefail

test_root="$(mktemp -d)"
export FAKE_EXTERNAL_CALL_LOG="$test_root/calls.log"
export FAKE_EXTERNAL_SLEEP_LOG="$test_root/sleeps.log"
export FAKE_EXTERNAL_MODE=success

cleanup() {
  if [[ "$test_root" == /tmp/* || "$test_root" == /var/folders/* ]]; then
    find "$test_root" -depth -delete
  fi
}
trap cleanup EXIT

curl() {
  local dump_header=""
  local output=""
  local request_url=""

  while (( $# > 0 )); do
    case "$1" in
      --dump-header)
        dump_header="$2"
        shift 2
        ;;
      --output)
        output="$2"
        shift 2
        ;;
      --connect-timeout|--max-time|--proto)
        shift 2
        ;;
      --fail|--silent|--show-error)
        shift
        ;;
      --insecure|-k|--resolve)
        echo "External verification must use public DNS and normal CA validation." >&2
        return 2
        ;;
      http://*|https://*)
        request_url="$1"
        shift
        ;;
      *)
        echo "Unexpected fake curl argument: $1" >&2
        return 2
        ;;
    esac
  done

  printf '%s\n' "$request_url" >>"$FAKE_EXTERNAL_CALL_LOG"
  if [[ "$FAKE_EXTERNAL_MODE" == "request_failure" ]]; then
    return 7
  fi
  if [[ "$FAKE_EXTERNAL_MODE" == "tls_failure" && "$request_url" == https://* ]]; then
    return 60
  fi

  case "$request_url" in
    'http://starsnap.kr/__starsnap_external_verify__/path?source=github&value=1')
      if [[ "$FAKE_EXTERNAL_MODE" == "bad_status" ]]; then
        printf 'HTTP/1.1 302 Found\r\nLocation: https://starsnap.kr/__starsnap_external_verify__/path?source=github&value=1\r\n\r\n' >"$dump_header"
      elif [[ "$FAKE_EXTERNAL_MODE" == "bad_location" ]]; then
        printf 'HTTP/1.1 308 Permanent Redirect\r\nLocation: https://wrong.example/__starsnap_external_verify__/path?source=github&value=1\r\n\r\n' >"$dump_header"
      else
        printf 'HTTP/1.1 308 Permanent Redirect\r\nLocation: https://starsnap.kr/__starsnap_external_verify__/path?source=github&value=1\r\n\r\n' >"$dump_header"
      fi
      ;;
    'http://api.starsnap.kr/api/health')
      printf 'HTTP/1.1 308 Permanent Redirect\r\nLocation: https://api.starsnap.kr/api/health\r\n\r\n' >"$dump_header"
      ;;
    'http://erp.starsnap.kr/api/health')
      printf 'HTTP/1.1 308 Permanent Redirect\r\nLocation: https://erp.starsnap.kr/api/health\r\n\r\n' >"$dump_header"
      ;;
    'http://sns.starsnap.kr/api/health')
      printf 'HTTP/1.1 308 Permanent Redirect\r\nLocation: https://sns.starsnap.kr/api/health\r\n\r\n' >"$dump_header"
      ;;
    'http://chat.starsnap.kr/api/health')
      printf 'HTTP/1.1 308 Permanent Redirect\r\nLocation: https://chat.starsnap.kr/api/health\r\n\r\n' >"$dump_header"
      ;;
    'http://bible.starsnap.kr/api/health')
      printf 'HTTP/1.1 308 Permanent Redirect\r\nLocation: https://bible.starsnap.kr/api/health\r\n\r\n' >"$dump_header"
      ;;
    'http://admin.starsnap.kr/api/health')
      printf 'HTTP/1.1 308 Permanent Redirect\r\nLocation: https://admin.starsnap.kr/api/health\r\n\r\n' >"$dump_header"
      ;;
    'http://log.starsnap.kr/')
      printf 'HTTP/1.1 301 Moved Permanently\r\nLocation: https://log.starsnap.kr/\r\n\r\n' >"$dump_header"
      ;;
    'http://www.starsnap.kr/__starsnap_external_verify__/path?source=github&value=1' \
      |'https://www.starsnap.kr/__starsnap_external_verify__/path?source=github&value=1')
      printf 'HTTP/1.1 301 Moved Permanently\r\nLocation: https://starsnap.kr/__starsnap_external_verify__/path?source=github&value=1\r\n\r\n' >"$dump_header"
      ;;
    'https://starsnap.kr/')
      printf '%s' '<html>StarSnap</html>' >"$output"
      ;;
    'https://starsnap.kr/icon.png')
      printf '%s' 'PNG' >"$output"
      ;;
    'https://api.starsnap.kr/api/health')
      printf '%s' '{"status": "ok"}' >"$output"
      ;;
    'https://erp.starsnap.kr/')
      printf '%s' '<html><title>StarSnap ERP</title></html>' >"$output"
      ;;
    'https://erp.starsnap.kr/api/health')
      if [[ "$FAKE_EXTERNAL_MODE" == "exposed_erp_health" ]]; then
        printf 'HTTP/2 200 OK\r\n\r\n' >"$dump_header"
      else
        printf 'HTTP/2 404 Not Found\r\n\r\n' >"$dump_header"
      fi
      ;;
    'https://erp.starsnap.kr/api/health/')
      if [[ "$FAKE_EXTERNAL_MODE" == "exposed_erp_health_slash" ]]; then
        printf 'HTTP/2 200 OK\r\n\r\n' >"$dump_header"
      else
        printf 'HTTP/2 404 Not Found\r\n\r\n' >"$dump_header"
      fi
      ;;
    'https://sns.starsnap.kr/')
      printf '%s' '<html><title>StarSnap</title></html>' >"$output"
      ;;
    'https://sns.starsnap.kr/api/health')
      printf '%s' '{"status": "ok"}' >"$output"
      ;;
    'https://chat.starsnap.kr/')
      if [[ "$FAKE_EXTERNAL_MODE" == "bad_chat_surface" ]]; then
        printf 'HTTP/2 200 OK\r\nX-StarSnap-App-Surface: social\r\n\r\n' >"$dump_header"
      else
        printf 'HTTP/2 200 OK\r\nX-StarSnap-App-Surface: chat\r\n\r\n' >"$dump_header"
      fi
      if [[ "$FAKE_EXTERNAL_MODE" == "bad_chat_marker" ]]; then
        printf '%s' '<html><title>Unexpected app</title></html>' >"$output"
      else
        printf '%s' '<html><meta name="starsnap-app-surfaces" content="social chat bible" /></html>' >"$output"
      fi
      ;;
    'https://chat.starsnap.kr/api/health')
      printf 'HTTP/2 200 OK\r\n\r\n' >"$dump_header"
      if [[ "$FAKE_EXTERNAL_MODE" == "bad_chat_health" ]]; then
        printf '%s' '{"status": "degraded"}' >"$output"
      elif [[ "$FAKE_EXTERNAL_MODE" == "malformed_chat_health" ]]; then
        printf '%s' 'garbage "status":"ok"' >"$output"
      else
        printf '%s' '{"status": "ok"}' >"$output"
      fi
      ;;
    'https://bible.starsnap.kr/')
      if [[ "$FAKE_EXTERNAL_MODE" == "bad_bible_surface" ]]; then
        printf 'HTTP/2 200 OK\r\nX-StarSnap-App-Surface: social\r\n\r\n' >"$dump_header"
      else
        printf 'HTTP/2 200 OK\r\nX-StarSnap-App-Surface: bible\r\n\r\n' >"$dump_header"
      fi
      if [[ "$FAKE_EXTERNAL_MODE" == "bad_bible_marker" ]]; then
        printf '%s' '<html><title>Unexpected app</title></html>' >"$output"
      else
        printf '%s' '<html><title>StarSnap Bible</title></html>' >"$output"
      fi
      ;;
    'https://bible.starsnap.kr/api/health')
      printf 'HTTP/2 200 OK\r\n\r\n' >"$dump_header"
      if [[ "$FAKE_EXTERNAL_MODE" == "bad_bible_health" ]]; then
        printf '%s' '{"status": "degraded"}' >"$output"
      else
        printf '%s' '{"status": "UP", "service": "starsnap-bible-server"}' >"$output"
      fi
      ;;
    'https://admin.starsnap.kr/')
      if [[ "$FAKE_EXTERNAL_MODE" == "bad_admin_marker" ]]; then
        printf '%s' '<html><title>Unexpected console</title></html>' >"$output"
      else
        printf '%s' '<html><title>StarSnap Admin</title></html>' >"$output"
      fi
      ;;
    'https://admin.starsnap.kr/api/health')
      if [[ "$FAKE_EXTERNAL_MODE" == "bad_admin_health_status" ]]; then
        printf 'HTTP/2 503 Service Unavailable\r\n\r\n' >"$dump_header"
      else
        printf 'HTTP/2 200 OK\r\n\r\n' >"$dump_header"
      fi
      if [[ "$FAKE_EXTERNAL_MODE" == "bad_admin_health" ]]; then
        printf '%s' '{"status": "degraded"}' >"$output"
      else
        printf '%s' '{"status": "ok"}' >"$output"
      fi
      ;;
    'https://log.starsnap.kr/')
      if [[ "$FAKE_EXTERNAL_MODE" == "bad_log_access_gate" ]]; then
        printf 'HTTP/2 200 OK\r\n\r\n' >"$dump_header"
      else
        printf 'HTTP/2 302 Found\r\nLocation: https://team.cloudflareaccess.com/cdn-cgi/access/login/log.starsnap.kr?kid=test\r\nWWW-Authenticate: Cloudflare-Access resource_metadata="https://log.starsnap.kr/.well-known/cloudflare-access-protected-resource/"\r\n\r\n' >"$dump_header"
      fi
      ;;
    *)
      echo "Unexpected fake external URL: $request_url" >&2
      return 22
      ;;
  esac
}

sleep() {
  printf '%s\n' "$1" >>"$FAKE_EXTERNAL_SLEEP_LOG"
}

export -f curl sleep

success_output="$(
  STARSNAP_EXTERNAL_VERIFY_ATTEMPTS=1 \
  STARSNAP_EXTERNAL_VERIFY_DELAY_SECONDS=0 \
    bash deploy/verify-external.sh 2>&1
)"
grep -Fq "External verification passed" <<<"$success_output"
grep -Fxq 'http://starsnap.kr/__starsnap_external_verify__/path?source=github&value=1' "$FAKE_EXTERNAL_CALL_LOG"
grep -Fxq 'http://api.starsnap.kr/api/health' "$FAKE_EXTERNAL_CALL_LOG"
grep -Fxq 'http://www.starsnap.kr/__starsnap_external_verify__/path?source=github&value=1' "$FAKE_EXTERNAL_CALL_LOG"
grep -Fxq 'https://www.starsnap.kr/__starsnap_external_verify__/path?source=github&value=1' "$FAKE_EXTERNAL_CALL_LOG"
grep -Fxq 'https://starsnap.kr/' "$FAKE_EXTERNAL_CALL_LOG"
grep -Fxq 'https://starsnap.kr/icon.png' "$FAKE_EXTERNAL_CALL_LOG"
grep -Fxq 'https://api.starsnap.kr/api/health' "$FAKE_EXTERNAL_CALL_LOG"
grep -Fxq 'http://erp.starsnap.kr/api/health' "$FAKE_EXTERNAL_CALL_LOG"
grep -Fxq 'https://erp.starsnap.kr/' "$FAKE_EXTERNAL_CALL_LOG"
grep -Fxq 'https://erp.starsnap.kr/api/health' "$FAKE_EXTERNAL_CALL_LOG"
grep -Fxq 'https://erp.starsnap.kr/api/health/' "$FAKE_EXTERNAL_CALL_LOG"
grep -Fxq 'http://sns.starsnap.kr/api/health' "$FAKE_EXTERNAL_CALL_LOG"
grep -Fxq 'https://sns.starsnap.kr/' "$FAKE_EXTERNAL_CALL_LOG"
grep -Fxq 'https://sns.starsnap.kr/api/health' "$FAKE_EXTERNAL_CALL_LOG"
grep -Fxq 'http://chat.starsnap.kr/api/health' "$FAKE_EXTERNAL_CALL_LOG"
grep -Fxq 'https://chat.starsnap.kr/' "$FAKE_EXTERNAL_CALL_LOG"
grep -Fxq 'https://chat.starsnap.kr/api/health' "$FAKE_EXTERNAL_CALL_LOG"
grep -Fxq 'http://bible.starsnap.kr/api/health' "$FAKE_EXTERNAL_CALL_LOG"
grep -Fxq 'https://bible.starsnap.kr/' "$FAKE_EXTERNAL_CALL_LOG"
grep -Fxq 'https://bible.starsnap.kr/api/health' "$FAKE_EXTERNAL_CALL_LOG"
grep -Fxq 'http://admin.starsnap.kr/api/health' "$FAKE_EXTERNAL_CALL_LOG"
grep -Fxq 'https://admin.starsnap.kr/' "$FAKE_EXTERNAL_CALL_LOG"
grep -Fxq 'https://admin.starsnap.kr/api/health' "$FAKE_EXTERNAL_CALL_LOG"
grep -Fxq 'http://log.starsnap.kr/' "$FAKE_EXTERNAL_CALL_LOG"
grep -Fxq 'https://log.starsnap.kr/' "$FAKE_EXTERNAL_CALL_LOG"
test "$(wc -l <"$FAKE_EXTERNAL_CALL_LOG" | tr -d ' ')" = "25"
test ! -s "$FAKE_EXTERNAL_SLEEP_LOG"

: >"$FAKE_EXTERNAL_CALL_LOG"
: >"$FAKE_EXTERNAL_SLEEP_LOG"
export FAKE_EXTERNAL_MODE=bad_log_access_gate
if bad_log_access_gate_output="$(
  STARSNAP_EXTERNAL_VERIFY_ATTEMPTS=2 \
  STARSNAP_EXTERNAL_VERIFY_DELAY_SECONDS=0 \
    bash deploy/verify-external.sh 2>&1
)"; then
  echo "Expected a missing Log Hub Access gate to exhaust retries." >&2
  exit 1
fi
grep -Fq "Unexpected Log Hub Access gate" <<<"$bad_log_access_gate_output"
test "$(wc -l <"$FAKE_EXTERNAL_CALL_LOG" | tr -d ' ')" = "50"
test "$(wc -l <"$FAKE_EXTERNAL_SLEEP_LOG" | tr -d ' ')" = "1"

: >"$FAKE_EXTERNAL_CALL_LOG"
: >"$FAKE_EXTERNAL_SLEEP_LOG"
export FAKE_EXTERNAL_MODE=exposed_erp_health
if exposed_erp_health_output="$(
  STARSNAP_EXTERNAL_VERIFY_ATTEMPTS=2 \
  STARSNAP_EXTERNAL_VERIFY_DELAY_SECONDS=0 \
    bash deploy/verify-external.sh 2>&1
)"; then
  echo "Expected an exposed ERP health response to exhaust retries." >&2
  exit 1
fi
grep -Fq "Public ERP detailed health endpoint was not hidden" <<<"$exposed_erp_health_output"
test "$(wc -l <"$FAKE_EXTERNAL_CALL_LOG" | tr -d ' ')" = "28"
test "$(wc -l <"$FAKE_EXTERNAL_SLEEP_LOG" | tr -d ' ')" = "1"

: >"$FAKE_EXTERNAL_CALL_LOG"
: >"$FAKE_EXTERNAL_SLEEP_LOG"
export FAKE_EXTERNAL_MODE=exposed_erp_health_slash
if exposed_erp_health_slash_output="$(
  STARSNAP_EXTERNAL_VERIFY_ATTEMPTS=2 \
  STARSNAP_EXTERNAL_VERIFY_DELAY_SECONDS=0 \
    bash deploy/verify-external.sh 2>&1
)"; then
  echo "Expected an exposed trailing-slash ERP health response to exhaust retries." >&2
  exit 1
fi
grep -Fq "Public ERP trailing-slash health endpoint was not hidden" <<<"$exposed_erp_health_slash_output"
test "$(wc -l <"$FAKE_EXTERNAL_CALL_LOG" | tr -d ' ')" = "30"
test "$(wc -l <"$FAKE_EXTERNAL_SLEEP_LOG" | tr -d ' ')" = "1"

: >"$FAKE_EXTERNAL_CALL_LOG"
: >"$FAKE_EXTERNAL_SLEEP_LOG"
export FAKE_EXTERNAL_MODE=bad_chat_marker
if bad_chat_marker_output="$(
  STARSNAP_EXTERNAL_VERIFY_ATTEMPTS=2 \
  STARSNAP_EXTERNAL_VERIFY_DELAY_SECONDS=0 \
    bash deploy/verify-external.sh 2>&1
)"; then
  echo "Expected a missing Chat marker to exhaust retries." >&2
  exit 1
fi
grep -Fq "Public Chat root response did not contain the Chat surface capability marker" <<<"$bad_chat_marker_output"
test "$(wc -l <"$FAKE_EXTERNAL_CALL_LOG" | tr -d ' ')" = "36"
test "$(wc -l <"$FAKE_EXTERNAL_SLEEP_LOG" | tr -d ' ')" = "1"

: >"$FAKE_EXTERNAL_CALL_LOG"
: >"$FAKE_EXTERNAL_SLEEP_LOG"
export FAKE_EXTERNAL_MODE=bad_chat_surface
if bad_chat_surface_output="$(
  STARSNAP_EXTERNAL_VERIFY_ATTEMPTS=2 \
  STARSNAP_EXTERNAL_VERIFY_DELAY_SECONDS=0 \
    bash deploy/verify-external.sh 2>&1
)"; then
  echo "Expected an incorrect Chat surface header to exhaust retries." >&2
  exit 1
fi
grep -Fq "Public Chat root response did not identify the Chat surface" <<<"$bad_chat_surface_output"
test "$(wc -l <"$FAKE_EXTERNAL_CALL_LOG" | tr -d ' ')" = "36"
test "$(wc -l <"$FAKE_EXTERNAL_SLEEP_LOG" | tr -d ' ')" = "1"

: >"$FAKE_EXTERNAL_CALL_LOG"
: >"$FAKE_EXTERNAL_SLEEP_LOG"
export FAKE_EXTERNAL_MODE=bad_chat_health
if bad_chat_health_output="$(
  STARSNAP_EXTERNAL_VERIFY_ATTEMPTS=2 \
  STARSNAP_EXTERNAL_VERIFY_DELAY_SECONDS=0 \
    bash deploy/verify-external.sh 2>&1
)"; then
  echo "Expected a non-ok Chat health response to exhaust retries." >&2
  exit 1
fi
grep -Fq "Public Chat API health response was not ok" <<<"$bad_chat_health_output"
test "$(wc -l <"$FAKE_EXTERNAL_CALL_LOG" | tr -d ' ')" = "38"
test "$(wc -l <"$FAKE_EXTERNAL_SLEEP_LOG" | tr -d ' ')" = "1"

: >"$FAKE_EXTERNAL_CALL_LOG"
: >"$FAKE_EXTERNAL_SLEEP_LOG"
export FAKE_EXTERNAL_MODE=malformed_chat_health
if malformed_chat_health_output="$(
  STARSNAP_EXTERNAL_VERIFY_ATTEMPTS=2 \
  STARSNAP_EXTERNAL_VERIFY_DELAY_SECONDS=0 \
    bash deploy/verify-external.sh 2>&1
)"; then
  echo "Expected malformed Chat health JSON to exhaust retries." >&2
  exit 1
fi
grep -Fq "Public Chat API health response was not ok" <<<"$malformed_chat_health_output"
test "$(wc -l <"$FAKE_EXTERNAL_CALL_LOG" | tr -d ' ')" = "38"
test "$(wc -l <"$FAKE_EXTERNAL_SLEEP_LOG" | tr -d ' ')" = "1"

: >"$FAKE_EXTERNAL_CALL_LOG"
: >"$FAKE_EXTERNAL_SLEEP_LOG"
export FAKE_EXTERNAL_MODE=bad_bible_marker
if bad_bible_marker_output="$(
  STARSNAP_EXTERNAL_VERIFY_ATTEMPTS=2 \
  STARSNAP_EXTERNAL_VERIFY_DELAY_SECONDS=0 \
    bash deploy/verify-external.sh 2>&1
)"; then
  echo "Expected a missing Bible title marker to exhaust retries." >&2
  exit 1
fi
grep -Fq "Public Bible root response did not contain the StarSnap Bible title marker" <<<"$bad_bible_marker_output"
test "$(wc -l <"$FAKE_EXTERNAL_CALL_LOG" | tr -d ' ')" = "40"
test "$(wc -l <"$FAKE_EXTERNAL_SLEEP_LOG" | tr -d ' ')" = "1"

: >"$FAKE_EXTERNAL_CALL_LOG"
: >"$FAKE_EXTERNAL_SLEEP_LOG"
export FAKE_EXTERNAL_MODE=bad_bible_surface
if bad_bible_surface_output="$(
  STARSNAP_EXTERNAL_VERIFY_ATTEMPTS=2 \
  STARSNAP_EXTERNAL_VERIFY_DELAY_SECONDS=0 \
    bash deploy/verify-external.sh 2>&1
)"; then
  echo "Expected an incorrect Bible surface header to exhaust retries." >&2
  exit 1
fi
grep -Fq "Public Bible root response did not identify the Bible surface" <<<"$bad_bible_surface_output"
test "$(wc -l <"$FAKE_EXTERNAL_CALL_LOG" | tr -d ' ')" = "40"
test "$(wc -l <"$FAKE_EXTERNAL_SLEEP_LOG" | tr -d ' ')" = "1"

: >"$FAKE_EXTERNAL_CALL_LOG"
: >"$FAKE_EXTERNAL_SLEEP_LOG"
export FAKE_EXTERNAL_MODE=bad_bible_health
if bad_bible_health_output="$(
  STARSNAP_EXTERNAL_VERIFY_ATTEMPTS=2 \
  STARSNAP_EXTERNAL_VERIFY_DELAY_SECONDS=0 \
    bash deploy/verify-external.sh 2>&1
)"; then
  echo "Expected a non-ok Bible health response to exhaust retries." >&2
  exit 1
fi
grep -Fq "Public Bible API health response was not ok" <<<"$bad_bible_health_output"
test "$(wc -l <"$FAKE_EXTERNAL_CALL_LOG" | tr -d ' ')" = "42"
test "$(wc -l <"$FAKE_EXTERNAL_SLEEP_LOG" | tr -d ' ')" = "1"

: >"$FAKE_EXTERNAL_CALL_LOG"
: >"$FAKE_EXTERNAL_SLEEP_LOG"
export FAKE_EXTERNAL_MODE=bad_admin_marker
if bad_admin_marker_output="$(
  STARSNAP_EXTERNAL_VERIFY_ATTEMPTS=2 \
  STARSNAP_EXTERNAL_VERIFY_DELAY_SECONDS=0 \
    bash deploy/verify-external.sh 2>&1
)"; then
  echo "Expected a missing Admin marker to exhaust retries." >&2
  exit 1
fi
grep -Fq "Public Admin root response did not contain the StarSnap Admin marker" <<<"$bad_admin_marker_output"
test "$(wc -l <"$FAKE_EXTERNAL_CALL_LOG" | tr -d ' ')" = "44"
test "$(wc -l <"$FAKE_EXTERNAL_SLEEP_LOG" | tr -d ' ')" = "1"

: >"$FAKE_EXTERNAL_CALL_LOG"
: >"$FAKE_EXTERNAL_SLEEP_LOG"
export FAKE_EXTERNAL_MODE=bad_admin_health_status
if bad_admin_health_status_output="$(
  STARSNAP_EXTERNAL_VERIFY_ATTEMPTS=2 \
  STARSNAP_EXTERNAL_VERIFY_DELAY_SECONDS=0 \
    bash deploy/verify-external.sh 2>&1
)"; then
  echo "Expected a non-200 Admin health response to exhaust retries." >&2
  exit 1
fi
grep -Fq "Public Admin API health returned HTTP 503" <<<"$bad_admin_health_status_output"
test "$(wc -l <"$FAKE_EXTERNAL_CALL_LOG" | tr -d ' ')" = "46"
test "$(wc -l <"$FAKE_EXTERNAL_SLEEP_LOG" | tr -d ' ')" = "1"

: >"$FAKE_EXTERNAL_CALL_LOG"
: >"$FAKE_EXTERNAL_SLEEP_LOG"
export FAKE_EXTERNAL_MODE=bad_admin_health
if bad_admin_health_output="$(
  STARSNAP_EXTERNAL_VERIFY_ATTEMPTS=2 \
  STARSNAP_EXTERNAL_VERIFY_DELAY_SECONDS=0 \
    bash deploy/verify-external.sh 2>&1
)"; then
  echo "Expected a non-ok Admin health response to exhaust retries." >&2
  exit 1
fi
grep -Fq "Public Admin API health response was not ok" <<<"$bad_admin_health_output"
test "$(wc -l <"$FAKE_EXTERNAL_CALL_LOG" | tr -d ' ')" = "46"
test "$(wc -l <"$FAKE_EXTERNAL_SLEEP_LOG" | tr -d ' ')" = "1"

: >"$FAKE_EXTERNAL_CALL_LOG"
: >"$FAKE_EXTERNAL_SLEEP_LOG"
export FAKE_EXTERNAL_MODE=bad_status
if bad_status_output="$(
  STARSNAP_EXTERNAL_VERIFY_ATTEMPTS=2 \
  STARSNAP_EXTERNAL_VERIFY_DELAY_SECONDS=0 \
    bash deploy/verify-external.sh 2>&1
)"; then
  echo "Expected a bad redirect status to exhaust retries." >&2
  exit 1
fi
grep -Fq "Unexpected redirect" <<<"$bad_status_output"
grep -Fq "status=302" <<<"$bad_status_output"
test "$(wc -l <"$FAKE_EXTERNAL_CALL_LOG" | tr -d ' ')" = "2"
test "$(wc -l <"$FAKE_EXTERNAL_SLEEP_LOG" | tr -d ' ')" = "1"

: >"$FAKE_EXTERNAL_CALL_LOG"
: >"$FAKE_EXTERNAL_SLEEP_LOG"
export FAKE_EXTERNAL_MODE=bad_location
if bad_location_output="$(
  STARSNAP_EXTERNAL_VERIFY_ATTEMPTS=2 \
  STARSNAP_EXTERNAL_VERIFY_DELAY_SECONDS=0 \
    bash deploy/verify-external.sh 2>&1
)"; then
  echo "Expected a bad redirect location to exhaust retries." >&2
  exit 1
fi
grep -Fq "Unexpected redirect" <<<"$bad_location_output"
grep -Fq "location=https://wrong.example/" <<<"$bad_location_output"
test "$(wc -l <"$FAKE_EXTERNAL_CALL_LOG" | tr -d ' ')" = "2"
test "$(wc -l <"$FAKE_EXTERNAL_SLEEP_LOG" | tr -d ' ')" = "1"

: >"$FAKE_EXTERNAL_CALL_LOG"
: >"$FAKE_EXTERNAL_SLEEP_LOG"
export FAKE_EXTERNAL_MODE=tls_failure
if tls_failure_output="$(
  STARSNAP_EXTERNAL_VERIFY_ATTEMPTS=2 \
  STARSNAP_EXTERNAL_VERIFY_DELAY_SECONDS=0 \
    bash deploy/verify-external.sh 2>&1
)"; then
  echo "Expected a TLS failure to exhaust retries." >&2
  exit 1
fi
grep -Fq "Redirect request failed: https://www.starsnap.kr/" <<<"$tls_failure_output"
grep -Fq "External verification failed after 2 attempts" <<<"$tls_failure_output"
test "$(wc -l <"$FAKE_EXTERNAL_CALL_LOG" | tr -d ' ')" = "8"
test "$(wc -l <"$FAKE_EXTERNAL_SLEEP_LOG" | tr -d ' ')" = "1"

: >"$FAKE_EXTERNAL_CALL_LOG"
: >"$FAKE_EXTERNAL_SLEEP_LOG"
export FAKE_EXTERNAL_MODE=request_failure
if request_failure_output="$(
  STARSNAP_EXTERNAL_VERIFY_ATTEMPTS=2 \
  STARSNAP_EXTERNAL_VERIFY_DELAY_SECONDS=0 \
    bash deploy/verify-external.sh 2>&1
)"; then
  echo "Expected a request failure to exhaust retries." >&2
  exit 1
fi
grep -Fq "Redirect request failed: http://starsnap.kr/" <<<"$request_failure_output"
grep -Fq "External verification failed after 2 attempts" <<<"$request_failure_output"
test "$(wc -l <"$FAKE_EXTERNAL_CALL_LOG" | tr -d ' ')" = "2"
test "$(wc -l <"$FAKE_EXTERNAL_SLEEP_LOG" | tr -d ' ')" = "1"

echo "verify-external tests passed"
