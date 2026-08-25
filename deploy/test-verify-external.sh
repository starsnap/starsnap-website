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
test "$(wc -l <"$FAKE_EXTERNAL_CALL_LOG" | tr -d ' ')" = "14"
test ! -s "$FAKE_EXTERNAL_SLEEP_LOG"

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
test "$(wc -l <"$FAKE_EXTERNAL_CALL_LOG" | tr -d ' ')" = "22"
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
test "$(wc -l <"$FAKE_EXTERNAL_CALL_LOG" | tr -d ' ')" = "24"
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
