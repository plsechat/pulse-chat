#!/usr/bin/env bash
set -euo pipefail

# Upgrade smoke: boot the PREVIOUS release image on fresh named volumes,
# seed it through the real client, stop it, start the NEW image on the
# same volumes, verify. The operator's `docker compose pull && up -d`,
# end to end. Used by .github/workflows/e2e-upgrade.yml and locally:
#
#   bash e2e/docker/upgrade-smoke.sh <old-image> <new-image> [expected-version]
#
# e.g. bash e2e/docker/upgrade-smoke.sh ghcr.io/plsechat/pulse-chat:latest pulse-e2e:upgrade-new
#
# expected-version defaults to apps/server/package.json (what the e2e
# Dockerfile bakes into the new image). Env:
#   UPGRADE_HOST_PORT   host port for the instance (default 14997; the
#                       review stack owns 1499[1-5], never reuse those)
#   KEEP_UPGRADE_STACK  "1" leaves the containers + volumes up afterwards
#                       (inspect with PULSE_IMAGE=x docker compose -f
#                       e2e/docker/compose.upgrade.yml ...)

if [ $# -lt 2 ]; then
  echo "usage: $0 <old-image> <new-image> [expected-new-version]" >&2
  exit 2
fi

OLD_IMAGE=$1
NEW_IMAGE=$2
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
E2E_DIR=$(dirname "$HERE")
COMPOSE_FILE="$HERE/compose.upgrade.yml"
PORT=${UPGRADE_HOST_PORT:-14997}
EXPECT_VERSION=${3:-$(node -p "require('$E2E_DIR/../apps/server/package.json').version")}
export UPGRADE_HOST_PORT="$PORT"

compose() {
  # $1 = the image compose should resolve PULSE_IMAGE to for this call.
  PULSE_IMAGE="$1" docker compose -f "$COMPOSE_FILE" "${@:2}"
}

# The image to pass to compose for lifecycle calls after the swap — the
# last one we told it about, so `logs`/`down` never recreate anything.
CURRENT_IMAGE=$OLD_IMAGE

cleanup() {
  local status=$?
  if [ "$status" -ne 0 ]; then
    echo "== upgrade smoke FAILED (exit $status) — instance logs:" >&2
    compose "$CURRENT_IMAGE" logs --tail 200 pulse-core >&2 || true
  fi
  if [ "${KEEP_UPGRADE_STACK:-0}" = "1" ]; then
    echo "== KEEP_UPGRADE_STACK=1: leaving pulse-e2e-upgrade up"
  else
    compose "$CURRENT_IMAGE" down -v --remove-orphans >/dev/null 2>&1 || true
  fi
  exit "$status"
}
trap cleanup EXIT

wait_for_info() {
  local i
  for i in $(seq 1 60); do
    if curl -sf "http://127.0.0.1:${PORT}/info" >/dev/null; then
      return 0
    fi
    sleep 2
  done
  echo "http://127.0.0.1:${PORT}/info never became ready" >&2
  return 1
}

report_version() {
  echo "== $1 reports: $(curl -sf "http://127.0.0.1:${PORT}/info" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log(JSON.parse(d).version))')"
}

echo "== phase 1: fresh volumes, old image $OLD_IMAGE"
compose "$OLD_IMAGE" down -v --remove-orphans >/dev/null 2>&1 || true
compose "$OLD_IMAGE" up -d --wait
wait_for_info
report_version "old image"
(cd "$E2E_DIR" && UPGRADE_PHASE=seed npx playwright test --project=upgrade)

echo "== swap: stop pulse-core, keep the volumes, start $NEW_IMAGE"
compose "$OLD_IMAGE" stop pulse-core
CURRENT_IMAGE=$NEW_IMAGE
compose "$NEW_IMAGE" up -d --wait pulse-core
wait_for_info
report_version "new image"

echo "== phase 2: verify on the new image (expecting version $EXPECT_VERSION)"
(cd "$E2E_DIR" && UPGRADE_PHASE=verify UPGRADE_EXPECT_VERSION="$EXPECT_VERSION" npx playwright test --project=upgrade)

echo "== upgrade smoke passed: $OLD_IMAGE -> $NEW_IMAGE"
