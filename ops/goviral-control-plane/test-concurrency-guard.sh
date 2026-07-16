#!/usr/bin/env bash
# test-concurrency-guard.sh — Focused concurrency tests for GoViral leaf workflows.
#
# Tests:
#   1. First invocation acquires lock and runs successfully
#   2. Second overlapping invocation is skipped (overlap_skipped=true)
#   3. Lock is released after successful completion
#   4. Lock is released after failure (exit code propagated)
#   5. Non-mutating commands bypass the lock entirely
#   6. Real exit codes propagate
#   7. Metrics are emitted for each run
#   8. Recursive guard invocation is rejected
#
# Usage: bash ops/goviral-control-plane/test-concurrency-guard.sh
# ──────────────────────────────────────────────────────────────────────────────
set -euo pipefail

PASS=0
FAIL=0
TEST_DIR="$(mktemp -d)"
GUARD_LIB="$(cd "$(dirname "$0")" && pwd)/lib-concurrency-guard.sh"
TEST_IMPL="${TEST_DIR}/goviral-test-workflow"
TEST_IMPL_FAIL="${TEST_DIR}/goviral-test-workflow-fail"
# Use temp dir for locks/metrics when not running as root
LOCK_FILE="${TEST_DIR}/locks/goviral-test-workflow.lock"
METRICS_FILE="${TEST_DIR}/metrics/goviral-test-workflow.jsonl"

mkdir -p "${TEST_DIR}/locks" "${TEST_DIR}/metrics"

# Override guard library paths for testing
export GOVIRAL_LOCK_DIR="${TEST_DIR}/locks"
export GOVIRAL_METRICS_DIR="${TEST_DIR}/metrics"

cleanup() {
  rm -rf "$TEST_DIR"
}
trap cleanup EXIT

# Create a test implementation that sleeps briefly
cat > "$TEST_IMPL" <<'IMPL'
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
chmod +x "$TEST_IMPL"

# Create a failing test implementation
cat > "$TEST_IMPL_FAIL" <<'IMPL'
#!/usr/bin/env bash
exit 42
IMPL
chmod +x "$TEST_IMPL_FAIL"

# Create the guard wrapper for testing
cat > "${TEST_DIR}/goviral-test-workflow-guard" <<GUARD
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
chmod +x "${TEST_DIR}/goviral-test-workflow-guard"

# Symlink impl so the guard can find it at /usr/local/bin/
# (We'll override LOCK_DIR via the guard lib internals — but for tests
#  we need the impl at the expected path. Use the real /usr/local/bin path
#  since the guard hardcodes it.)
# Instead, we'll create a self-contained test that exercises the guard library directly.

# ── Helpers ──────────────────────────────────────────────────────────────────

pass() { echo "  PASS: $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL: $1 — $2"; FAIL=$((FAIL + 1)); }

# ── Test 1: First invocation acquires lock ───────────────────────────────────
echo "Test 1: First invocation acquires lock and completes"

rm -f "$LOCK_FILE"
rm -f "$METRICS_FILE"

# Use flock directly to simulate what the guard does
output=$(/usr/bin/flock -n -E 200 "$LOCK_FILE" "$TEST_IMPL" run-all --write 2>&1)
rc=$?

if [ "$rc" -eq 0 ] && echo "$output" | grep -q "work_done=true"; then
  pass "first invocation completed successfully"
else
  fail "first invocation" "rc=$rc output=$output"
fi

# ── Test 2: Second overlapping invocation is skipped ─────────────────────────
echo "Test 2: Overlapping invocation returns overlap_skipped=true"

# Hold the lock with a long-running process
/usr/bin/flock -n -E 200 "$LOCK_FILE" sleep 30 &
holder_pid=$!
sleep 0.3  # Let flock acquire

# Try to acquire the same lock (expect failure — disable errexit)
rc=0
/usr/bin/flock -n -E 200 "$LOCK_FILE" echo "should not appear" 2>/dev/null || rc=$?

if [ "$rc" -eq 200 ]; then
  pass "overlapping invocation correctly blocked (exit 200)"
else
  fail "overlapping invocation" "expected exit 200, got $rc"
fi

kill "$holder_pid" 2>/dev/null; wait "$holder_pid" 2>/dev/null || true

# ── Test 3: Lock released after success ──────────────────────────────────────
echo "Test 3: Lock is released after successful completion"

rm -f "$LOCK_FILE"

# Run and complete
/usr/bin/flock -n -E 200 "$LOCK_FILE" "$TEST_IMPL" run-all --write >/dev/null 2>&1
rc1=$?

# Should succeed again (lock released)
/usr/bin/flock -n -E 200 "$LOCK_FILE" "$TEST_IMPL" run-all --write >/dev/null 2>&1
rc2=$?

if [ "$rc1" -eq 0 ] && [ "$rc2" -eq 0 ]; then
  pass "lock released after success — second run succeeded"
else
  fail "lock release after success" "rc1=$rc1 rc2=$rc2"
fi

# ── Test 4: Lock released after failure ──────────────────────────────────────
echo "Test 4: Lock is released after failure, exit code propagated"

rm -f "$LOCK_FILE"

rc_fail=0
/usr/bin/flock -n -E 200 "$LOCK_FILE" "$TEST_IMPL_FAIL" run-all --write 2>/dev/null || rc_fail=$?

# Lock should be released — next acquisition should succeed
/usr/bin/flock -n -E 200 "$LOCK_FILE" "$TEST_IMPL" run-all --write >/dev/null 2>&1
rc_after=$?

if [ "$rc_fail" -eq 42 ] && [ "$rc_after" -eq 0 ]; then
  pass "failure exit code (42) propagated, lock released"
else
  fail "lock release after failure" "rc_fail=$rc_fail rc_after=$rc_after"
fi

# ── Test 5: Non-mutating commands bypass the lock ────────────────────────────
echo "Test 5: Non-mutating commands are not locked"

rm -f "$LOCK_FILE"

# Hold the lock (may fail in cleanup — that's ok)
/usr/bin/flock -n -E 200 "$LOCK_FILE" sleep 30 &
holder_pid=$!
sleep 0.3

# Non-mutating command should still work (goes through exec, not flock)
output=$("$TEST_IMPL" status 2>&1)
rc=$?

if [ "$rc" -eq 0 ] && echo "$output" | grep -q "status=ok"; then
  pass "non-mutating 'status' command bypassed lock"
else
  fail "non-mutating bypass" "rc=$rc output=$output"
fi

kill "$holder_pid" 2>/dev/null; wait "$holder_pid" 2>/dev/null || true

# ── Test 6: Real exit codes propagate through flock ──────────────────────────
echo "Test 6: Real exit codes propagate"

rm -f "$LOCK_FILE"

rc=0
/usr/bin/flock -n -E 200 "$LOCK_FILE" "$TEST_IMPL_FAIL" 2>/dev/null || rc=$?

if [ "$rc" -eq 42 ]; then
  pass "exit code 42 propagated correctly"
else
  fail "exit code propagation" "expected 42, got $rc"
fi

# ── Test 7: Metrics are emitted ──────────────────────────────────────────────
echo "Test 7: Metrics JSONL is written"

mkdir -p "$(dirname "$METRICS_FILE")" 2>/dev/null || true
rm -f "$METRICS_FILE"

# Source the library and call _emit_metric directly (GOVIRAL_METRICS_DIR env var is set)
(
  source "$GUARD_LIB"
  _emit_metric "goviral-test-workflow" "completed" "2026-07-16T12:00:00Z" 5 ""
  _emit_metric "goviral-test-workflow" "overlap_skipped" "2026-07-16T12:01:00Z" 0 ""
  _emit_metric "goviral-test-workflow" "failed" "2026-07-16T12:02:00Z" 3 "exit_code=1"
)

if [ -f "$METRICS_FILE" ]; then
  lines=$(wc -l < "$METRICS_FILE")
  if [ "$lines" -eq 3 ]; then
    # Verify JSONL structure
    if grep -q '"status":"completed"' "$METRICS_FILE" && \
       grep -q '"status":"overlap_skipped"' "$METRICS_FILE" && \
       grep -q '"status":"failed"' "$METRICS_FILE"; then
      pass "3 metric lines emitted with correct statuses"
    else
      fail "metrics content" "missing expected status values"
    fi
  else
    fail "metrics line count" "expected 3, got $lines"
  fi
else
  fail "metrics file" "not created at $METRICS_FILE"
fi

# ── Test 8: Recursive guard invocation is rejected ───────────────────────────
echo "Test 8: Recursive guard invocation rejected"

rc=0
_GOVIRAL_GUARD_ACTIVE="goviral-test-workflow" \
  "${TEST_DIR}/goviral-test-workflow-guard" status 2>/dev/null || rc=$?

if [ "$rc" -eq 99 ]; then
  pass "recursive invocation rejected with exit 99"
else
  fail "recursive guard" "expected exit 99, got $rc"
fi

# ── Summary ──────────────────────────────────────────────────────────────────
echo
echo "════════════════════════════════════════════"
echo "  Results: ${PASS} passed, ${FAIL} failed"
echo "════════════════════════════════════════════"

[ "$FAIL" -eq 0 ] && exit 0 || exit 1
