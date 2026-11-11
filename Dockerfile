FROM node:24-alpine

WORKDIR /app
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node scripts/healthcheck.ts ./scripts/healthcheck.ts
COPY --chown=node:node scripts/check-production-readiness.ts ./scripts/check-production-readiness.ts
COPY --chown=node:node migrations ./migrations

RUN mkdir -p /data && chown node:node /data

ENV NODE_ENV=production \
    PORT=3443 \
    DATABASE_PATH=/data/gabel.db

USER node
VOLUME ["/data"]
EXPOSE 3443

HEALTHCHECK --interval=30s --timeout=7s --start-period=15s --retries=3 \
  CMD ["node", "--experimental-strip-types", "scripts/healthcheck.ts"]

CMD ["node", "--experimental-strip-types", "src/server.ts"]
