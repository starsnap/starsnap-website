FROM node:24-alpine@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5
WORKDIR /srv
# Generate review-data.json with prepare-review.py before building.
COPY index.html style.css app.mjs memorize.mjs answer-digests.mjs server.mjs verse-review.mjs review-data.json ./
USER node
EXPOSE 8080
CMD ["node", "server.mjs"]
