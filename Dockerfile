# Single source of truth for the bun version is root package.json
# ("packageManager"); release.yml passes it through as a build-arg so the
# image compiles with the same bun that CI tested.
ARG BUN_VERSION=1.3.9

# Stage 1: Build
FROM oven/bun:${BUN_VERSION} AS builder
ARG TARGETARCH
WORKDIR /app

# Manifests first so the dependency layer survives source-only edits
# (multi-arch QEMU builds re-run everything below a busted layer).
COPY package.json bun.lock ./
COPY apps/server/package.json apps/server/
COPY apps/client/package.json apps/client/
COPY packages/shared/package.json packages/shared/
COPY packages/plugin-sdk/package.json packages/plugin-sdk/
COPY packages/plugins/discord-bridge/package.json packages/plugins/discord-bridge/
RUN bun install --frozen-lockfile

COPY . .

# Pick the bun build target that matches the *runtime* container arch.
# TARGETARCH is `amd64` on x86_64, `arm64` on Apple Silicon / aarch64.
# Without the match, the single-file executable is a foreign ELF that
# rosetta / qemu can't translate at exec time and the container
# restart-loops with `failed to open elf at /lib64/ld-...`.
RUN cd apps/server \
    && case "$TARGETARCH" in \
         amd64) BUN_TARGET=linux-x64; BIN_NAME=pulse-linux-x64 ;; \
         arm64) BUN_TARGET=linux-arm64; BIN_NAME=pulse-linux-arm64 ;; \
         *) echo "Unsupported TARGETARCH: $TARGETARCH" >&2 && exit 1 ;; \
       esac \
    && bun run build/build.ts --target "$BUN_TARGET" \
    && mv "build/out/$BIN_NAME" build/out/pulse

# Official plugins ship inside the image, disabled by default: the
# entrypoint copies them into the data directory's plugins/ folder on
# every boot (so an upgrade updates them), and the instance owner
# switches them on from Instance → Plugins. Their enabled state lives in
# the database, never in these files.
RUN cd packages/plugins/discord-bridge && bun run build

# Stage 2: Runtime
FROM oven/bun:${BUN_VERSION}
COPY --from=builder /app/apps/server/build/out/pulse /pulse
COPY --from=builder /app/docker/pulse-entrypoint.sh /entrypoint.sh
COPY --from=builder /app/docker/healthcheck.ts /healthcheck.ts
COPY --from=builder /app/packages/plugins/discord-bridge/package.json \
                    /app/packages/plugins/discord-bridge/README.md \
                    /opt/pulse/plugins/discord-bridge/
COPY --from=builder /app/packages/plugins/discord-bridge/dist /opt/pulse/plugins/discord-bridge/dist
ENV RUNNING_IN_DOCKER=true

# The server runs as the unprivileged `pulse` user. The data directory
# stays at /root/.config/pulse so existing `./data/pulse:/root/.config/pulse`
# bind mounts keep working; the entrypoint (started as root) chowns that
# directory to `pulse` and drops privileges before exec'ing /pulse, which
# also covers bind mounts the Docker daemon creates root-owned on first
# boot. /root is opened for traversal only (0711) — nothing else lives there.
RUN useradd --system --user-group --no-create-home pulse \
    && mkdir -p /root/.config/pulse \
    && chown pulse:pulse /root/.config/pulse \
    && chmod 711 /root /root/.config \
    && chmod +x /pulse /entrypoint.sh

# The probe follows the configured port (PULSE_PORT, then config.ini,
# then 5443); the compose healthchecks run the same script. Node-free
# image tooling is `bun`, so it is a bun script rather than curl.
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=12 \
  CMD bun /healthcheck.ts

STOPSIGNAL SIGTERM
ENTRYPOINT ["/entrypoint.sh"]
