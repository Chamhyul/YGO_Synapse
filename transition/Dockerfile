FROM asia-northeast3-docker.pkg.dev/ygo-synapse/supabase-transition/api@sha256:62c95cd9cef793f402e4ee6387340cf68352f61a96db9f88f6b7e36b586fe015
COPY --chown=node:node transition/api/ /app/api/
COPY --chown=node:node transition/runtime/functions/ /functions/
COPY --chown=node:node transition/prepare-parser.cjs /app/transition/
COPY --chown=node:node transition/supabase/migrations/20261030071800_link_existing_images_only.sql /app/migrations/
