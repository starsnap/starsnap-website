# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
# npm's Windows-generated lock omits a small set of Linux-only optional
# bindings. `npm install` keeps all locked versions and fills those platform
# entries so the Vinext/Rolldown build can run in this Linux image.
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

# The built application is a Cloudflare Worker and uses Wrangler as its local
# HTTP runtime. Durable application data is stored in PostgreSQL.
RUN apt-get update \
    && apt-get install --yes --no-install-recommends bash ca-certificates curl \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global wrangler@4.92.0 \
    && mkdir -p /app/.wrangler \
    && chown -R node:node /app/.wrangler

COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node docker-entrypoint.sh /usr/local/bin/starsnap-erp-entrypoint
COPY --chown=node:node scripts/write-worker-config.mjs /usr/local/lib/starsnap-erp/write-worker-config.mjs
COPY --chown=node:node scripts/neis-curl-proxy.mjs /usr/local/lib/starsnap-erp/neis-curl-proxy.mjs

RUN chmod 0755 /usr/local/bin/starsnap-erp-entrypoint

USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=8s --start-period=60s --retries=5 \
  CMD node -e "const checks=[fetch('http://127.0.0.1:' + process.env.PORT + '/api/health').then(r=>r.ok)];if(process.env.NEIS_PROXY_URL)checks.push(fetch(new URL('/health',process.env.NEIS_PROXY_URL)).then(r=>r.status===204));Promise.all(checks).then(v=>process.exit(v.every(Boolean)?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["starsnap-erp-entrypoint"]
