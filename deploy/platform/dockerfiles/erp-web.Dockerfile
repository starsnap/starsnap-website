# syntax=docker/dockerfile:1

# Vinext emits platform-independent JavaScript assets. Running that compilation
# on BUILDPLATFORM avoids QEMU during cross-builds; the final Wrangler runtime
# still uses TARGETPLATFORM and is therefore a genuine ARM64 image.
FROM --platform=$BUILDPLATFORM node:22-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm install --include=optional --no-audit --no-fund

COPY . .

ARG SITE_ORIGIN=http://127.0.0.1:3001
ENV SITE_ORIGIN=${SITE_ORIGIN}

RUN npm run build


FROM node:22-bookworm-slim AS runtime

WORKDIR /app

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    WRANGLER_SEND_METRICS=false \
    WRANGLER_WRITE_LOGS=false

RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && test -r /etc/ssl/certs/ca-certificates.crt \
    && npm install --global wrangler@4.92.0 \
    && mkdir -p /app/.wrangler \
    && chown -R node:node /app/.wrangler

COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node docker-entrypoint.sh /usr/local/bin/starsnap-erp-entrypoint
COPY --chown=node:node scripts/write-worker-config.mjs /usr/local/lib/starsnap-erp/write-worker-config.mjs

RUN chmod 0755 /usr/local/bin/starsnap-erp-entrypoint

USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=8s --start-period=60s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:' + process.env.PORT + '/api/health').then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"

ENTRYPOINT ["starsnap-erp-entrypoint"]
