#!/usr/bin/env bash
# test-concurrency-guard.sh — End-to-end concurrency guard tests.
#
# Exercises the REAL guard chain: wrapper -> lib-concurrency-guard.sh -> flock -> impl.
# Uses GOVIRAL_BIN_DIR, GOVIRAL_LOCK_DIR, GOVIRAL_METRICS_DIR overrides so
# tests run without root and without touching /usr/local/bin.
#
# Tests:
#   1. First invocation acquires lock and runs successfully
#   2. Overlapping invocation outputs overlap_skipped=true
#   3. Lock released after successful completion
#   4. Lock released after failure; implementation exit code propagated
#   5. Non-mutating commands bypass the lock entirely
#   6. Metrics JSONL emitted for completed, skipped, and failed runs
#   7. Recursive guard invocation rejected (exit 99)
#   8. Guard wrapper shells out through the lib (integration smoke)
#
# Usage: bash ops/goviral-control-plane/test-concurrency-guard.sh
# ──────────────────────────────────────────────────────────────────────────────
set -euo pipefail

PASS=0
FAIL=0
TEST_DIR="$(mktemp -d)"
GUARD_LIB="$(cd "$(dirname "$0")" && pwd)/lib-concurrency-guard.sh"

# Layout mirrors production:
#   $TEST_DIR/bin/              ← GOVIRAL_BIN_DIR
#   $TEST_DIR/locks/            ← GOVIRAL_LOCK_DIR
#   $TEST_DIR/metrics/          ← GOVIRAL_METRICS_DIR
BIN_DIR="${TEST_DIR}/bin"
LOCK_DIR="${TEST_DIR}/locks"
METRICS_DIR="${TEST_DIR}/metrics"

mkdir -p "$BIN_DIR" "$LOCK_DIR" "$METRICS_DIR"

export GOVIRAL_BIN_DIR="$BIN_DIR"
export GOVIRAL_LOCK_DIR="$LOCK_DIR"
export GOVIRAL_METRICS_DIR="$METRICS_DIR"

cleanup() {
  rm -rf "$TEST_DIR"
}
trap cleanup EXIT

# ── Create the test implementation (the "real script") ──────────────────────
cat > "$BIN_DIR/goviral-test-workflow" <<'IMPL'
#!/usr/bin/env bash
set -euo pipefail
if [ "${1:-}" = "run-all" ] && [ "${2:-}" = "--write" ]; then
  sleep 2
  echo "work_done=true"
  exit 0
fi
if [ "${1:-}" = "status" ]; then
  echo "status=ok"
  exit 0
fi
echo "unknown_command"
exit 0
IMPL
chmod +x "$BIN_DIR/goviral-test-workflow"

# ── Create a failing implementation ─────────────────────────────────────────
cat > "$BIN_DIR/goviral-test-workflow-fail" <<'IMPL'
#!/usr/bin/env bash
echo "error_detail=something_broke"
exit 42
IMPL
chmod +x "$BIN_DIR/goviral-test-workflow-fail"

# ── Create the guard wrapper (mirrors the real guard scripts) ───────────────
cat > "$BIN_DIR/goviral-test-workflow-guard" <<GUARD
#!/usr/bin/env bash
set -u -o pipefail
if [ "\${_GOVIRAL_GUARD_ACTIVE:-}" = "goviral-test-workflow" ]; then
  echo "ERROR: recursive guard invocation detected" >&2
  exit 99
fi
export _GOVIRAL_GUARD_ACTIVE="goviral-test-workflow"
source "${GUARD_LIB}"
concurrency_guard "goviral-test-workflow" "\$@"
GUARD
chmod +x "$BIN_DIR/goviral-test-workflow-guard"

# ── Helpers ─────────────────────────────────────────────────────────────────

pass() { echo "  PASS: $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL: $1 -- $2"; FAIL=$((FAIL + 1)); }

# ════════════════════════════════════════════════════════════════════════════
# Test 1: First invocation through the guard wrapper acquires lock and runs
# ════════════════════════════════════════════════════════════════════════════
echo "Test 1: Guard wrapper acquires lock and runs implementation"

rm -f "$LOCK_DIR/goviral-test-workflow.lock"
rm -f "$METRICS_DIR/goviral-test-workflow.jsonl"

output=$("$BIN_DIR/goviral-test-workflow-guard" run-all --write 2>&1)
rc=$?

if [ "$rc" -eq 0 ] && echo "$output" | grep -q "work_done=true"; then
  pass "guard wrapper completed, implementation output received"
else
  fail "guard wrapper first run" "rc=$rc output=$output"
fi

# ════════════════════════════════════════════════════════════════════════════
# Test 2: Overlapping invocation through guard wrapper → overlap_skipped=true
# ════════════════════════════════════════════════════════════════════════════
echo "Test 2: Overlapping guard invocation returns overlap_skipped=true"

rm -f "$LOCK_DIR/goviral-test-workflow.lock"

# Start a long-running guarded invocation in background
"$BIN_DIR/goviral-test-workflow-guard" run-all --write >/dev/null 2>&1 &
holder_pid=$!
sleep 0.5  # Let flock acquire

# Second guarded invocation should be skipped
overlap_output=$("$BIN_DIR/goviral-test-workflow-guard" run-all --write 2>&1)
overlap_rc=$?

if [ "$overlap_rc" -eq 0 ] && echo "$overlap_output" | grep -q "overlap_skipped=true"; then
  pass "overlapping invocation: overlap_skipped=true, exit 0"
else
  fail "overlapping invocation" "rc=$overlap_rc output=$overlap_output"
fi

kill "$holder_pid" 2>/dev/null; wait "$holder_pid" 2>/dev/null || true

# ════════════════════════════════════════════════════════════════════════════
# Test 3: Lock released after successful completion
# ════════════════════════════════════════════════════════════════════════════
echo "Test 3: Lock released after success — second sequential run succeeds"

rm -f "$LOCK_DIR/goviral-test-workflow.lock"

# First run (completes)
"$BIN_DIR/goviral-test-workflow-guard" run-all --write >/dev/null 2>&1
rc1=$?

# Second run (should succeed, not be blocked)
output2=$("$BIN_DIR/goviral-test-workflow-guard" run-all --write 2>&1)
rc2=$?

if [ "$rc1" -eq 0 ] && [ "$rc2" -eq 0 ] && echo "$output2" | grep -q "work_done=true"; then
  pass "lock released after success — second run completed"
else
  fail "lock release after success" "rc1=$rc1 rc2=$rc2 output2=$output2"
fi

# ════════════════════════════════════════════════════════════════════════════
# Test 4: Implementation failure propagates; lock released
# ════════════════════════════════════════════════════════════════════════════
echo "Test 4: Implementation errors propagate through guard"

rm -f "$LOCK_DIR/goviral-test-workflow.lock"

# Swap the impl to the failing one temporarily
cp "$BIN_DIR/goviral-test-workflow" "$BIN_DIR/goviral-test-workflow.real"
cp "$BIN_DIR/goviral-test-workflow-fail" "$BIN_DIR/goviral-test-workflow"

rc_fail=0
fail_output=$("$BIN_DIR/goviral-test-workflow-guard" run-all --write 2>&1) || rc_fail=$?

# Restore the real impl
cp "$BIN_DIR/goviral-test-workflow.real" "$BIN_DIR/goviral-test-workflow"

# Lock should be released — next guarded acquisition succeeds
rc_after=0
"$BIN_DIR/goviral-test-workflow-guard" run-all --write >/dev/null 2>&1 || rc_after=$?

if [ "$rc_fail" -eq 42 ] && [ "$rc_after" -eq 0 ]; then
  pass "exit code 42 propagated, lock released after failure"
else
  fail "error propagation" "rc_fail=$rc_fail rc_after=$rc_after"
fi

# ════════════════════════════════════════════════════════════════════════════
# Test 5: Non-mutating commands bypass the lock
# ════════════════════════════════════════════════════════════════════════════
echo "Test 5: Non-mutating 'status' command bypasses lock"

rm -f "$LOCK_DIR/goviral-test-workflow.lock"

# Hold the lock with a guarded long run
"$BIN_DIR/goviral-test-workflow-guard" run-all --write >/dev/null 2>&1 &
holder_pid=$!
sleep 0.5

# Non-mutating command through the guard should work (exec bypasses flock)
status_output=$("$BIN_DIR/goviral-test-workflow-guard" status 2>&1)
status_rc=$?

if [ "$status_rc" -eq 0 ] && echo "$status_output" | grep -q "status=ok"; then
  pass "non-mutating 'status' bypassed lock"
else
  fail "non-mutating bypass" "rc=$status_rc output=$status_output"
fi

kill "$holder_pid" 2>/dev/null; wait "$holder_pid" 2>/dev/null || true

# ════════════════════════════════════════════════════════════════════════════
# Test 6: Metrics JSONL emitted for each outcome
# ════════════════════════════════════════════════════════════════════════════
echo "Test 6: Metrics JSONL written for completed, skipped, and failed"

rm -f "$METRICS_DIR/goviral-test-workflow.jsonl"
rm -f "$LOCK_DIR/goviral-test-workflow.lock"

# Phase 1: Completed run
"$BIN_DIR/goviral-test-workflow-guard" run-all --write >/dev/null 2>&1

# Phase 2: Overlap-skipped run (need holder + contender)
rm -f "$LOCK_DIR/goviral-test-workflow.lock"
"$BIN_DIR/goviral-test-workflow-guard" run-all --write >/dev/null 2>&1 &
holder_pid=$!
sleep 0.5
"$BIN_DIR/goviral-test-workflow-guard" run-all --write >/dev/null 2>&1
kill "$holder_pid" 2>/dev/null; wait "$holder_pid" 2>/dev/null || true

# Phase 3: Failed run (clean lock to avoid stale contention from killed holder)
rm -f "$LOCK_DIR/goviral-test-workflow.lock"
cp "$BIN_DIR/goviral-test-workflow" "$BIN_DIR/goviral-test-workflow.real"
cp "$BIN_DIR/goviral-test-workflow-fail" "$BIN_DIR/goviral-test-workflow"
"$BIN_DIR/goviral-test-workflow-guard" run-all --write >/dev/null 2>&1 || true
cp "$BIN_DIR/goviral-test-workflow.real" "$BIN_DIR/goviral-test-workflow"

metrics_file="$METRICS_DIR/goviral-test-workflow.jsonl"
if [ -f "$metrics_file" ]; then
  has_completed=$(grep -c '"status":"completed"' "$metrics_file" || true)
  has_skipped=$(grep -c '"status":"overlap_skipped"' "$metrics_file" || true)
  has_failed=$(grep -c '"status":"failed"' "$metrics_file" || true)

  if [ "$has_completed" -ge 1 ] && [ "$has_skipped" -ge 1 ] && [ "$has_failed" -ge 1 ]; then
    pass "metrics contain completed, overlap_skipped, and failed entries"
  else
    fail "metrics content" "completed=$has_completed skipped=$has_skipped failed=$has_failed"
  fi
else
  fail "metrics file" "not created at $metrics_file"
fi

# ════════════════════════════════════════════════════════════════════════════
# Test 7: Recursive guard invocation rejected with exit 99
# ════════════════════════════════════════════════════════════════════════════
echo "Test 7: Recursive guard invocation rejected"

rc=0
_GOVIRAL_GUARD_ACTIVE="goviral-test-workflow" \
  "$BIN_DIR/goviral-test-workflow-guard" status 2>/dev/null || rc=$?

if [ "$rc" -eq 99 ]; then
  pass "recursive invocation rejected with exit 99"
else
  fail "recursive guard" "expected exit 99, got $rc"
fi

# ════════════════════════════════════════════════════════════════════════════
# Test 8: Guard wrapper integration — end-to-end smoke through real lib
# ════════════════════════════════════════════════════════════════════════════
echo "Test 8: Guard wrapper → lib → flock → impl integration smoke"

rm -f "$LOCK_DIR/goviral-test-workflow.lock"
rm -f "$METRICS_DIR/goviral-test-workflow.jsonl"

# Full end-to-end: the guard sources the real lib, which flocks, which execs the impl
output=$("$BIN_DIR/goviral-test-workflow-guard" run-all --write 2>&1)
rc=$?

# Verify the entire chain worked
chain_ok=true
[ "$rc" -eq 0 ] || chain_ok=false
echo "$output" | grep -q "work_done=true" || chain_ok=false
[ -f "$METRICS_DIR/goviral-test-workflow.jsonl" ] || chain_ok=false
grep -q '"status":"completed"' "$METRICS_DIR/goviral-test-workflow.jsonl" 2>/dev/null || chain_ok=false

if [ "$chain_ok" = true ]; then
  pass "full chain: guard -> lib -> flock -> impl -> metrics"
else
  fail "integration smoke" "rc=$rc output=$output"
fi

# ── Summary ─────────────────────────────────────────────────────────────────
echo
echo "════════════════════════════════════════════"
echo "  Results: ${PASS} passed, ${FAIL} failed"
echo "════════════════════════════════════════════"

[ "$FAIL" -eq 0 ] && exit 0 || exit 1
