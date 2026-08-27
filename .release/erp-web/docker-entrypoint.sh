#!/bin/sh
set -eu

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

exec wrangler "$@"
