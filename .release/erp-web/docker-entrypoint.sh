#!/bin/bash
set -Eeuo pipefail

if [ -z "${ERP_EMBEDDING_WORKER_TOKEN:-}" ]; then
  worker_token_file=${ERP_EMBEDDING_WORKER_TOKEN_FILE:-/run/starsnap-secrets/embedding-worker-token}
  if [ ! -r "$worker_token_file" ]; then
    echo "Embedding worker token file is not readable." >&2
    exit 1
  fi
  ERP_EMBEDDING_WORKER_TOKEN=$(tr -d '\r\n' < "$worker_token_file")
  export ERP_EMBEDDING_WORKER_TOKEN
fi
if [ "${#ERP_EMBEDDING_WORKER_TOKEN}" -lt 32 ]; then
  echo "Embedding worker token must contain at least 32 characters." >&2
  exit 1
fi

if [ -z "${AUTH_CODE_SECRET:-}" ]; then
  auth_secret_file=${AUTH_CODE_SECRET_FILE:-/run/starsnap-secrets/auth-code-secret}
  if [ ! -r "$auth_secret_file" ]; then
    echo "Authentication code secret file is not readable." >&2
    exit 1
  fi
  AUTH_CODE_SECRET=$(tr -d '\r\n' < "$auth_secret_file")
  export AUTH_CODE_SECRET
fi
if [ "${#AUTH_CODE_SECRET}" -lt 32 ]; then
  echo "Authentication code secret must contain at least 32 characters." >&2
  exit 1
fi

if [ -z "${AUTH_SMTP_MAILER_TOKEN:-}" ]; then
  mailer_token_file=${AUTH_SMTP_MAILER_TOKEN_FILE:-/run/starsnap-mailer-secrets/token}
  if [ ! -r "$mailer_token_file" ]; then
    echo "SMTP mailer service token file is not readable." >&2
    exit 1
  fi
  AUTH_SMTP_MAILER_TOKEN=$(tr -d '\r\n' < "$mailer_token_file")
  export AUTH_SMTP_MAILER_TOKEN
fi
if [ "${#AUTH_SMTP_MAILER_TOKEN}" -lt 32 ]; then
  echo "SMTP mailer service token must contain at least 32 characters." >&2
  exit 1
fi

if [ -z "${EAT_API_SERVICE_KEY:-}" ]; then
  eat_api_key_file=${EAT_API_SERVICE_KEY_FILE:-/run/starsnap-secrets/eat-api-service-key}
  if [ ! -r "$eat_api_key_file" ]; then
    echo "eAT API service key file is not readable." >&2
    exit 1
  fi
  EAT_API_SERVICE_KEY=$(tr -d '\r\n' < "$eat_api_key_file")
  export EAT_API_SERVICE_KEY
fi
if [ "${#EAT_API_SERVICE_KEY}" -lt 32 ]; then
  echo "eAT API service key must contain at least 32 characters." >&2
  exit 1
fi

if [ -z "${NEIS_API_KEY:-}" ]; then
  neis_api_key_file=${NEIS_API_KEY_FILE:-/run/starsnap-secrets/neis-api-key}
  if [ -r "$neis_api_key_file" ]; then
    NEIS_API_KEY=$(tr -d '\r\n' < "$neis_api_key_file")
    export NEIS_API_KEY
  fi
fi
if [ -n "${NEIS_API_KEY:-}" ] && [ "${#NEIS_API_KEY}" -lt 16 ]; then
  echo "NEIS API key must contain at least 16 characters." >&2
  exit 1
fi

if [ -n "${NEIS_PROXY_URL:-}" ]; then
  neis_proxy_port=${NEIS_CURL_PROXY_PORT:-3001}
  if [ "$NEIS_PROXY_URL" != "http://127.0.0.1:$neis_proxy_port" ]; then
    echo "NEIS proxy URL must use the configured loopback port." >&2
    exit 1
  fi
  if [ -z "${NEIS_API_KEY:-}" ]; then
    echo "NEIS API key is required when the loopback proxy is enabled." >&2
    exit 1
  fi
  export NEIS_CURL_PROXY_PORT="$neis_proxy_port"
  node /usr/local/lib/starsnap-erp/neis-curl-proxy.mjs &
  neis_proxy_pid=$!
  neis_proxy_ready=0
  attempts=0
  while [ "$attempts" -lt 20 ]; do
    if ! kill -0 "$neis_proxy_pid" 2>/dev/null; then
      echo "NEIS loopback proxy exited during startup." >&2
      wait "$neis_proxy_pid" || true
      exit 1
    fi
    if node -e "fetch('http://127.0.0.1:$neis_proxy_port/health').then(r => process.exit(r.status === 204 ? 0 : 1)).catch(() => process.exit(1))"; then
      neis_proxy_ready=1
      break
    fi
    attempts=$((attempts + 1))
    sleep 0.25
  done
  if [ "$neis_proxy_ready" -ne 1 ]; then
    echo "NEIS loopback proxy did not become ready." >&2
    kill "$neis_proxy_pid" 2>/dev/null || true
    wait "$neis_proxy_pid" || true
    exit 1
  fi
fi

worker_config_file=${STARSNAP_WORKER_CONFIG_FILE:-/app/dist/server/wrangler.runtime.json}
case "$worker_config_file" in
  /*) ;;
  *)
    echo "Worker runtime config path must be absolute." >&2
    exit 1
    ;;
esac
export STARSNAP_WORKER_CONFIG_FILE="$worker_config_file"
export STARSNAP_WORKER_SECRETS_FILE=${STARSNAP_WORKER_SECRETS_FILE:-/app/dist/server/.dev.vars}
node /usr/local/lib/starsnap-erp/write-worker-config.mjs

set -- \
  dev \
  --config "$worker_config_file" \
  --local \
  --ip "${HOST:-0.0.0.0}" \
  --port "${PORT:-3000}" \
  --log-level info \
  --show-interactive-dev-session=false

if [ -z "${neis_proxy_pid:-}" ]; then
  exec wrangler "$@"
fi

wrangler "$@" &
wrangler_pid=$!
shutdown_runtime() {
  trap - INT TERM
  kill "$wrangler_pid" "$neis_proxy_pid" 2>/dev/null || true
  wait "$wrangler_pid" 2>/dev/null || true
  wait "$neis_proxy_pid" 2>/dev/null || true
}
trap 'shutdown_runtime; exit 143' INT TERM
set +e
wait -n "$wrangler_pid" "$neis_proxy_pid"
set -e
shutdown_runtime
exit 1
