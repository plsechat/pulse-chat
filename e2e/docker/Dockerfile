# E2E harness image — runs Pulse via the bun runtime (interpreted, not
# the compiled single binary): bun --compile flattens the auth dispatcher's
# dynamic imports, which crashes local mode when Supabase env vars are
# absent, and the suite only needs a bootable instance, not the shipped
# artifact.
#
# Instance-specific config (federation on/off, instance domain) is
# injected via env by entrypoint.sh, which writes config.ini BEFORE the
# app's first boot — no post-boot sed, no container-restart dance.

# Pinned via root package.json "packageManager"; e2e.yml passes it through.
ARG BUN_VERSION=1.3.9
FROM oven/bun:${BUN_VERSION}
WORKDIR /app

# Manifests first so the dependency layer survives source-only edits.
COPY package.json bun.lock ./
COPY apps/server/package.json apps/server/
COPY apps/client/package.json apps/client/
COPY packages/shared/package.json packages/shared/
COPY packages/plugin-sdk/package.json packages/plugin-sdk/
RUN bun install --frozen-lockfile

COPY . .

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
