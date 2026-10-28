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
ARG BUN_VERSION=1.4.4
FROM oven/bun:${BUN_VERSION}
WORKDIR /app

# Manifests first so the dependency layer survives source-only edits.
COPY package.json bun.lock ./
COPY apps/server/package.json apps/server/
COPY apps/client/package.json apps/client/
COPY packages/shared/package.json packages/shared/
COPY packages/plugin-sdk/package.json packages/plugin-sdk/
COPY packages/plugins/discord-bridge/package.json packages/plugins/discord-bridge/
COPY packages/plugins/watch-together/package.json packages/plugins/watch-together/

# mediasoup's postinstall names its prebuilt worker after the HOST kernel
# major (…-linux-x64-kernel7.tgz on a kernel-7 build host) and falls back to
# compiling when that asset does not exist, which needs Python and fails
# here. The kernel6 build is what mediasoup publishes for this version and
# runs on any newer kernel (the suffix only marks io_uring support), so
# fetch it explicitly and hand it to mediasoup through MEDIASOUP_WORKER_BIN,
# which both skips the postinstall and is what the runtime spawns.
ENV MEDIASOUP_WORKER_BIN=/opt/mediasoup/mediasoup-worker
RUN set -e; \
    version=$(bun -e "console.log(require('./apps/server/package.json').dependencies.mediasoup)"); \
    case "$(uname -m)" in x86_64) arch=x64 ;; aarch64) arch=arm64 ;; *) echo "unsupported arch $(uname -m)" >&2; exit 1 ;; esac; \
    url="https://github.com/versatica/mediasoup/releases/download/${version}/mediasoup-worker-${version}-linux-${arch}-kernel6.tgz"; \
    mkdir -p /opt/mediasoup; \
    bun -e "const r = await fetch(process.argv[1]); if (!r.ok) throw new Error(r.status + ' ' + process.argv[1]); await Bun.write('/tmp/mediasoup-worker.tgz', r);" "$url"; \
    tar -xzf /tmp/mediasoup-worker.tgz -C /opt/mediasoup && rm /tmp/mediasoup-worker.tgz; \
    chmod +x /opt/mediasoup/mediasoup-worker; \
    bun install --frozen-lockfile

COPY . .

# Build the client bundle.
RUN cd apps/client && bun run build

# Build the official plugins; the entrypoint seeds them into the data
# directory so the review stack can enable them like production does.
RUN cd packages/plugins/discord-bridge && bun run build \
    && cd ../watch-together && bun run build

# In IS_DEVELOPMENT mode, loadEmbeds() skips the embedded-zip extract
# but doesn't seed INTERFACE_PATH. Stash the just-built client bundle
# outside the data directory; entrypoint.sh copies it into
# DATA_PATH/interface/SERVER_VERSION at boot (DATA_PATH in dev resolves
# to <cwd>/data, cwd = /app/apps/server). The stash lives outside
# DATA_PATH on purpose: compose.upgrade.yml mounts a named volume over
# the data directory, and a volume hides whatever the image put there.
#
# `.build-stamp` is a content hash of the bundle. The entrypoint only
# re-seeds when the stamp differs from the one already in the data
# directory — a fresh container always seeds, an upgrade onto a volume
# that carries an older build re-seeds, and a bundle hot-patched into a
# running container (same stamp) survives a restart.
RUN VERSION=$(bun -e "console.log(require('./apps/server/package.json').version)") \
    && mkdir -p /app/interface-seed \
    && cp -R apps/client/dist/. /app/interface-seed/ \
    && (cd /app/interface-seed && find . -type f | LC_ALL=C sort | xargs sha256sum | sha256sum | cut -d' ' -f1) > /app/interface-seed/.build-stamp \
    && echo "Stashed client bundle $(cat /app/interface-seed/.build-stamp) for ${VERSION}" \
    && echo "PULSE_BUILD_VERSION=${VERSION}" > /pulse-version.env

COPY e2e/docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
ENV RUNNING_IN_DOCKER=true

WORKDIR /app/apps/server
ENTRYPOINT ["/entrypoint.sh"]
