#!/bin/bash
set -euo pipefail

# E2E entrypoint — writes config.ini from env BEFORE the app's first
# boot, then delegates env validation to the repo entrypoint's logic
# inline (DATABASE_URL/AUTH_SECRET) and starts the bun runtime.
#
# Env knobs (all optional):
#   PULSE_FEDERATION_ENABLED  "true" to enable federation (default false)
#   PULSE_FEDERATION_DOMAIN   this instance's dialable host[:port]
#
# The app only generates config.ini when it is missing, so writing it
# here wins the race deterministically — no post-boot sed + restart.

DATA_DIR=/app/apps/server/data
CONFIG_INI="$DATA_DIR/config.ini"

mkdir -p "$DATA_DIR"

if [ ! -f "$CONFIG_INI" ]; then
  cat > "$CONFIG_INI" <<EOF
[server]
port=4991
debug=true
autoupdate=false
debugLogMaxSizeMb=200
debugLogMaxFiles=10
debugLogIncludeBody=true

[http]
maxFiles=40
maxFileSize=100

[mediasoup.worker]
rtcMinPort=40000
rtcMaxPort=40020

[mediasoup.audio]
maxBitrate=510000
stereo=true
fec=true
dtx=true

[mediasoup.video]
initialAvailableOutgoingBitrate=6000000

[federation]
enabled=${PULSE_FEDERATION_ENABLED:-false}
domain=${PULSE_FEDERATION_DOMAIN:-}
EOF
  echo "[e2e-entrypoint] wrote $CONFIG_INI (federation=${PULSE_FEDERATION_ENABLED:-false} domain=${PULSE_FEDERATION_DOMAIN:-})"
fi

if [ -z "${DATABASE_URL:-}" ]; then
  echo "ERROR: DATABASE_URL is not set" >&2
  exit 1
fi

if [ -z "${AUTH_SECRET:-}" ] || [ "${#AUTH_SECRET}" -lt 32 ]; then
  echo "ERROR: AUTH_BACKEND=local requires AUTH_SECRET (>= 32 chars)" >&2
  exit 1
fi

# PULSE_BUILD_VERSION must match the seeded interface dir (written at
# image build time by the Dockerfile).
if [ -f /pulse-version.env ]; then
  # shellcheck disable=SC1091
  set -a && . /pulse-version.env && set +a
fi

echo "[e2e-entrypoint] starting pulse (version=${PULSE_BUILD_VERSION:-unknown})"
exec bun src/index.ts
