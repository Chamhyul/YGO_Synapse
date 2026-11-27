FROM asia-northeast3-docker.pkg.dev/ygo-synapse/supabase-transition/api@sha256:b013d56e01208f397a55e3cbf4dc21777a335d83afdf140e56afdcfaa7779572
COPY --chown=node:node origin.cjs install-origin.cjs /app/api/
RUN node /app/api/install-origin.cjs
