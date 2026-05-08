# Stage 1: Build
FROM oven/bun:1.3.5 AS builder
ARG TARGETARCH
WORKDIR /app
COPY . .
RUN bun install
RUN cd apps/server \
    && bun run /app/docker/patch-migrations.ts ./src/db/migrations
# Pick the bun build target that matches the *runtime* container arch.
# TARGETARCH is `amd64` on x86_64, `arm64` on Apple Silicon / aarch64.
# Without the match, the single-file executable is a foreign ELF that
# rosetta / qemu can't translate at exec time and the container
# restart-loops with `failed to open elf at /lib64/ld-...`.
RUN cd apps/server \
    && case "$TARGETARCH" in \
         amd64) bun run build/build.ts --target linux-x64 ;; \
         arm64) bun run build/build.ts --target linux-arm64 ;; \
         *) echo "Unsupported TARGETARCH: $TARGETARCH" >&2 && exit 1 ;; \
       esac \
    && mv build/out/pulse-linux-* build/out/pulse

# Stage 2: Runtime
FROM oven/bun:1.3.5
COPY --from=builder /app/apps/server/build/out/pulse /pulse
COPY --from=builder /app/docker/pulse-entrypoint.sh /entrypoint.sh
ENV RUNNING_IN_DOCKER=true

RUN chmod +x /pulse /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]
