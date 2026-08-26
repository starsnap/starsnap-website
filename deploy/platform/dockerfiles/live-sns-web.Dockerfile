FROM docker.io/library/nginx:alpine@sha256:db35bfc6b2951e7f8a72db5db120288c127ffaeeb4a6d4b95a26fead017d5913

COPY default.conf /etc/nginx/conf.d/default.conf
COPY html /usr/share/nginx/html

EXPOSE 3000

CMD ["nginx", "-g", "daemon off;"]
