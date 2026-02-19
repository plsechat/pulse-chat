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

# Start the real entrypoint in the background.
# -c listen_addresses='*' ensures postgres binds to all interfaces
# (required for Docker networking — without this, it only listens on localhost).
docker-entrypoint.sh postgres -c listen_addresses='*' &
PG_PID=$!

# Wait for postgres AND successfully sync the auth password.
# pg_isready can briefly pass during the init phase, so we loop until
# the ALTER ROLE actually succeeds (meaning the real postgres is up and
# the supabase_auth_admin role exists).
echo "db-entrypoint: waiting for PostgreSQL and syncing auth password..."
SYNCED=0
for i in $(seq 1 90); do
  if pg_isready -U postgres -q 2>/dev/null; then
    if psql -v ON_ERROR_STOP=0 --username postgres --dbname postgres <<-EOSQL 2>/dev/null
      ALTER ROLE supabase_auth_admin WITH PASSWORD '${POSTGRES_PASSWORD}';
EOSQL
    then
      echo "db-entrypoint: supabase_auth_admin password synced"
      SYNCED=1
      break
    fi
  fi
  sleep 1
done

if [ "$SYNCED" -eq 0 ]; then
  echo "db-entrypoint: WARNING — timed out syncing auth password (role may not exist yet on first boot)"
fi

# Signal that DB init is complete (used by healthcheck)
touch /tmp/.db-init-complete
echo "db-entrypoint: ready"

# Wait on the postgres process
wait "$PG_PID"
