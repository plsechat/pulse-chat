# Stage 1: Build
FROM oven/bun:1.3.5 AS builder
WORKDIR /app
COPY . .
RUN bun install
RUN cd apps/server \
    && bunx drizzle-kit generate --dialect postgresql --schema ./src/db/schema.ts --out ./src/db/migrations \
    && cd src/db/migrations \
    && for f in 0000_*.sql; do [ -f "$f" ] && [ "$f" != "0000_initial.sql" ] && mv "$f" 0000_initial.sql; done \
    && sed -i 's/"tag": "0000_[^"]*"/"tag": "0000_initial"/g' meta/_journal.json \
    && sed -i 's/CREATE TABLE /CREATE TABLE IF NOT EXISTS /g' 0000_initial.sql \
    && sed -i 's/CREATE UNIQUE INDEX /CREATE UNIQUE INDEX IF NOT EXISTS /g' 0000_initial.sql \
    && sed -i 's/CREATE INDEX /CREATE INDEX IF NOT EXISTS /g' 0000_initial.sql \
    && sed -i 's/^\(ALTER TABLE .* ADD CONSTRAINT .*;\)--> statement-breakpoint$/DO $do$ BEGIN \1 EXCEPTION WHEN duplicate_object THEN NULL; END $do$;--> statement-breakpoint/' 0000_initial.sql
RUN cd apps/server && bun run build/build.ts --target linux-x64

# Stage 2: Runtime
FROM oven/bun:1.3.5
COPY --from=builder /app/apps/server/build/out/pulse-linux-x64 /pulse
ENV RUNNING_IN_DOCKER=true

RUN chmod +x /pulse
CMD ["/pulse"]
