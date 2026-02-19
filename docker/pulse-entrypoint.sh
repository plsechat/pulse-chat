#!/bin/bash
set -euo pipefail

# Validate required environment variables before starting Pulse.
# Fail fast with clear errors instead of cryptic runtime crashes.

MISSING=0
for VAR in DATABASE_URL SUPABASE_URL SUPABASE_ANON_KEY SUPABASE_SERVICE_ROLE_KEY; do
  if [ -z "${!VAR:-}" ]; then
    echo "ERROR: Required environment variable $VAR is not set" >&2
    MISSING=1
  fi
done

if [ "$MISSING" -eq 1 ]; then
  echo "Exiting — set the missing variable(s) in your .env file and restart." >&2
  exit 1
fi

exec /pulse
