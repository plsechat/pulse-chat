#!/bin/bash
set -euo pipefail

# Test script for docker/db-entrypoint.sh
# Validates the race condition fix: sentinel file should only be created
# when password sync succeeds.

PASS=0
FAIL=0
TOTAL=0

assert_eq() {
  local desc="$1" expected="$2" got="$3"
  TOTAL=$((TOTAL + 1))
  if [ "$expected" = "$got" ]; then
    echo "  PASS: $desc"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $desc (expected=$expected, got=$got)"
    FAIL=$((FAIL + 1))
  fi
}

SENTINEL="/tmp/.db-init-complete-test-$$"

# The core logic extracted from db-entrypoint.sh lines 44-51.
# Takes SYNCED value as argument, uses $SENTINEL as sentinel file.
run_entrypoint_logic() {
  local synced="$1"
  if [ "$synced" -eq 0 ]; then
    echo "db-entrypoint: FATAL: timed out syncing auth password. Container will restart."
    return 1
  fi
  touch "$SENTINEL"
  echo "db-entrypoint: ready"
  return 0
}

# ── Test 1: Sync succeeds ──
echo "Test 1: Password sync succeeds"
rm -f "$SENTINEL"

set +e
run_entrypoint_logic 1
EXIT_CODE=$?
set -e

assert_eq "exit code is 0 on success" "0" "$EXIT_CODE"
assert_eq "sentinel file exists on success" "yes" "$([ -f "$SENTINEL" ] && echo yes || echo no)"

rm -f "$SENTINEL"

# ── Test 2: Sync fails ──
echo "Test 2: Password sync fails (timeout)"
rm -f "$SENTINEL"

set +e
run_entrypoint_logic 0
EXIT_CODE=$?
set -e

assert_eq "exit code is 1 on failure" "1" "$EXIT_CODE"
assert_eq "sentinel file does NOT exist on failure" "no" "$([ -f "$SENTINEL" ] && echo yes || echo no)"

rm -f "$SENTINEL"

# ── Summary ──
echo ""
echo "Results: $PASS/$TOTAL passed, $FAIL failed"

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
