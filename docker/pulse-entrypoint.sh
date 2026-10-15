#!/bin/bash
set -euo pipefail

# Validate required environment variables before starting Pulse.
# Fail fast with clear errors instead of cryptic runtime crashes.

MISSING=0

# DATABASE_URL is always required.
if [ -z "${DATABASE_URL:-}" ]; then
  echo "ERROR: Required environment variable DATABASE_URL is not set" >&2
  MISSING=1
fi

# Auth backend selection mirrors apps/server/src/utils/auth/index.ts:
#   AUTH_BACKEND=local      → AUTH_SECRET required, no Supabase vars needed
#   AUTH_BACKEND=supabase   → SUPABASE_URL/ANON_KEY/SERVICE_ROLE_KEY required
#   unset + SUPABASE_URL set → infers supabase
#   unset + no SUPABASE_URL → infers local (AUTH_SECRET still required)
AUTH_BACKEND_RESOLVED="${AUTH_BACKEND:-}"
if [ -z "$AUTH_BACKEND_RESOLVED" ]; then
  if [ -n "${SUPABASE_URL:-}" ] && [ -n "${SUPABASE_SERVICE_ROLE_KEY:-}" ]; then
    AUTH_BACKEND_RESOLVED="supabase"
  else
    AUTH_BACKEND_RESOLVED="local"
  fi
fi

case "$AUTH_BACKEND_RESOLVED" in
  local)
    if [ -z "${AUTH_SECRET:-}" ] || [ "${#AUTH_SECRET}" -lt 32 ]; then
      echo "ERROR: AUTH_BACKEND=local requires AUTH_SECRET (>= 32 chars)" >&2
      MISSING=1
    fi
    ;;
  supabase)
    for VAR in SUPABASE_URL SUPABASE_ANON_KEY SUPABASE_SERVICE_ROLE_KEY; do
      if [ -z "${!VAR:-}" ]; then
        echo "ERROR: AUTH_BACKEND=supabase requires $VAR" >&2
        MISSING=1
      fi
    done
    ;;
  *)
    echo "ERROR: Unknown AUTH_BACKEND value '$AUTH_BACKEND_RESOLVED' — expected 'local' or 'supabase'" >&2
    MISSING=1
    ;;
esac

if [ "$MISSING" -eq 1 ]; then
  echo "Exiting — set the missing variable(s) in your .env file and restart." >&2
  exit 1
fi

echo "[entrypoint] AUTH_BACKEND=$AUTH_BACKEND_RESOLVED"

# Drop privileges. The image starts this script as root so a bind-mounted
# data directory (created root-owned by the daemon on first boot, or left
# over from a pre-non-root image) can be handed to the `pulse` user before
# the server opens it. The chown walks the tree only when the top-level
# directory is not already owned by `pulse`, so steady-state restarts cost
# one stat.
# DATA_PATH derives from $HOME (~/.config/pulse); pin it so the path is the
# same whichever uid the container was started with.
export HOME=/root
PULSE_DATA_DIR=/root/.config/pulse
if [ "$(id -u)" -eq 0 ]; then
  mkdir -p "$PULSE_DATA_DIR"
  if [ "$(stat -c %U "$PULSE_DATA_DIR")" != "pulse" ]; then
    echo "[entrypoint] chown $PULSE_DATA_DIR -> pulse"
    chown -R pulse:pulse "$PULSE_DATA_DIR"
  fi
  # coreutils chroot (no-op root, --userspec) is the drop mechanism on
  # purpose: setpriv/runuser/su hand the bun runtime an empty process.env
  # after the uid switch (verified against oven/bun 1.3.9), while this
  # path preserves it. Ports below 1024 are not bindable after the drop;
  # the default 5443 and a reverse proxy are the documented layout.
  exec chroot --userspec=pulse:pulse --groups=pulse / /pulse
fi

exec /pulse
