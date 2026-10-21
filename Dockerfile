# listick-stremio: no dependencies, so the image is Node and these files. Settings saved with a password live in /data.
FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=8080 DB_PATH=/data/listick-stremio.db
COPY --chown=node:node package.json lib.mjs meta.mjs server.mjs ./
COPY --chown=node:node public ./public
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD wget -qO- http://127.0.0.1:8080/health || exit 1
CMD ["node", "server.mjs"]
