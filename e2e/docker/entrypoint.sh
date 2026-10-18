#!/bin/bash
set -euo pipefail

# E2E entrypoint — writes config.ini from env BEFORE the app's first
# boot, then delegates env validation to the repo entrypoint's logic
# inline (DATABASE_URL/AUTH_SECRET) and starts the bun runtime.
#
# Env knobs (all optional):
#   PULSE_FEDERATION_ENABLED  "true" to enable federation (default false)
#   PULSE_FEDERATION_DOMAIN   this instance's dialable host[:port]
#   PULSE_PORT                HTTP port written into a NEW config.ini
#                             (default 4991; compose.upgrade.yml sets 5443
#                             so this image and the release image agree)
#
# The app only generates config.ini when it is missing, so writing it
# here wins the race deterministically — no post-boot sed + restart.
# An existing config.ini (a reused data volume) is left untouched, port
# included — exactly like the release image.

DATA_DIR=/app/apps/server/data
CONFIG_INI="$DATA_DIR/config.ini"

mkdir -p "$DATA_DIR"

if [ ! -f "$CONFIG_INI" ]; then
  cat > "$CONFIG_INI" <<EOF
[server]
port=${PULSE_PORT:-4991}
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

# Seed DATA_DIR/interface/<version> from the image's client bundle stash
# (see the Dockerfile). Skipped when the stamp already matches — that
# keeps a bundle hot-patched into a running container across restarts —
# and re-run when it differs, which is the upgrade case: the data volume
# carries the previous image's bundle under the same (or an older)
# version directory, and the new server must serve its own client, the
# way the release binary re-extracts interface.zip on every boot.
SEED_DIR=/app/interface-seed
INTERFACE_DIR="$DATA_DIR/interface/${PULSE_BUILD_VERSION:-0.0.0-dev}"
if [ -f "$SEED_DIR/.build-stamp" ]; then
  if [ ! -f "$INTERFACE_DIR/.build-stamp" ] \
    || ! cmp -s "$SEED_DIR/.build-stamp" "$INTERFACE_DIR/.build-stamp"; then
    rm -rf "$INTERFACE_DIR"
    mkdir -p "$INTERFACE_DIR"
    cp -R "$SEED_DIR/." "$INTERFACE_DIR/"
    echo "[e2e-entrypoint] seeded $INTERFACE_DIR (stamp $(cat "$SEED_DIR/.build-stamp"))"
  else
    echo "[e2e-entrypoint] $INTERFACE_DIR already carries this build"
  fi
fi

echo "[e2e-entrypoint] starting pulse (version=${PULSE_BUILD_VERSION:-unknown})"
# Official plugins ship with the image (built in the Dockerfile); copy them
# into the data directory on every boot so a fresh or reused volume has
# the current build. Shipped files are replaced, plugin state is kept.
PLUGIN_SRC=/app/packages/plugins
if [ -d "$PLUGIN_SRC" ]; then
  for dir in "$PLUGIN_SRC"/*/; do
    [ -f "$dir/package.json" ] || continue
    id=$(basename "$dir")
    mkdir -p "$DATA_DIR/plugins/$id/dist"
    cp "$dir/package.json" "$DATA_DIR/plugins/$id/package.json"
    [ -f "$dir/README.md" ] && cp "$dir/README.md" "$DATA_DIR/plugins/$id/README.md"
    [ -d "$dir/dist" ] && cp -R "$dir/dist/." "$DATA_DIR/plugins/$id/dist/"
    echo "[e2e-entrypoint] seeded plugin $id"
  done
fi

exec bun src/index.ts
