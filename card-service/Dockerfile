FROM node:24-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY --chown=node:node src ./src
COPY --chown=node:node runtime ./runtime
COPY --chown=node:node test ./test
COPY --chown=node:node tools ./tools
COPY --chown=node:node manifest.json ./
COPY --chown=node:node LICENSE ./
COPY --chown=node:node legal ./legal
USER node
EXPOSE 8080
CMD ["node", "runtime/server.js"]
