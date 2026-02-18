# Stage 1: Build
FROM oven/bun:1.3.5 AS builder
WORKDIR /app
COPY . .
RUN bun install
RUN cd apps/server \
    && bunx drizzle-kit generate --dialect postgresql --schema ./src/db/schema.ts --out ./src/db/migrations \
    && cd src/db/migrations \
    && for f in 0000_*.sql; do [ -f "$f" ] && [ "$f" != "0000_initial.sql" ] && mv "$f" 0000_initial.sql; done \
    && sed -i 's/"tag": "0000_[^"]*"/"tag": "0000_initial"/g' meta/_journal.json
RUN cd apps/server && bun run build/build.ts --target linux-x64

# Stage 2: Runtime
FROM oven/bun:1.3.5
COPY --from=builder /app/apps/server/build/out/pulse-linux-x64 /pulse
ENV RUNNING_IN_DOCKER=true

RUN chmod +x /pulse
CMD ["/pulse"]
