# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS dependencies
WORKDIR /app/functions
COPY functions/package.json functions/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

FROM node:24-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20
ENV NODE_ENV=production
WORKDIR /app
COPY --from=dependencies --chown=node:node /app/functions/node_modules ./functions/node_modules
COPY --chown=node:node functions/package.json ./functions/package.json
COPY --chown=node:node functions/config ./functions/config
COPY --chown=node:node functions/services ./functions/services
COPY --chown=node:node functions/utils ./functions/utils
COPY --chown=node:node scripts/user_writer_job.cjs scripts/manage_user_writer.cjs scripts/reconcile_membership_claims.cjs ./scripts/
USER node
ENTRYPOINT ["node", "scripts/user_writer_job.cjs"]
CMD ["writer", "--help"]
