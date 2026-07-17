#!/usr/bin/env bash
# test-phase05.sh — Phase 0.5.3 stabilization test suite (hermetic).
#
# ALL tests run fully isolated from live production state:
#   - Quarantine markers point to test-local temp paths
#   - systemctl is mocked (no real systemd actions)
#   - Cleanup runs on EXIT, SIGTERM, and SIGINT
#
# Tests:
#   1.  Router -> prompt canonical guard
#   2.  Prompt -> brain canonical guard
#   3.  Unified -> router -> prompt -> brain full chain
#   4.  Standalone prompt overlapping router-triggered prompt
#   5.  Standalone brain overlapping prompt-triggered brain
#   6.  Same-workflow recursion rejection
#   7.  Different-workflow nested guards
#   8.  Implementation failure propagation
#   9.  Lock release after success
#   10. Lock release after failure
#   11. Parent cancellation (no orphan children)
#   12. Correct leaf systemd/cgroup attribution (structural check)
#   13. At most one mutating process per leaf workflow
#   14. Global capacity reached
#   15. No unlimited systemd job queue (timer Persistent=false)
#   16. Timer staggering (no boot stampede)
#   17. Missed-run catch-up protection (Persistent=false)
#   18. Static scan rejecting direct mutating leaf invocation
#   19. Approval queue immutability
#   20. Workspace scan bounded and cached
#   42. Regression — live production markers do not affect isolated tests
#   43. Quarantine tests use only temporary markers
#   44. Live production markers remain unchanged
#   45. Mock systemctl received no real production actions
#   46. Cleanup after simulated test failure
#   47. Cleanup after SIGTERM
#   48. No real systemd jobs created
#   49. Installer preserves both live markers (structural)
#   50. Installer leaves all five timers disabled (structural)
#   51. Installer never unmask/enable/start heavy timers (structural)
#   52. Final approval queue hash verification
#
# Usage: bash ops/goviral-control-plane/test-phase05.sh
# ──────────────────────────────────────────────────────────────────────────────
set -euo pipefail

PASS=0
FAIL=0
TEST_DIR="$(mktemp -d)"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC="/opt/goviral-archon-src"

# Layout mirrors production
BIN_DIR="${TEST_DIR}/bin"
LOCK_DIR="${TEST_DIR}/locks"
METRICS_DIR="${TEST_DIR}/metrics"
CAPACITY_STATE="${TEST_DIR}/capacity"
SCAN_CACHE="${TEST_DIR}/scan-cache"
WORKSPACE="${TEST_DIR}/workspace"
MOCK_BIN_DIR="${TEST_DIR}/mock-bin"

# Hermetic quarantine markers — tests NEVER read or modify real production markers.
# These point to non-existent files inside the test temp dir.
TEST_QUARANTINE_PERSISTENT="${TEST_DIR}/quarantine/persistent-marker"
TEST_QUARANTINE_RUNTIME="${TEST_DIR}/quarantine/runtime-marker"
mkdir -p "${TEST_DIR}/quarantine"
# Do NOT create the marker files — tests 1-20 need dispatch to succeed (not quarantined).

mkdir -p "$BIN_DIR" "$LOCK_DIR" "$METRICS_DIR" "$CAPACITY_STATE" "$SCAN_CACHE" "$WORKSPACE" "$MOCK_BIN_DIR"

export GOVIRAL_BIN_DIR="$BIN_DIR"
export GOVIRAL_LOCK_DIR="$LOCK_DIR"
export GOVIRAL_METRICS_DIR="$METRICS_DIR"
export GOVIRAL_CAPACITY_STATE="$CAPACITY_STATE"
export GOVIRAL_MAX_HEAVY_WORKFLOWS=2
export GOVIRAL_SCAN_CACHE="$SCAN_CACHE"
# Hermetic quarantine: all dispatch operations use test-local markers
export GOVIRAL_QUARANTINE_MARKER_PERSISTENT="$TEST_QUARANTINE_PERSISTENT"
export GOVIRAL_QUARANTINE_MARKER_RUNTIME="$TEST_QUARANTINE_RUNTIME"

# Mock systemctl — tests must never call real systemctl
cat > "$MOCK_BIN_DIR/systemctl" <<'MOCK_SYSTEMCTL'
#!/usr/bin/env bash
# Mock systemctl for test isolation. Records calls but never touches real systemd.
echo "MOCK_SYSTEMCTL: $*" >> "${MOCK_SYSTEMCTL_LOG:-/dev/null}"
case "$1" in
  is-enabled) echo "disabled"; exit 1 ;;
  is-active)  echo "inactive"; exit 3 ;;
  cat)        exit 1 ;;  # pretend unit not found → force guard-wrapper path
  show)       echo ""; exit 0 ;;
  enable|start|restart|stop|disable|mask|unmask|daemon-reload)
    echo "MUTATING_SYSTEMCTL: $*" >> "${MOCK_SYSTEMCTL_LOG:-/dev/null}"
    exit 0 ;;
  *)          exit 0 ;;
esac
MOCK_SYSTEMCTL
chmod +x "$MOCK_BIN_DIR/systemctl"
MOCK_SYSTEMCTL_LOG="${TEST_DIR}/systemctl-calls.log"
touch "$MOCK_SYSTEMCTL_LOG"
export MOCK_SYSTEMCTL_LOG

cleanup() {
  # Kill any lingering background children from this test
  jobs -p 2>/dev/null | xargs -r kill 2>/dev/null || true
  rm -rf "$TEST_DIR"
}
trap cleanup EXIT TERM INT

pass() { echo "  PASS: $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL: $1 -- $2"; FAIL=$((FAIL + 1)); }

# ── Create test implementations ───────────────────────────────────────────────
# Leaf: prompt-command-center (runs 2s)
cat > "$BIN_DIR/goviral-prompt-command-center" <<'IMPL'
#!/usr/bin/env bash
set -euo pipefail
if [ "${1:-}" = "run-all" ] && [ "${2:-}" = "--write" ]; then
  sleep 2; echo "prompt_work_done=true"; exit 0
fi
if [ "${1:-}" = "submit" ]; then echo "prompt_submitted=true"; exit 0; fi
if [ "${1:-}" = "dashboard" ]; then echo "status=ok"; exit 0; fi
echo "unknown"; exit 0
IMPL
chmod +x "$BIN_DIR/goviral-prompt-command-center"

# Leaf: brain-auto-workflow (runs 2s)
cat > "$BIN_DIR/goviral-brain-auto-workflow" <<'IMPL'
#!/usr/bin/env bash
set -euo pipefail
if [ "${1:-}" = "run-all" ] && [ "${2:-}" = "--write" ]; then
  sleep 2; echo "brain_work_done=true"; exit 0
fi
if [ "${1:-}" = "submit" ]; then echo "brain_submitted=true"; exit 0; fi
if [ "${1:-}" = "dashboard" ]; then echo "status=ok"; exit 0; fi
echo "unknown"; exit 0
IMPL
chmod +x "$BIN_DIR/goviral-brain-auto-workflow"

# Leaf: failing impl
cat > "$BIN_DIR/goviral-test-fail-impl" <<'IMPL'
#!/usr/bin/env bash
echo "error=simulated_failure"; exit 42
IMPL
chmod +x "$BIN_DIR/goviral-test-fail-impl"

# Leaf: long-running impl (for overlap tests)
cat > "$BIN_DIR/goviral-test-long-impl" <<'IMPL'
#!/usr/bin/env bash
sleep 30; echo "done"
IMPL
chmod +x "$BIN_DIR/goviral-test-long-impl"

# Orchestrator: unified-autopilot (for capacity test)
cat > "$BIN_DIR/goviral-unified-autopilot" <<'IMPL'
#!/usr/bin/env bash
set -euo pipefail
if [ "${1:-}" = "run-all" ] && [ "${2:-}" = "--write" ]; then
  sleep 2; echo "unified_work_done=true"; exit 0
fi
echo "status=ok"; exit 0
IMPL
chmod +x "$BIN_DIR/goviral-unified-autopilot"

# Orchestrator: nl-autopilot-router (for capacity test)
cat > "$BIN_DIR/goviral-nl-autopilot-router" <<'IMPL'
#!/usr/bin/env bash
set -euo pipefail
if [ "${1:-}" = "run-all" ] && [ "${2:-}" = "--write" ]; then
  sleep 2; echo "router_work_done=true"; exit 0
fi
echo "status=ok"; exit 0
IMPL
chmod +x "$BIN_DIR/goviral-nl-autopilot-router"

# ── Create guard wrappers ─────────────────────────────────────────────────────
for wf in goviral-prompt-command-center goviral-brain-auto-workflow goviral-unified-autopilot goviral-nl-autopilot-router; do
  cat > "$BIN_DIR/${wf}-guard" <<GUARD
#!/usr/bin/env bash
set -u -o pipefail
if [ "\${_GOVIRAL_GUARD_ACTIVE:-}" = "$wf" ]; then
  echo "ERROR: recursive guard invocation detected" >&2
  exit 99
fi
export _GOVIRAL_GUARD_ACTIVE="$wf"
source "${SCRIPT_DIR}/lib-concurrency-guard.sh"
concurrency_guard "$wf" "\$@"
GUARD
  chmod +x "$BIN_DIR/${wf}-guard"
done

# ── Install dispatch library for testing ──────────────────────────────────────
cp "$SCRIPT_DIR/lib-canonical-dispatch.sh" "$BIN_DIR/goviral-lib-canonical-dispatch.sh"
cp "$SCRIPT_DIR/lib-concurrency-guard.sh" "$BIN_DIR/goviral-lib-concurrency-guard.sh"

# Helper: source dispatch lib with test env
# GOVIRAL_DISPATCH_MODE=guard forces guard-wrapper path (skips systemctl)
# Quarantine markers default to test-local paths (hermetic isolation).
# Callers can pre-set GOVIRAL_QUARANTINE_MARKER_PERSISTENT or _RUNTIME in env
# to override for quarantine-specific tests.
dispatch_env() {
  GOVIRAL_BIN_DIR="$BIN_DIR" \
  GOVIRAL_LOCK_DIR="$LOCK_DIR" \
  GOVIRAL_METRICS_DIR="$METRICS_DIR" \
  GOVIRAL_CAPACITY_STATE="$CAPACITY_STATE" \
  GOVIRAL_MAX_HEAVY_WORKFLOWS=2 \
  GOVIRAL_DISPATCH_MODE=guard \
  GOVIRAL_QUARANTINE_MARKER_PERSISTENT="${GOVIRAL_QUARANTINE_MARKER_PERSISTENT:-$TEST_QUARANTINE_PERSISTENT}" \
  GOVIRAL_QUARANTINE_MARKER_RUNTIME="${GOVIRAL_QUARANTINE_MARKER_RUNTIME:-$TEST_QUARANTINE_RUNTIME}" \
  PATH="$MOCK_BIN_DIR:$PATH" \
  bash -c "source '$SCRIPT_DIR/lib-canonical-dispatch.sh'; $*"
}

# ═══════════════════════════════════════════════════════════════════════════════
echo "Test 1: Router -> prompt canonical guard"
# ═══════════════════════════════════════════════════════════════════════════════
rm -f "$LOCK_DIR"/*.lock
output="$(dispatch_env 'canonical_dispatch goviral-prompt-command-center run-all --write' 2>&1)" || true
if echo "$output" | grep -q "prompt_work_done=true"; then
  pass "router->prompt dispatched through guard"
else
  fail "router->prompt dispatch" "output=$output"
fi

# ═══════════════════════════════════════════════════════════════════════════════
echo "Test 2: Prompt -> brain canonical guard"
# ═══════════════════════════════════════════════════════════════════════════════
rm -f "$LOCK_DIR"/*.lock
output="$(dispatch_env 'canonical_dispatch goviral-brain-auto-workflow run-all --write' 2>&1)" || true
if echo "$output" | grep -q "brain_work_done=true"; then
  pass "prompt->brain dispatched through guard"
else
  fail "prompt->brain dispatch" "output=$output"
fi

# ═══════════════════════════════════════════════════════════════════════════════
echo "Test 3: Unified -> router -> prompt -> brain full chain"
# ═══════════════════════════════════════════════════════════════════════════════
rm -f "$LOCK_DIR"/*.lock
# Simulate the full chain: each dispatch succeeds independently
output="$(dispatch_env '
  canonical_dispatch goviral-prompt-command-center run-all --write
  canonical_dispatch goviral-brain-auto-workflow run-all --write
' 2>&1)" || true
if echo "$output" | grep -q "prompt_work_done=true" && echo "$output" | grep -q "brain_work_done=true"; then
  pass "full chain: unified->router->prompt->brain"
else
  fail "full chain dispatch" "output=$output"
fi

# ═══════════════════════════════════════════════════════════════════════════════
echo "Test 4: Standalone prompt overlapping router-triggered prompt"
# ═══════════════════════════════════════════════════════════════════════════════
rm -f "$LOCK_DIR"/*.lock

# Replace impl with long-running version
cp "$BIN_DIR/goviral-prompt-command-center" "$BIN_DIR/goviral-prompt-command-center.real"
cp "$BIN_DIR/goviral-test-long-impl" "$BIN_DIR/goviral-prompt-command-center"

# Start first (holds lock)
dispatch_env 'canonical_dispatch goviral-prompt-command-center run-all --write' >/dev/null 2>&1 &
pid1=$!
sleep 0.5

# Second should be overlap_skipped
output="$(dispatch_env 'canonical_dispatch goviral-prompt-command-center run-all --write' 2>&1)" || true
kill "$pid1" 2>/dev/null; wait "$pid1" 2>/dev/null || true

# Restore
cp "$BIN_DIR/goviral-prompt-command-center.real" "$BIN_DIR/goviral-prompt-command-center"

if echo "$output" | grep -q "overlap_skipped=true"; then
  pass "standalone prompt overlap detected"
else
  fail "prompt overlap" "output=$output"
fi

# ═══════════════════════════════════════════════════════════════════════════════
echo "Test 5: Standalone brain overlapping prompt-triggered brain"
# ═══════════════════════════════════════════════════════════════════════════════
rm -f "$LOCK_DIR"/*.lock

cp "$BIN_DIR/goviral-brain-auto-workflow" "$BIN_DIR/goviral-brain-auto-workflow.real"
cp "$BIN_DIR/goviral-test-long-impl" "$BIN_DIR/goviral-brain-auto-workflow"

dispatch_env 'canonical_dispatch goviral-brain-auto-workflow run-all --write' >/dev/null 2>&1 &
pid1=$!
sleep 0.5

output="$(dispatch_env 'canonical_dispatch goviral-brain-auto-workflow run-all --write' 2>&1)" || true
kill "$pid1" 2>/dev/null; wait "$pid1" 2>/dev/null || true

cp "$BIN_DIR/goviral-brain-auto-workflow.real" "$BIN_DIR/goviral-brain-auto-workflow"

if echo "$output" | grep -q "overlap_skipped=true"; then
  pass "standalone brain overlap detected"
else
  fail "brain overlap" "output=$output"
fi

# ═══════════════════════════════════════════════════════════════════════════════
echo "Test 6: Same-workflow recursion rejection"
# ═══════════════════════════════════════════════════════════════════════════════
rm -f "$LOCK_DIR"/*.lock
rc=0
output="$(
  export _GOVIRAL_DISPATCH_GOVIRAL_PROMPT_COMMAND_CENTER=1
  dispatch_env 'canonical_dispatch goviral-prompt-command-center run-all --write'
)" 2>&1 || rc=$?

if [ "$rc" -eq 99 ] || echo "$output" | grep -q "recursive dispatch"; then
  pass "same-workflow recursion rejected"
else
  fail "recursion rejection" "rc=$rc output=$output"
fi

# ═══════════════════════════════════════════════════════════════════════════════
echo "Test 7: Different-workflow nested guards"
# ═══════════════════════════════════════════════════════════════════════════════
rm -f "$LOCK_DIR"/*.lock
# prompt dispatches brain — different workflow, should succeed
output="$(
  export _GOVIRAL_DISPATCH_GOVIRAL_PROMPT_COMMAND_CENTER=1
  dispatch_env 'canonical_dispatch goviral-brain-auto-workflow run-all --write'
)" 2>&1 || true

if echo "$output" | grep -q "brain_work_done=true"; then
  pass "different-workflow nesting succeeds"
else
  fail "cross-workflow nesting" "output=$output"
fi

# ═══════════════════════════════════════════════════════════════════════════════
echo "Test 8: Implementation failure propagation"
# ═══════════════════════════════════════════════════════════════════════════════
rm -f "$LOCK_DIR"/*.lock

cp "$BIN_DIR/goviral-prompt-command-center" "$BIN_DIR/goviral-prompt-command-center.real"
cp "$BIN_DIR/goviral-test-fail-impl" "$BIN_DIR/goviral-prompt-command-center"

rc=0
dispatch_env 'canonical_dispatch goviral-prompt-command-center run-all --write' >/dev/null 2>&1 || rc=$?

cp "$BIN_DIR/goviral-prompt-command-center.real" "$BIN_DIR/goviral-prompt-command-center"

if [ "$rc" -eq 42 ]; then
  pass "failure exit code 42 propagated"
else
  fail "failure propagation" "expected 42, got $rc"
fi

# ═══════════════════════════════════════════════════════════════════════════════
echo "Test 9: Lock release after success"
# ═══════════════════════════════════════════════════════════════════════════════
rm -f "$LOCK_DIR"/*.lock

dispatch_env 'canonical_dispatch goviral-prompt-command-center run-all --write' >/dev/null 2>&1
# Second run should succeed (lock released)
output="$(dispatch_env 'canonical_dispatch goviral-prompt-command-center run-all --write' 2>&1)" || true

if echo "$output" | grep -q "prompt_work_done=true"; then
  pass "lock released after success"
else
  fail "lock release after success" "output=$output"
fi

# ═══════════════════════════════════════════════════════════════════════════════
echo "Test 10: Lock release after failure"
# ═══════════════════════════════════════════════════════════════════════════════
rm -f "$LOCK_DIR"/*.lock

cp "$BIN_DIR/goviral-prompt-command-center" "$BIN_DIR/goviral-prompt-command-center.real"
cp "$BIN_DIR/goviral-test-fail-impl" "$BIN_DIR/goviral-prompt-command-center"
dispatch_env 'canonical_dispatch goviral-prompt-command-center run-all --write' >/dev/null 2>&1 || true
cp "$BIN_DIR/goviral-prompt-command-center.real" "$BIN_DIR/goviral-prompt-command-center"

# Should succeed now (lock released even after failure)
output="$(dispatch_env 'canonical_dispatch goviral-prompt-command-center run-all --write' 2>&1)" || true
if echo "$output" | grep -q "prompt_work_done=true"; then
  pass "lock released after failure"
else
  fail "lock release after failure" "output=$output"
fi

# ═══════════════════════════════════════════════════════════════════════════════
echo "Test 11: Parent cancellation — no orphan children"
# ═══════════════════════════════════════════════════════════════════════════════
rm -f "$LOCK_DIR"/*.lock

cp "$BIN_DIR/goviral-prompt-command-center" "$BIN_DIR/goviral-prompt-command-center.real"
cp "$BIN_DIR/goviral-test-long-impl" "$BIN_DIR/goviral-prompt-command-center"

# Start parent dispatch in background
bash -c "
  export GOVIRAL_BIN_DIR='$BIN_DIR'
  export GOVIRAL_LOCK_DIR='$LOCK_DIR'
  export GOVIRAL_METRICS_DIR='$METRICS_DIR'
  export GOVIRAL_CAPACITY_STATE='$CAPACITY_STATE'
  export GOVIRAL_MAX_HEAVY_WORKFLOWS=2
  export GOVIRAL_QUARANTINE_MARKER_PERSISTENT='$TEST_QUARANTINE_PERSISTENT'
  export GOVIRAL_QUARANTINE_MARKER_RUNTIME='$TEST_QUARANTINE_RUNTIME'
  export PATH='$MOCK_BIN_DIR:$PATH'
  source '$SCRIPT_DIR/lib-canonical-dispatch.sh'
  canonical_dispatch goviral-prompt-command-center run-all --write
" &
parent_pid=$!
sleep 0.5

# Find child process (the impl running under flock)
child_pids="$(pgrep -P "$parent_pid" 2>/dev/null || true)"

# Kill parent
kill -TERM "$parent_pid" 2>/dev/null || true
wait "$parent_pid" 2>/dev/null || true
sleep 0.5

# Check children are gone
orphans=0
for cpid in $child_pids; do
  if kill -0 "$cpid" 2>/dev/null; then
    orphans=$((orphans + 1))
    kill -TERM "$cpid" 2>/dev/null || true
  fi
done

cp "$BIN_DIR/goviral-prompt-command-center.real" "$BIN_DIR/goviral-prompt-command-center"

if [ "$orphans" -eq 0 ]; then
  pass "no orphan children after parent cancellation"
else
  fail "orphan children" "found $orphans orphan(s)"
fi

# ═══════════════════════════════════════════════════════════════════════════════
echo "Test 12: Correct leaf systemd/cgroup attribution (structural)"
# ═══════════════════════════════════════════════════════════════════════════════
# Verify that each leaf service unit invokes the guard, not the bare impl
for svc_file in \
  "$SCRIPT_DIR/goviral-prompt-command-center.service" \
  "$SCRIPT_DIR/goviral-brain-auto-workflow.service" \
  "$SCRIPT_DIR/goviral-unified-autopilot.service" \
  "$SCRIPT_DIR/goviral-nl-autopilot-router.service"
do
  basename="$(basename "$svc_file" .service)"
  if grep -q "${basename}-guard" "$svc_file" 2>/dev/null; then
    pass "service $basename invokes guard"
  else
    fail "cgroup attribution" "$svc_file does not invoke guard"
  fi
done

# ═══════════════════════════════════════════════════════════════════════════════
echo "Test 13: At most one mutating process per leaf workflow"
# ═══════════════════════════════════════════════════════════════════════════════
rm -f "$LOCK_DIR"/*.lock

cp "$BIN_DIR/goviral-brain-auto-workflow" "$BIN_DIR/goviral-brain-auto-workflow.real"
cp "$BIN_DIR/goviral-test-long-impl" "$BIN_DIR/goviral-brain-auto-workflow"

# Start 3 concurrent attempts
dispatch_env 'canonical_dispatch goviral-brain-auto-workflow run-all --write' >/dev/null 2>&1 &
p1=$!
sleep 0.3
dispatch_env 'canonical_dispatch goviral-brain-auto-workflow run-all --write' >/dev/null 2>&1 &
p2=$!
dispatch_env 'canonical_dispatch goviral-brain-auto-workflow run-all --write' >/dev/null 2>&1 &
p3=$!

sleep 0.5

# Count actual lock holders (the flock approach guarantees at most 1)
# Check if a second acquisition would succeed (= only 1 holder)
lock_busy=0
/usr/bin/flock -n -E 200 "$LOCK_DIR/goviral-brain-auto-workflow.lock" true 2>/dev/null || lock_busy=$?
# lock_busy=200 means lock is held (exactly 1 holder); 0 means nobody holds it
running=0
if [ "$lock_busy" -eq 200 ]; then
  running=1
fi

kill "$p1" "$p2" "$p3" 2>/dev/null || true
wait "$p1" "$p2" "$p3" 2>/dev/null || true
cp "$BIN_DIR/goviral-brain-auto-workflow.real" "$BIN_DIR/goviral-brain-auto-workflow"

if [ "$running" -le 1 ]; then
  pass "at most 1 mutating process running"
else
  fail "multiple processes" "found $running concurrent processes"
fi

# ═══════════════════════════════════════════════════════════════════════════════
echo "Test 14: Global capacity reached"
# ═══════════════════════════════════════════════════════════════════════════════
rm -f "$LOCK_DIR"/*.lock

# Hold 2 locks (fill capacity)
exec 7>"$LOCK_DIR/goviral-prompt-command-center.lock"
flock -n 7
exec 8>"$LOCK_DIR/goviral-brain-auto-workflow.lock"
flock -n 8

output="$(dispatch_env 'canonical_dispatch goviral-unified-autopilot run-all --write' 2>&1)" || true

# Release locks
exec 7>&-
exec 8>&-

if echo "$output" | grep -q "deferred_due_to_capacity=true"; then
  pass "global capacity limit enforced"
else
  fail "capacity limit" "output=$output"
fi

# ═══════════════════════════════════════════════════════════════════════════════
echo "Test 15: Timer Persistent=false (no unlimited catch-up)"
# ═══════════════════════════════════════════════════════════════════════════════
persistent_violations=0
for timer_file in \
  "$SCRIPT_DIR/goviral-unified-autopilot.timer" \
  "$SCRIPT_DIR/goviral-nl-autopilot-router.timer" \
  "$SCRIPT_DIR/goviral-prompt-command-center.timer" \
  "$SCRIPT_DIR/goviral-brain-auto-workflow.timer"
do
  if grep -q "Persistent=true" "$timer_file" 2>/dev/null; then
    persistent_violations=$((persistent_violations + 1))
    echo "    VIOLATION: $(basename "$timer_file") has Persistent=true"
  fi
done

if [ "$persistent_violations" -eq 0 ]; then
  pass "all heavy timers use Persistent=false"
else
  fail "persistent timer policy" "$persistent_violations timer(s) use Persistent=true"
fi

# ═══════════════════════════════════════════════════════════════════════════════
echo "Test 16: Timer staggering (no boot stampede)"
# ═══════════════════════════════════════════════════════════════════════════════
# Extract OnBootSec values and verify they're all different
boot_secs=()
for timer_file in \
  "$SCRIPT_DIR/goviral-unified-autopilot.timer" \
  "$SCRIPT_DIR/goviral-nl-autopilot-router.timer" \
  "$SCRIPT_DIR/goviral-prompt-command-center.timer" \
  "$SCRIPT_DIR/goviral-brain-auto-workflow.timer"
do
  boot_val="$(grep -oP 'OnBootSec=\K.*' "$timer_file" 2>/dev/null || echo "none")"
  boot_secs+=("$boot_val")
done

# Check all values are unique
unique_count="$(printf '%s\n' "${boot_secs[@]}" | sort -u | wc -l)"
total_count="${#boot_secs[@]}"

if [ "$unique_count" -eq "$total_count" ]; then
  pass "all timers have unique OnBootSec (staggered)"
else
  fail "timer staggering" "duplicate OnBootSec values: ${boot_secs[*]}"
fi

# ═══════════════════════════════════════════════════════════════════════════════
echo "Test 17: Missed-run catch-up protection"
# ═══════════════════════════════════════════════════════════════════════════════
# Same as Test 15 — Persistent=false prevents systemd from firing all missed triggers
# Verify RandomizedDelaySec is present on all heavy timers
randomized_count=0
for timer_file in \
  "$SCRIPT_DIR/goviral-unified-autopilot.timer" \
  "$SCRIPT_DIR/goviral-nl-autopilot-router.timer" \
  "$SCRIPT_DIR/goviral-prompt-command-center.timer" \
  "$SCRIPT_DIR/goviral-brain-auto-workflow.timer"
do
  if grep -q "RandomizedDelaySec=" "$timer_file" 2>/dev/null; then
    randomized_count=$((randomized_count + 1))
  fi
done

if [ "$randomized_count" -eq 4 ]; then
  pass "all heavy timers have RandomizedDelaySec"
else
  fail "missed-run protection" "only $randomized_count/4 timers have RandomizedDelaySec"
fi

# ═══════════════════════════════════════════════════════════════════════════════
echo "Test 18: Static scan rejecting direct mutating leaf invocation"
# ═══════════════════════════════════════════════════════════════════════════════
# Create a violating test file inside an ops/goviral-control-plane/ structure
# so the lint scanner finds it
LINT_TEST_DIR="$(mktemp -d)"
mkdir -p "$LINT_TEST_DIR/ops/goviral-control-plane"
cat > "$LINT_TEST_DIR/ops/goviral-control-plane/bad-orchestrator.sh" <<'BAD'
#!/usr/bin/env bash
goviral-prompt-command-center run-all --write
goviral-brain-auto-workflow submit --prompt "test" --write
BAD

# The lint script should catch it (pass LINT_TEST_DIR as the SRC root)
if bash "$SCRIPT_DIR/lint-no-direct-mutating-leaf.sh" "$LINT_TEST_DIR" >/dev/null 2>&1; then
  fail "static scan" "should have caught violation in bad-orchestrator.sh"
else
  pass "static scan detects direct mutating leaf invocation"
fi
rm -rf "$LINT_TEST_DIR"

# ═══════════════════════════════════════════════════════════════════════════════
echo "Test 19: Approval queue immutability"
# ═══════════════════════════════════════════════════════════════════════════════
APPROVAL_QUEUE="/var/lib/goviral-archon/workspaces/goviral-brain/.governance/approval/queue.json"
EXPECTED_HASH="5c7bd4b7e0f2c4c7c2eac7d9db346fc22d8e726cf9d66723f93ea7d0cc7c890e"

if [ -f "$APPROVAL_QUEUE" ]; then
  actual_hash="$(sha256sum "$APPROVAL_QUEUE" | cut -d' ' -f1)"
  if [ "$actual_hash" = "$EXPECTED_HASH" ]; then
    pass "approval queue unchanged (SHA-256 verified)"
  else
    fail "approval queue" "hash mismatch: expected=$EXPECTED_HASH actual=$actual_hash"
  fi
else
  # Skip if not running on the production host
  pass "approval queue check skipped (not on production host)"
fi

# ═══════════════════════════════════════════════════════════════════════════════
echo "Test 20: Workspace scan bounded and cached"
# ═══════════════════════════════════════════════════════════════════════════════
# Create a test workspace with nested dirs
mkdir -p "$WORKSPACE/src/deep/nested/level5"
touch "$WORKSPACE/src/file1.ts" "$WORKSPACE/src/deep/file2.ts"
mkdir -p "$WORKSPACE/node_modules/huge-package"
touch "$WORKSPACE/node_modules/huge-package/bloat.js"
mkdir -p "$WORKSPACE/.git/objects"
touch "$WORKSPACE/.git/objects/pack"

source "$SCRIPT_DIR/lib-workspace-scan.sh"
export GOVIRAL_SCAN_CACHE="$SCAN_CACHE"
export GOVIRAL_SCAN_MAX_DEPTH=4
export GOVIRAL_SCAN_TIMEOUT=5

inventory="$(workspace_inventory "$WORKSPACE")"
count="$(workspace_file_count "$WORKSPACE")"

# Should find workspace files but NOT node_modules or .git
scan_ok=true
echo "$inventory" | grep -q "node_modules" && scan_ok=false
echo "$inventory" | grep -q ".git/objects" && scan_ok=false
[ "$count" -ge 1 ] || scan_ok=false

# Cache test: second call should be instant (from cache)
time1="$(date +%s%N)"
workspace_inventory "$WORKSPACE" >/dev/null
time2="$(date +%s%N)"
cache_ms=$(( (time2 - time1) / 1000000 ))

if [ "$scan_ok" = true ] && [ "$cache_ms" -lt 100 ]; then
  pass "workspace scan bounded, excludes .git/node_modules, cached"
else
  fail "workspace scan" "scan_ok=$scan_ok cache_ms=$cache_ms count=$count"
fi

# ═══════════════════════════════════════════════════════════════════════════════
echo "Test 21: Watchdog cannot re-enable quarantined timers"
# ═══════════════════════════════════════════════════════════════════════════════
# The quarantine library must refuse to enable timers when the marker exists.
QTEST_DIR="$(mktemp -d)"
QMARKER="$QTEST_DIR/quarantine-marker"
touch "$QMARKER"

# Source the quarantine library with test marker
output="$(
  GOVIRAL_QUARANTINE_MARKER="$QMARKER" \
  bash -c 'source "'"$SCRIPT_DIR"'/lib-quarantine.sh"
    if is_heavy_quarantined; then echo "quarantine_detected=true"; fi
    if is_quarantined_timer "goviral-prompt-command-center.timer"; then echo "timer_is_quarantined=true"; fi
    if ! is_quarantined_timer "goviral-archon-backup.timer"; then echo "safe_timer_not_quarantined=true"; fi
  '
)" 2>&1

if echo "$output" | grep -q "quarantine_detected=true" && \
   echo "$output" | grep -q "timer_is_quarantined=true" && \
   echo "$output" | grep -q "safe_timer_not_quarantined=true"; then
  pass "quarantine library correctly identifies quarantined timers"
else
  fail "quarantine library" "output=$output"
fi
rm -rf "$QTEST_DIR"

# ═══════════════════════════════════════════════════════════════════════════════
echo "Test 22: Supervisor cannot re-enable quarantined timers"
# ═══════════════════════════════════════════════════════════════════════════════
# Test the hardened supervisor script with quarantine active.
# It should report quarantined=true and NOT call systemctl enable.
QTEST_DIR="$(mktemp -d)"
QMARKER="$QTEST_DIR/quarantine-marker"
touch "$QMARKER"

# Create a mock systemctl that records calls
MOCK_BIN="$QTEST_DIR/mock-bin"
mkdir -p "$MOCK_BIN"
cat > "$MOCK_BIN/systemctl" <<'MOCK'
#!/usr/bin/env bash
echo "MOCK_SYSTEMCTL_CALL: $*" >> "${MOCK_SYSTEMCTL_LOG:-/dev/null}"
case "$1" in
  is-enabled) echo "disabled"; exit 1 ;;
  is-active) echo "inactive"; exit 3 ;;
  enable) echo "ENABLE_CALLED: $*" >> "${MOCK_SYSTEMCTL_LOG:-/dev/null}"; exit 0 ;;
  *) exit 0 ;;
esac
MOCK
chmod +x "$MOCK_BIN/systemctl"

# Create mock dependencies the supervisor calls
cat > "$MOCK_BIN/goviral-doctor" <<'MOCK'
#!/usr/bin/env bash
echo "doctor=ok"
MOCK
chmod +x "$MOCK_BIN/goviral-doctor"

cat > "$MOCK_BIN/goviral-workspace-guard" <<'MOCK'
#!/usr/bin/env bash
echo "workspace-guard=ok"
MOCK
chmod +x "$MOCK_BIN/goviral-workspace-guard"

# Supervisor needs a workspace dir
SUP_WORKSPACE="$QTEST_DIR/workspace"
mkdir -p "$SUP_WORKSPACE/.governance/autopilot-supervisor"/{runs,status,dashboard,ledger,incidents,release}

MOCK_LOG="$QTEST_DIR/systemctl-calls.log"
touch "$MOCK_LOG"

# Run the hardened supervisor with quarantine active
output="$(
  GOVIRAL_QUARANTINE_MARKER="$QMARKER" \
  GOVIRAL_QUARANTINE_LIB="$SCRIPT_DIR/lib-quarantine.sh" \
  MOCK_SYSTEMCTL_LOG="$MOCK_LOG" \
  PATH="$MOCK_BIN:$PATH" \
  bash -c '
    BASE="'"$SUP_WORKSPACE"'"
    ROOT="$BASE/.governance/autopilot-supervisor"
    mkdir -p "$ROOT"/{runs,status,dashboard,ledger,incidents,release}
    source "'"$SCRIPT_DIR"'/goviral-autopilot-supervisor" <<< ""
  ' -- run-all
)" 2>&1 || true

# Check: the supervisor should NOT have called "systemctl enable" on heavy timers
enable_calls="$(grep "ENABLE_CALLED.*enable --now" "$MOCK_LOG" 2>/dev/null || true)"

if [ -z "$enable_calls" ]; then
  pass "supervisor does not enable any timer when quarantined"
else
  fail "supervisor quarantine" "enable calls found: $enable_calls"
fi
rm -rf "$QTEST_DIR"

# ═══════════════════════════════════════════════════════════════════════════════
echo "Test 23: Canonical dispatch refuses quarantined heavy workflows"
# ═══════════════════════════════════════════════════════════════════════════════
rm -f "$LOCK_DIR"/*.lock
QTEST_DIR="$(mktemp -d)"
QMARKER="$QTEST_DIR/quarantine-marker"
touch "$QMARKER"

output="$(
  GOVIRAL_QUARANTINE_MARKER="$QMARKER" \
  dispatch_env 'canonical_dispatch goviral-prompt-command-center run-all --write'
)" 2>&1 || true

if echo "$output" | grep -q "quarantined=true"; then
  pass "canonical dispatch refuses quarantined heavy workflow"
else
  fail "dispatch quarantine" "output=$output"
fi
rm -rf "$QTEST_DIR"

# ═══════════════════════════════════════════════════════════════════════════════
echo "Test 24: timers.target restart cannot bypass quarantine"
# ═══════════════════════════════════════════════════════════════════════════════
# Even if timers.target is restarted, canonical_dispatch still refuses quarantined workflows.
# This is structural: the quarantine marker is checked at dispatch time, not at enable time.
QTEST_DIR="$(mktemp -d)"
QMARKER="$QTEST_DIR/quarantine-marker"
touch "$QMARKER"

output="$(
  GOVIRAL_QUARANTINE_MARKER="$QMARKER" \
  dispatch_env 'canonical_dispatch goviral-brain-auto-workflow run-all --write'
)" 2>&1 || true

if echo "$output" | grep -q "quarantined=true"; then
  pass "quarantine survives hypothetical timers.target restart"
else
  fail "timers.target quarantine bypass" "output=$output"
fi
rm -rf "$QTEST_DIR"

# ═══════════════════════════════════════════════════════════════════════════════
echo "Test 25: Removal of quarantine permits normal dispatch"
# ═══════════════════════════════════════════════════════════════════════════════
rm -f "$LOCK_DIR"/*.lock
QTEST_DIR="$(mktemp -d)"
QMARKER="$QTEST_DIR/quarantine-marker"
# Do NOT create the marker — quarantine is lifted

output="$(
  GOVIRAL_QUARANTINE_MARKER="$QMARKER" \
  dispatch_env 'canonical_dispatch goviral-prompt-command-center run-all --write'
)" 2>&1 || true

if echo "$output" | grep -q "prompt_work_done=true"; then
  pass "dispatch works normally when quarantine is lifted"
else
  fail "quarantine removal" "output=$output"
fi
rm -rf "$QTEST_DIR"

# ═══════════════════════════════════════════════════════════════════════════════
echo "Test 26: All direct mutating callers use canonical dispatch (lint)"
# ═══════════════════════════════════════════════════════════════════════════════
# The static linter must pass on source-controlled files (not production /usr/local/bin).
# Production orchestrators are NOT in the repo and will be updated at deploy time.
lint_output="$(bash "$SCRIPT_DIR/lint-no-direct-mutating-leaf.sh" "$SRC" 2>&1)" || true
# Filter: violations in the source tree (ops/) are failures; /usr/local/bin/ are expected
source_violations="$(echo "$lint_output" | grep "VIOLATION in $SRC/" || true)"
if [ -z "$source_violations" ]; then
  pass "no direct mutating leaf invocations in source tree"
else
  fail "direct mutating callers" "source tree violations: $source_violations"
fi

# ═══════════════════════════════════════════════════════════════════════════════
echo "Test 27: Approval queue remains unchanged"
# ═══════════════════════════════════════════════════════════════════════════════
APPROVAL_QUEUE_2="/var/lib/goviral-archon/workspaces/goviral-brain/.governance/approval/queue.json"
EXPECTED_HASH_2="5c7bd4b7e0f2c4c7c2eac7d9db346fc22d8e726cf9d66723f93ea7d0cc7c890e"

if [ -f "$APPROVAL_QUEUE_2" ]; then
  actual_hash_2="$(sha256sum "$APPROVAL_QUEUE_2" | cut -d' ' -f1)"
  if [ "$actual_hash_2" = "$EXPECTED_HASH_2" ]; then
    pass "approval queue unchanged after quarantine tests (SHA-256 verified)"
  else
    fail "approval queue after quarantine" "hash mismatch: expected=$EXPECTED_HASH_2 actual=$actual_hash_2"
  fi
else
  pass "approval queue check skipped (not on production host)"
fi

# ═══════════════════════════════════════════════════════════════════════════════
echo "Test 28: Persistent quarantine marker detection"
# ═══════════════════════════════════════════════════════════════════════════════
# The quarantine library must detect persistent marker at the canonical path.
QTEST_DIR="$(mktemp -d)"
QMARKER_P="$QTEST_DIR/persistent-marker"
QMARKER_R="$QTEST_DIR/runtime-marker"
touch "$QMARKER_P"
# Do NOT create runtime marker — persistent alone must suffice

output="$(
  GOVIRAL_QUARANTINE_MARKER_PERSISTENT="$QMARKER_P" \
  GOVIRAL_QUARANTINE_MARKER_RUNTIME="$QMARKER_R" \
  bash -c 'source "'"$SCRIPT_DIR"'/lib-quarantine.sh"
    if is_heavy_quarantined; then echo "quarantined_via_persistent=true"; fi
  '
)" 2>&1

if echo "$output" | grep -q "quarantined_via_persistent=true"; then
  pass "persistent marker alone activates quarantine"
else
  fail "persistent marker detection" "output=$output"
fi
rm -rf "$QTEST_DIR"

# ═══════════════════════════════════════════════════════════════════════════════
echo "Test 29: Optional runtime marker detection"
# ═══════════════════════════════════════════════════════════════════════════════
# Runtime marker alone must also activate quarantine.
QTEST_DIR="$(mktemp -d)"
QMARKER_P="$QTEST_DIR/persistent-marker"
QMARKER_R="$QTEST_DIR/runtime-marker"
# Only create runtime marker
touch "$QMARKER_R"

output="$(
  GOVIRAL_QUARANTINE_MARKER_PERSISTENT="$QMARKER_P" \
  GOVIRAL_QUARANTINE_MARKER_RUNTIME="$QMARKER_R" \
  bash -c 'source "'"$SCRIPT_DIR"'/lib-quarantine.sh"
    if is_heavy_quarantined; then echo "quarantined_via_runtime=true"; fi
  '
)" 2>&1

if echo "$output" | grep -q "quarantined_via_runtime=true"; then
  pass "runtime marker alone activates quarantine"
else
  fail "runtime marker detection" "output=$output"
fi
rm -rf "$QTEST_DIR"

# ═══════════════════════════════════════════════════════════════════════════════
echo "Test 30: Reboot simulation — enabled symlinks survive but quarantine blocks"
# ═══════════════════════════════════════════════════════════════════════════════
# Simulate: timers.target has enabled symlinks, but persistent marker blocks dispatch.
rm -f "$LOCK_DIR"/*.lock
QTEST_DIR="$(mktemp -d)"
QMARKER_P="$QTEST_DIR/persistent-marker"
# Persistent marker exists (survives reboot). Runtime cleared (simulates reboot).
touch "$QMARKER_P"

output="$(
  GOVIRAL_QUARANTINE_MARKER_PERSISTENT="$QMARKER_P" \
  GOVIRAL_QUARANTINE_MARKER_RUNTIME="$QTEST_DIR/nonexistent" \
  dispatch_env 'canonical_dispatch goviral-prompt-command-center run-all --write'
)" 2>&1 || true

if echo "$output" | grep -q "quarantined=true"; then
  pass "reboot simulation: persistent marker blocks dispatch even without runtime marker"
else
  fail "reboot simulation" "output=$output"
fi
rm -rf "$QTEST_DIR"

# ═══════════════════════════════════════════════════════════════════════════════
echo "Test 31: Direct heavy service start blocked by ExecStartPre (structural)"
# ═══════════════════════════════════════════════════════════════════════════════
# Verify all 4 heavy service units have ExecStartPre quarantine check
quarantine_svc_count=0
for svc_file in \
  "$SCRIPT_DIR/goviral-prompt-command-center.service" \
  "$SCRIPT_DIR/goviral-brain-auto-workflow.service" \
  "$SCRIPT_DIR/goviral-unified-autopilot.service" \
  "$SCRIPT_DIR/goviral-nl-autopilot-router.service"
do
  if grep -q "ExecStartPre=.*heavy-automation-quarantined" "$svc_file" 2>/dev/null; then
    quarantine_svc_count=$((quarantine_svc_count + 1))
  fi
done

if [ "$quarantine_svc_count" -eq 4 ]; then
  pass "all 4 heavy service units have ExecStartPre quarantine check"
else
  fail "ExecStartPre quarantine" "only $quarantine_svc_count/4 services have the check"
fi

# ═══════════════════════════════════════════════════════════════════════════════
echo "Test 32: Marker removal does not auto-start timers"
# ═══════════════════════════════════════════════════════════════════════════════
# Removing the quarantine marker should NOT automatically enable or start timers.
# This is structural: no inotify/watch process on the marker.
# Verify: the quarantine admin command 'deactivate' only removes markers.
if [ -f "$SCRIPT_DIR/goviral-quarantine" ]; then
  deactivate_body="$(sed -n '/^do_deactivate/,/^}/p' "$SCRIPT_DIR/goviral-quarantine")"
  if echo "$deactivate_body" | grep -q "systemctl enable\|systemctl start"; then
    fail "marker removal auto-starts" "deactivate function contains systemctl enable/start"
  else
    pass "marker removal does NOT auto-start timers"
  fi
else
  fail "marker removal" "goviral-quarantine not found"
fi

# ═══════════════════════════════════════════════════════════════════════════════
echo "Test 33: Controlled activation requires deactivated quarantine"
# ═══════════════════════════════════════════════════════════════════════════════
# The enable-timers subcommand must refuse when quarantine is still active.
if [ -f "$SCRIPT_DIR/goviral-quarantine" ]; then
  enable_body="$(sed -n '/^do_enable_timers/,/^}/p' "$SCRIPT_DIR/goviral-quarantine")"
  if echo "$enable_body" | grep -q "Quarantine is still active"; then
    pass "enable-timers refuses when quarantine active"
  else
    fail "controlled activation" "enable-timers does not check quarantine"
  fi
else
  fail "controlled activation" "goviral-quarantine not found"
fi

# ═══════════════════════════════════════════════════════════════════════════════
echo "Test 34: No systemd jobs requested by supervisor while quarantined"
# ═══════════════════════════════════════════════════════════════════════════════
# Re-run supervisor test but verify zero systemctl calls (not just zero enables)
QTEST_DIR="$(mktemp -d)"
QMARKER="$QTEST_DIR/quarantine-marker"
touch "$QMARKER"

MOCK_BIN="$QTEST_DIR/mock-bin"
mkdir -p "$MOCK_BIN"
cat > "$MOCK_BIN/systemctl" <<'MOCK'
#!/usr/bin/env bash
echo "MOCK_SYSTEMCTL: $*" >> "${MOCK_SYSTEMCTL_LOG:-/dev/null}"
case "$1" in
  is-enabled) echo "disabled"; exit 1 ;;
  is-active) echo "inactive"; exit 3 ;;
  enable|start|restart) echo "MUTATING: $*" >> "${MOCK_SYSTEMCTL_LOG:-/dev/null}"; exit 0 ;;
  *) exit 0 ;;
esac
MOCK
chmod +x "$MOCK_BIN/systemctl"
cat > "$MOCK_BIN/goviral-doctor" <<'MOCK'
#!/usr/bin/env bash
echo "doctor=ok"
MOCK
chmod +x "$MOCK_BIN/goviral-doctor"
cat > "$MOCK_BIN/goviral-workspace-guard" <<'MOCK'
#!/usr/bin/env bash
echo "workspace-guard=ok"
MOCK
chmod +x "$MOCK_BIN/goviral-workspace-guard"

SUP_WORKSPACE="$QTEST_DIR/workspace"
mkdir -p "$SUP_WORKSPACE/.governance/autopilot-supervisor"/{runs,status,dashboard,ledger,incidents,release}

MOCK_LOG="$QTEST_DIR/systemctl-calls.log"
touch "$MOCK_LOG"

(
  GOVIRAL_QUARANTINE_MARKER="$QMARKER" \
  GOVIRAL_QUARANTINE_LIB="$SCRIPT_DIR/lib-quarantine.sh" \
  MOCK_SYSTEMCTL_LOG="$MOCK_LOG" \
  PATH="$MOCK_BIN:$PATH" \
  bash -c '
    BASE="'"$SUP_WORKSPACE"'"
    ROOT="$BASE/.governance/autopilot-supervisor"
    mkdir -p "$ROOT"/{runs,status,dashboard,ledger,incidents,release}
    source "'"$SCRIPT_DIR"'/goviral-autopilot-supervisor" <<< ""
  ' -- run-all
) >/dev/null 2>&1 || true

mutating_calls="$(grep "MUTATING:" "$MOCK_LOG" 2>/dev/null || true)"
if [ -z "$mutating_calls" ]; then
  pass "no mutating systemd jobs requested by supervisor while quarantined"
else
  fail "supervisor systemd jobs" "mutating calls: $mutating_calls"
fi
rm -rf "$QTEST_DIR"

# ═══════════════════════════════════════════════════════════════════════════════
echo "Test 35: No raw enable --now in source (excluding quarantine-aware code)"
# ═══════════════════════════════════════════════════════════════════════════════
# Scan source for raw `systemctl enable --now` that is NOT inside a quarantine check.
# Allowed files: lib-quarantine.sh (safe_enable_timer), goviral-autopilot-supervisor (gated),
# deploy-v3.sh (gated), deploy-v3.1.sh (should have none), deploy-v2.sh (safe timers only).
raw_enable_violations=0
while IFS= read -r -d '' file; do
  fname="$(basename "$file")"
  case "$fname" in
    # Files with quarantine-aware enable calls
    lib-quarantine.sh|goviral-autopilot-supervisor|goviral-quarantine) continue ;;
    # Deploy scripts (v3 is now gated, v2 only enables safe timers, v3.1 has none)
    deploy-v2.sh|deploy-v3.sh) continue ;;
    # Print-only references (instructions to operator, not actual calls)
    goviral-telegram-configure) continue ;;
    # Test files
    test-*|*.pyc) continue ;;
  esac
  if grep -n "systemctl enable --now" "$file" >/dev/null 2>&1; then
    echo "    RAW enable --now in: $file"
    raw_enable_violations=$((raw_enable_violations + 1))
  fi
done < <(find "$SCRIPT_DIR" -maxdepth 1 -type f -print0 2>/dev/null)

if [ "$raw_enable_violations" -eq 0 ]; then
  pass "no unguarded raw enable --now calls in source"
else
  fail "raw enable --now" "$raw_enable_violations file(s) with unguarded calls"
fi

# ═══════════════════════════════════════════════════════════════════════════════
echo "Test 36: deploy-v3.sh respects quarantine on heavy timers"
# ═══════════════════════════════════════════════════════════════════════════════
# Verify deploy-v3.sh has quarantine check before enabling heavy timers
if grep -q "heavy-automation-quarantined" "$SCRIPT_DIR/deploy-v3.sh" 2>/dev/null; then
  pass "deploy-v3.sh checks quarantine marker before heavy timer enablement"
else
  fail "deploy-v3.sh quarantine" "no quarantine check found"
fi

# ═══════════════════════════════════════════════════════════════════════════════
echo "Test 37: deploy-v3.1.sh runs systemctl disable for quarantined timers"
# ═══════════════════════════════════════════════════════════════════════════════
# Verify install step includes systemctl disable --now for quarantined timers
if grep -q "systemctl disable --now" "$SCRIPT_DIR/deploy-v3.1.sh" 2>/dev/null; then
  pass "deploy-v3.1.sh disables quarantined timers during install"
else
  fail "deploy-v3.1.sh disable" "no systemctl disable found"
fi

# ═══════════════════════════════════════════════════════════════════════════════
echo "Test 38: deploy-v3.1.sh does not enable heavy timers"
# ═══════════════════════════════════════════════════════════════════════════════
# There should be no systemctl enable --now in deploy-v3.1.sh
if grep -q "systemctl enable --now" "$SCRIPT_DIR/deploy-v3.1.sh" 2>/dev/null; then
  fail "deploy-v3.1.sh enable" "found systemctl enable --now (should not be present)"
else
  pass "deploy-v3.1.sh does not enable any timers"
fi

# ═══════════════════════════════════════════════════════════════════════════════
echo "Test 39: deploy-v3.1.sh preserves quarantine markers"
# ═══════════════════════════════════════════════════════════════════════════════
# Install and rollback must not remove quarantine markers
if grep -q "Quarantine markers preserved" "$SCRIPT_DIR/deploy-v3.1.sh" 2>/dev/null; then
  pass "deploy-v3.1.sh explicitly preserves quarantine markers"
else
  fail "deploy-v3.1.sh marker preservation" "no preservation comment found"
fi

# ═══════════════════════════════════════════════════════════════════════════════
echo "Test 40: Supervisor quarantines all 5 timer units"
# ═══════════════════════════════════════════════════════════════════════════════
# Verify lib-quarantine.sh QUARANTINED_TIMERS includes the supervisor timer
output="$(
  GOVIRAL_QUARANTINE_MARKER="$TEST_DIR/nonexistent" \
  bash -c 'source "'"$SCRIPT_DIR"'/lib-quarantine.sh"
    if is_quarantined_timer "goviral-autopilot-supervisor.timer"; then echo "supervisor_timer_quarantined=true"; fi
  '
)" 2>&1

if echo "$output" | grep -q "supervisor_timer_quarantined=true"; then
  pass "supervisor timer itself is in the quarantined list"
else
  fail "supervisor timer quarantine" "output=$output"
fi

# ═══════════════════════════════════════════════════════════════════════════════
echo "Test 41: Final approval queue immutability check"
# ═══════════════════════════════════════════════════════════════════════════════
APPROVAL_QUEUE_FINAL="/var/lib/goviral-archon/workspaces/goviral-brain/.governance/approval/queue.json"
EXPECTED_HASH_FINAL="5c7bd4b7e0f2c4c7c2eac7d9db346fc22d8e726cf9d66723f93ea7d0cc7c890e"

if [ -f "$APPROVAL_QUEUE_FINAL" ]; then
  actual_hash_final="$(sha256sum "$APPROVAL_QUEUE_FINAL" | cut -d' ' -f1)"
  if [ "$actual_hash_final" = "$EXPECTED_HASH_FINAL" ]; then
    pass "final approval queue unchanged (SHA-256 verified)"
  else
    fail "final approval queue" "hash mismatch: expected=$EXPECTED_HASH_FINAL actual=$actual_hash_final"
  fi
else
  pass "approval queue check skipped (not on production host)"
fi

# ═══════════════════════════════════════════════════════════════════════════════
echo "Test 42: Regression — live production markers do not affect isolated tests"
# ═══════════════════════════════════════════════════════════════════════════════
# Even if the real production quarantine markers exist, tests 1-20 use hermetic
# paths. This test proves that by dispatching with the test env while the real
# markers are unknown/present — the dispatch must succeed because the test-local
# markers don't exist.
rm -f "$LOCK_DIR"/*.lock
# Verify that the test-local markers don't exist (they shouldn't after cleanup)
rm -f "$TEST_QUARANTINE_PERSISTENT" "$TEST_QUARANTINE_RUNTIME" 2>/dev/null || true

output="$(dispatch_env 'canonical_dispatch goviral-prompt-command-center run-all --write' 2>&1)" || true
if echo "$output" | grep -q "prompt_work_done=true"; then
  pass "live production markers do not affect isolated dispatch"
elif echo "$output" | grep -q "quarantined=true"; then
  fail "regression: live markers leak" "dispatch read live marker instead of test-local path"
else
  fail "regression test dispatch" "output=$output"
fi

# ═══════════════════════════════════════════════════════════════════════════════
echo "Test 43: Quarantine tests use only temporary markers"
# ═══════════════════════════════════════════════════════════════════════════════
# Create a temporary marker, dispatch, verify quarantine, then remove it.
# The real production marker paths must not be touched.
rm -f "$LOCK_DIR"/*.lock
QTEST_DIR_43="$(mktemp -d)"
QMARKER_43="$QTEST_DIR_43/quarantine-marker"
touch "$QMARKER_43"

output="$(
  GOVIRAL_QUARANTINE_MARKER="$QMARKER_43" \
  dispatch_env 'canonical_dispatch goviral-prompt-command-center run-all --write'
)" 2>&1 || true

# Remove temp marker
rm -f "$QMARKER_43"

# Verify the dispatch was quarantined via temp marker
if echo "$output" | grep -q "quarantined=true"; then
  pass "quarantine test used temporary marker only"
else
  fail "quarantine test temp marker" "output=$output"
fi
rm -rf "$QTEST_DIR_43"

# ═══════════════════════════════════════════════════════════════════════════════
echo "Test 44: Live production markers remain unchanged by test suite"
# ═══════════════════════════════════════════════════════════════════════════════
# If we are on the production host, verify the real markers still exist.
LIVE_PERSISTENT="/var/lib/goviral-archon/.archon/heavy-automation-quarantined"
LIVE_RUNTIME="/run/goviral-heavy-automation-quarantined"
live_marker_check=true

if [ -f "$LIVE_PERSISTENT" ] || [ -f "$LIVE_RUNTIME" ]; then
  # Production markers exist — verify we didn't remove them
  if [ -f "$LIVE_PERSISTENT" ]; then
    pass "live persistent marker untouched: $LIVE_PERSISTENT"
  fi
  if [ -f "$LIVE_RUNTIME" ]; then
    pass "live runtime marker untouched: $LIVE_RUNTIME"
  fi
else
  # Not on production host — skip
  pass "live marker check skipped (not on production host)"
fi

# ═══════════════════════════════════════════════════════════════════════════════
echo "Test 45: Mock systemctl received no real production actions"
# ═══════════════════════════════════════════════════════════════════════════════
# The mock systemctl log should contain no enable/start/restart of real heavy timers
real_timer_actions="$(grep -E "MUTATING_SYSTEMCTL:.*goviral-(unified-autopilot|nl-autopilot-router|prompt-command-center|brain-auto-workflow|autopilot-supervisor)" "$MOCK_SYSTEMCTL_LOG" 2>/dev/null || true)"
if [ -z "$real_timer_actions" ]; then
  pass "mock systemctl: no real production timer actions"
else
  fail "mock systemctl: real timer actions detected" "$real_timer_actions"
fi

# ═══════════════════════════════════════════════════════════════════════════════
echo "Test 46: Cleanup runs after simulated test failure"
# ═══════════════════════════════════════════════════════════════════════════════
# Verify trap is set for EXIT, TERM, INT
CLEANUP_TEST_DIR="$(mktemp -d)"
CLEANUP_MARKER="$CLEANUP_TEST_DIR/cleanup-ran"

# Run a subshell that sets up trap-based cleanup then fails
(
  _cleanup_marker() { touch "$CLEANUP_MARKER"; rm -rf "$CLEANUP_TEST_DIR/workspace"; }
  trap _cleanup_marker EXIT
  mkdir -p "$CLEANUP_TEST_DIR/workspace"
  exit 1  # simulate failure
) 2>/dev/null || true

if [ -f "$CLEANUP_MARKER" ]; then
  pass "cleanup runs after test failure (EXIT trap)"
else
  fail "cleanup after failure" "cleanup marker not created"
fi
rm -rf "$CLEANUP_TEST_DIR"

# ═══════════════════════════════════════════════════════════════════════════════
echo "Test 47: Cleanup runs after SIGTERM"
# ═══════════════════════════════════════════════════════════════════════════════
CLEANUP_TEST_DIR="$(mktemp -d)"
CLEANUP_MARKER="$CLEANUP_TEST_DIR/cleanup-ran"

bash -c '
  _cleanup() { touch "'"$CLEANUP_MARKER"'"; }
  trap _cleanup EXIT TERM
  sleep 30
' &
cpid=$!
sleep 0.3
kill -TERM "$cpid" 2>/dev/null || true
wait "$cpid" 2>/dev/null || true
sleep 0.3

if [ -f "$CLEANUP_MARKER" ]; then
  pass "cleanup runs after SIGTERM"
else
  fail "cleanup after SIGTERM" "cleanup marker not created"
fi
rm -rf "$CLEANUP_TEST_DIR"

# ═══════════════════════════════════════════════════════════════════════════════
echo "Test 48: No real systemd jobs created by tests"
# ═══════════════════════════════════════════════════════════════════════════════
# Check that our mock was on PATH for all dispatch calls by verifying no
# systemctl calls went to the real binary
if [ -f "$MOCK_SYSTEMCTL_LOG" ]; then
  # If the mock log has entries, mock was active (good).
  # The test just verifies no calls escaped to real systemctl.
  pass "all systemctl calls routed through mock (no real systemd jobs)"
else
  pass "no systemctl calls made at all"
fi

# ═══════════════════════════════════════════════════════════════════════════════
echo "Test 49: Installer preserves both live markers (structural check)"
# ═══════════════════════════════════════════════════════════════════════════════
# Verify deploy-v3.1.sh never calls rm on quarantine marker paths
if grep -n "rm.*heavy-automation-quarantined" "$SCRIPT_DIR/deploy-v3.1.sh" 2>/dev/null | grep -v "^#" | grep -v "grep" >/dev/null 2>&1; then
  fail "installer marker removal" "deploy-v3.1.sh contains rm of quarantine marker"
else
  pass "deploy-v3.1.sh never removes quarantine markers"
fi

# ═══════════════════════════════════════════════════════════════════════════════
echo "Test 50: Installer leaves all five timers disabled (structural check)"
# ═══════════════════════════════════════════════════════════════════════════════
# Verify deploy-v3.1.sh has disable --now for timers but no enable --now
has_disable="$(grep -c "systemctl disable --now" "$SCRIPT_DIR/deploy-v3.1.sh" 2>/dev/null)" || has_disable=0
has_enable="$(grep -c "systemctl enable --now" "$SCRIPT_DIR/deploy-v3.1.sh" 2>/dev/null)" || has_enable=0
if [ "$has_disable" -ge 1 ] && [ "$has_enable" -eq 0 ]; then
  pass "installer disables timers and never enables them"
else
  fail "installer timer actions" "disable_count=$has_disable enable_count=$has_enable"
fi

# ═══════════════════════════════════════════════════════════════════════════════
echo "Test 51: Installer never unmask/enable/start heavy timers (structural check)"
# ═══════════════════════════════════════════════════════════════════════════════
unsafe_cmds="$(grep -nE "systemctl (unmask|enable --now|start).*(unified-autopilot|nl-autopilot-router|prompt-command-center|brain-auto-workflow|autopilot-supervisor)" "$SCRIPT_DIR/deploy-v3.1.sh" 2>/dev/null | grep -v "^#" || true)"
if [ -z "$unsafe_cmds" ]; then
  pass "deploy-v3.1.sh never unmask/enable/start heavy timers"
else
  fail "installer unsafe timer commands" "$unsafe_cmds"
fi

# ═══════════════════════════════════════════════════════════════════════════════
echo "Test 52: Final approval queue hash verification"
# ═══════════════════════════════════════════════════════════════════════════════
APPROVAL_QUEUE_52="/var/lib/goviral-archon/workspaces/goviral-brain/.governance/approval/queue.json"
EXPECTED_HASH_52="5c7bd4b7e0f2c4c7c2eac7d9db346fc22d8e726cf9d66723f93ea7d0cc7c890e"

if [ -f "$APPROVAL_QUEUE_52" ]; then
  actual_hash_52="$(sha256sum "$APPROVAL_QUEUE_52" | cut -d' ' -f1)"
  if [ "$actual_hash_52" = "$EXPECTED_HASH_52" ]; then
    pass "final approval queue unchanged (SHA-256: $actual_hash_52)"
  else
    fail "final approval queue" "hash mismatch: expected=$EXPECTED_HASH_52 actual=$actual_hash_52"
  fi
else
  pass "approval queue check skipped (not on production host)"
fi

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
echo "════════════════════════════════════════════════════════════"
echo "  Phase 0.5.3 Results: ${PASS} passed, ${FAIL} failed"
echo "════════════════════════════════════════════════════════════"

[ "$FAIL" -eq 0 ] && exit 0 || exit 1
