FROM docker.io/library/node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32

COPY app /app
COPY serve /usr/local/lib/node_modules/serve

ARG APP_PORT
ENV APP_PORT=${APP_PORT}

EXPOSE ${APP_PORT}

CMD ["sh", "-ec", "exec node /usr/local/lib/node_modules/serve/build/main.js -s /app -l $APP_PORT"]
