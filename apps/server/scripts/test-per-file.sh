#!/usr/bin/env bash
#
# Run every server unit-test file in its own `bun test` process.
#
#   bash scripts/test-per-file.sh            # all src/**/*.test.ts, sorted
#   bash scripts/test-per-file.sh a.test.ts  # just the given file(s)
#
# Why one process per file (bun runs files sequentially in ONE process
# by default — there is no parallelism to avoid here):
#   - `mock.module()` is process-global and irreversible, and a
#     module-scope mutation of a shared mocked module (for example
#     `config.federation.enabled = true`) is visible to every file
#     loaded after it. Per-file processes make that state local. The
#     eslint guard forbids mock.module outside the preload files, and
#     setup.ts fails a run that leaks a fetch/dns stub, but process
#     isolation is the mechanism that keeps a slip from cascading.
#   - bun classifies a beforeEach/afterEach hook timeout as a hook-level
#     error: it prints `(fail)` but does not count it and exits 0. So a
#     file is failed on a non-zero exit OR any `(fail)` line in its
#     output. NEVER trust the exit code alone.
#
# Output is never truncated or filtered: every file's full output is
# printed. Exit status is non-zero if any file failed. Used by both the
# local `bun run test` and the CI test workflow so there is one gate.

set -u

cd "$(dirname "$0")/.." || exit 1

files=()
if [ "$#" -gt 0 ]; then
  files=("$@")
else
  while IFS= read -r file; do
    files+=("$file")
  done < <(find src -name '*.test.ts' | LC_ALL=C sort)
fi

if [ "${#files[@]}" -eq 0 ]; then
  echo "test-per-file: no test files found" >&2
  exit 1
fi

failed=()
for file in "${files[@]}"; do
  echo "=== $file"
  output_file=$(mktemp)
  # --timeout 15000 matches bunfig.toml [test] timeout; the default 5s
  # per-test budget (which includes beforeEach) turned brief between-test
  # lock waits into hook timeouts whose detached TRUNCATE+seed chains
  # corrupted the next reseed.
  bun test --timeout 15000 "$file" 2>&1 | tee "$output_file"
  bun_exit=${PIPESTATUS[0]}
  if [ "$bun_exit" -ne 0 ] || grep -qE '^\(fail\)' "$output_file"; then
    failed+=("$file (bun exit=$bun_exit)")
    echo "=== FAILED: $file (bun exit=$bun_exit)"
  fi
  rm -f "$output_file"
done

echo
echo "test-per-file: ran ${#files[@]} file(s), ${#failed[@]} failed"
if [ "${#failed[@]}" -gt 0 ]; then
  for f in "${failed[@]}"; do
    echo "  FAILED: $f"
  done
  exit 1
fi
exit 0
