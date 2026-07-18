# E2E harness image — runs Pulse via the bun runtime (interpreted, not
# the compiled single binary). Mirrors test-deploy's approach; see
# test-deploy/TEST-DEPLOY.md for why runtime mode is used (bun --compile
# flattens the auth dispatcher's dynamic imports, which crashes local
# mode when Supabase env vars are absent).
#
# Instance-specific config (federation on/off, instance domain) is
# injected via env by entrypoint.sh, which writes config.ini BEFORE the
# app's first boot — no post-boot sed, no container-restart dance.

FROM oven/bun:1.3.5
WORKDIR /app
COPY . .

RUN bun install

# Migrations need patching for the runtime path the same way the
# compiled image does.
RUN cd apps/server && bun run /app/docker/patch-migrations.ts ./src/db/migrations

# Build the client bundle.
RUN cd apps/client && bun run build

# In IS_DEVELOPMENT mode, loadEmbeds() skips the embedded-zip extract
# but doesn't seed INTERFACE_PATH. Pre-populate it from the just-built
# client bundle so the HTTP interface handler can serve the UI from the
# first request. INTERFACE_PATH = DATA_PATH/interface/SERVER_VERSION and
# DATA_PATH in dev resolves to <cwd>/data (cwd = /app/apps/server).
RUN VERSION=$(bun -e "console.log(require('./apps/server/package.json').version)") \
    && mkdir -p apps/server/data/interface/${VERSION} \
    && cp -R apps/client/dist/. apps/server/data/interface/${VERSION}/ \
    && echo "Seeded apps/server/data/interface/${VERSION}" \
    && echo "PULSE_BUILD_VERSION=${VERSION}" > /pulse-version.env

COPY e2e/docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
ENV RUNNING_IN_DOCKER=true

WORKDIR /app/apps/server
ENTRYPOINT ["/entrypoint.sh"]
