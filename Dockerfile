# Stage 1: Build
FROM oven/bun:1.3.5 AS builder
WORKDIR /app
COPY . .
RUN bun install
RUN cd apps/server \
    && bunx drizzle-kit generate --dialect postgresql --schema ./src/db/schema.ts --out ./src/db/migrations \
    && bun run /app/docker/patch-migrations.ts ./src/db/migrations
RUN cd apps/server && bun run build/build.ts --target linux-x64

# Stage 2: Runtime
FROM oven/bun:1.3.5
COPY --from=builder /app/apps/server/build/out/pulse-linux-x64 /pulse
COPY --from=builder /app/docker/pulse-entrypoint.sh /entrypoint.sh
ENV RUNNING_IN_DOCKER=true

RUN chmod +x /pulse /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]
