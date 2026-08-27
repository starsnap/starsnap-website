# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim

WORKDIR /app

ENV NODE_ENV=production

COPY --chown=node:node scripts/product-embedding-poller.mjs ./scripts/product-embedding-poller.mjs
COPY --chown=node:node scripts/ensure-embedding-worker-token.mjs ./scripts/ensure-embedding-worker-token.mjs
COPY --chown=node:node scripts/import-starsnap-mail-secrets.mjs ./scripts/import-starsnap-mail-secrets.mjs

USER node

STOPSIGNAL SIGTERM

CMD ["node", "scripts/product-embedding-poller.mjs"]
