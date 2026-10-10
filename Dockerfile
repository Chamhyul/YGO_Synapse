# syntax=docker/dockerfile:1
FROM eclipse-temurin:21-jre-jammy@sha256:f04fb34e053148344e83317976114ec3f37e4b830ec8bdab5a2fe3cecd7d010b AS java
FROM node:24-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20

COPY --from=java /opt/java/openjdk /opt/java/openjdk
ENV JAVA_HOME=/opt/java/openjdk \
    PATH="/opt/java/openjdk/bin:${PATH}" \
    FIREBASE_EMULATORS_PATH=/opt/firebase-emulators \
    PLAYWRIGHT_BROWSERS_PATH=/opt/playwright-browsers \
    NODE_PATH=/opt/browser-tools/node_modules \
    CI=true \
    FIREBASE_CLI_DISABLE_USAGE_REPORTING=true \
    NO_UPDATE_NOTIFIER=true

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global firebase-tools@15.12.0 \
    && npm install --prefix /opt/browser-tools --save-exact playwright@1.64.0 \
    && /opt/browser-tools/node_modules/.bin/playwright install --with-deps chromium \
    && firebase setup:emulators:firestore \
    && firebase setup:emulators:storage \
    && firebase setup:emulators:ui \
    && npm cache clean --force

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY functions/package.json functions/package-lock.json ./functions/
RUN npm --prefix functions ci --no-audit --no-fund

COPY docker/cache-web-assets.cjs /opt/cache-web-assets.cjs
RUN node /opt/cache-web-assets.cjs

# .dockerignore의 허용 목록에 있는 소스만 포함한다. 호스트 인증정보는 복사하지 않는다.
COPY --chown=node:node . .
RUN sha256sum package-lock.json functions/package-lock.json > /opt/dependency-locks.sha256 \
    && mkdir -p /data /test-results \
    && chown node:node /app /data /test-results
USER node
ENTRYPOINT ["/bin/sh", "/app/docker/entrypoint.sh"]
CMD ["dev"]
