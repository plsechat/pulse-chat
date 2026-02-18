#!/bin/bash
set -euo pipefail

# Custom PostgreSQL entrypoint that wraps the default supabase/postgres entrypoint.
# Runs on EVERY container start (not just first boot) to ensure the
# supabase_auth_admin role password stays in sync with POSTGRES_PASSWORD.

# Forward signals to the postgres process for graceful shutdown
cleanup() {
  if [ -n "${PG_PID:-}" ]; then
    kill -TERM "$PG_PID" 2>/dev/null || true
    wait "$PG_PID" 2>/dev/null || true
  fi
  exit 0
}
trap cleanup SIGTERM SIGINT

# Start the real entrypoint in the background (preserves all supabase init scripts)
docker-entrypoint.sh postgres &
PG_PID=$!

# Wait for postgres to become ready (local socket, no password needed)
echo "db-entrypoint: waiting for PostgreSQL to accept connections..."
for i in $(seq 1 60); do
  if pg_isready -U postgres -q 2>/dev/null; then
    break
  fi
  if [ "$i" -eq 60 ]; then
    echo "db-entrypoint: ERROR — PostgreSQL did not become ready in 60s"
    exit 1
  fi
  sleep 1
done

# Set supabase_auth_admin password to match current POSTGRES_PASSWORD.
# Uses local socket (peer/trust auth) so this works even if the password changed.
echo "db-entrypoint: syncing supabase_auth_admin password..."
psql -U postgres -v password="$POSTGRES_PASSWORD" \
  -c "DO \$\$ BEGIN
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'supabase_auth_admin') THEN
      ALTER ROLE supabase_auth_admin WITH PASSWORD :'password';
    END IF;
  END \$\$;" 2>/dev/null && \
  echo "db-entrypoint: supabase_auth_admin password synced" || \
  echo "db-entrypoint: WARNING — could not sync auth password (role may not exist yet on first boot)"

# Signal that DB init is complete (used by healthcheck)
touch /tmp/.db-init-complete
echo "db-entrypoint: ready"

# Wait on the postgres process
wait "$PG_PID"
