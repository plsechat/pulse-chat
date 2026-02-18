#!/bin/bash
# Runs during first-time database initialization (after supabase/postgres init scripts).
# Sets supabase_auth_admin password to match POSTGRES_PASSWORD so GoTrue can connect.
psql -v ON_ERROR_STOP=0 --username postgres --dbname postgres <<-EOSQL
    ALTER ROLE supabase_auth_admin WITH PASSWORD '${POSTGRES_PASSWORD}';
EOSQL
