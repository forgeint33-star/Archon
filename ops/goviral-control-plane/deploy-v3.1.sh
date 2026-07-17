#!/usr/bin/env bash
# GoViral Control Plane v3.1 — Phase 0.5 Stabilization deployment.
#
# Extends deploy-v3.sh with:
#   - Canonical dispatch library
#   - Orchestrator guard wrappers (unified-autopilot, nl-autopilot-router)
#   - Hardened orchestrator systemd units
#   - Staggered timers with Persistent=false
#   - Global backpressure enforcement
#   - Workspace scan library
#
# Modes:
#   --dry-run      Preflight checks only (no changes)
#   --install      Full idempotent installation
#   --verify       Post-install verification only
#   --rollback     Restore from backup
#
# Must be run as root.
#
# Usage:
#   sudo bash /opt/goviral-archon-src/ops/goviral-control-plane/deploy-v3.1.sh --dry-run
# ──────────────────────────────────────────────────────────────────────────────
set -Eeuo pipefail
umask 077

SRC="/opt/goviral-archon-src"
OPS="$SRC/ops/goviral-control-plane"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_DIR="/var/lib/goviral-archon/backups/deploy-v3.1-${STAMP}"
APPROVAL_QUEUE="/var/lib/goviral-archon/workspaces/goviral-brain/.governance/approval/queue.json"
MODE="${1:---dry-run}"
ERRORS=0

log()  { printf '[%s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }
pass() { log "PASS: $*"; }
fail() { log "FAIL: $*"; ERRORS=$((ERRORS + 1)); }
warn() { log "WARN: $*"; }

if [ "$(id -u)" -ne 0 ]; then
  echo "ERROR: This script must be run as root." >&2
  exit 1
fi

# ═══════════════════════════════════════════════════════════════════════════════
# PREFLIGHT
# ═══════════════════════════════════════════════════════════════════════════════
preflight() {
  log "=== PREFLIGHT (v3.1 Phase 0.5) ==="

  local branch
  branch="$(git -C "$SRC" branch --show-current 2>/dev/null || echo unknown)"
  log "Branch: $branch"
  [[ "$branch" == goviral/control-plane-v3.1* ]] || fail "Wrong branch: $branch"

  local porcelain
  porcelain="$(git -C "$SRC" status --porcelain 2>/dev/null)"
  [ -z "$porcelain" ] && pass "Worktree clean" || fail "Worktree not clean"

  # All required source files
  for f in \
    lib-concurrency-guard.sh \
    lib-canonical-dispatch.sh \
    lib-workspace-scan.sh \
    lib-quarantine.sh \
    goviral-autopilot-supervisor \
    goviral-prompt-command-center-guard \
    goviral-brain-auto-workflow-guard \
    goviral-unified-autopilot-guard \
    goviral-nl-autopilot-router-guard \
    goviral-unified-autopilot.service \
    goviral-unified-autopilot.timer \
    goviral-nl-autopilot-router.service \
    goviral-nl-autopilot-router.timer \
    goviral-prompt-command-center.service \
    goviral-prompt-command-center.timer \
    goviral-brain-auto-workflow.service \
    goviral-brain-auto-workflow.timer
  do
    [ -f "$OPS/$f" ] && pass "$f present" || fail "$f missing"
  done

  # Approval queue integrity
  if [ -f "$APPROVAL_QUEUE" ]; then
    AQ_HASH_BEFORE="$(sha256sum "$APPROVAL_QUEUE" | cut -d' ' -f1)"
    log "Approval queue hash (before): $AQ_HASH_BEFORE"
  else
    fail "Approval queue not found"
    AQ_HASH_BEFORE=""
  fi

  # Quarantine marker check
  QUARANTINE_MARKER="/run/goviral-heavy-automation-quarantined"
  if [ -f "$QUARANTINE_MARKER" ]; then
    pass "Quarantine marker present: $QUARANTINE_MARKER"
  else
    warn "Quarantine marker NOT present — supervisor may re-enable timers during deploy"
    warn "  Create it: touch $QUARANTINE_MARKER"
  fi

  # Supervisor timer: must be stopped or quarantine must be active
  if systemctl is-active goviral-autopilot-supervisor.timer >/dev/null 2>&1; then
    if [ ! -f "$QUARANTINE_MARKER" ]; then
      fail "goviral-autopilot-supervisor.timer is active WITHOUT quarantine — it will re-enable heavy timers within 2 minutes"
    else
      warn "goviral-autopilot-supervisor.timer is active but quarantine is set (safe — supervisor will skip heavy timers)"
    fi
  else
    pass "goviral-autopilot-supervisor.timer is not active"
  fi

  # Timers must NOT be active (safety check with detailed diagnostics)
  for timer in \
    goviral-unified-autopilot \
    goviral-nl-autopilot-router \
    goviral-prompt-command-center \
    goviral-brain-auto-workflow
  do
    local active_state load_state sub_state
    active_state="$(systemctl show -p ActiveState --value "${timer}.timer" 2>/dev/null || echo "not-found")"
    load_state="$(systemctl show -p LoadState --value "${timer}.timer" 2>/dev/null || echo "not-found")"
    sub_state="$(systemctl show -p SubState --value "${timer}.timer" 2>/dev/null || echo "not-found")"

    case "$active_state" in
      active|activating)
        # Try to identify who last started this timer
        local invocation_id trigger_info
        invocation_id="$(systemctl show -p InvocationID --value "${timer}.timer" 2>/dev/null || true)"
        trigger_info="$(systemctl show -p TriggeredBy --value "${timer}.timer" 2>/dev/null || true)"
        fail "Timer ${timer}.timer is ${active_state} (sub=${sub_state}, load=${load_state})"
        log "  InvocationID: ${invocation_id:-unknown}"
        log "  TriggeredBy: ${trigger_info:-unknown}"
        log "  LIKELY CAUSE: goviral-autopilot-supervisor re-enabled it"
        log "  FIX: touch $QUARANTINE_MARKER && systemctl stop ${timer}.timer"
        ;;
      inactive)
        pass "Timer ${timer}.timer is inactive (safe)"
        ;;
      failed)
        pass "Timer ${timer}.timer is failed (safe — not running)"
        ;;
      *)
        # not-found or other
        if [ "$load_state" = "not-found" ]; then
          pass "Timer ${timer}.timer is not-found (not installed — safe)"
        else
          warn "Timer ${timer}.timer in unexpected state: active=${active_state} load=${load_state} sub=${sub_state}"
        fi
        ;;
    esac
  done

  # Archon service should be healthy
  if systemctl is-active goviral-archon.service >/dev/null 2>&1; then
    pass "Archon service is active"
  else
    warn "Archon service is not active"
  fi

  if [ "$ERRORS" -gt 0 ]; then
    log "=== PREFLIGHT FAILED ($ERRORS blocker(s)) ==="
    return 1
  fi
  pass "All preflight checks passed"
}

# ═══════════════════════════════════════════════════════════════════════════════
# INSTALL
# ═══════════════════════════════════════════════════════════════════════════════
do_install() {
  log "=== INSTALL (v3.1 Phase 0.5) ==="

  # ── 1. Backup ──────────────────────────────────────────────────────────────
  log "[1/6] Backing up current state..."
  mkdir -p "$BACKUP_DIR/scripts" "$BACKUP_DIR/units"

  for f in \
    goviral-unified-autopilot goviral-unified-autopilot-guard \
    goviral-nl-autopilot-router goviral-nl-autopilot-router-guard \
    goviral-prompt-command-center goviral-prompt-command-center-guard \
    goviral-brain-auto-workflow goviral-brain-auto-workflow-guard \
    goviral-lib-concurrency-guard.sh goviral-lib-canonical-dispatch.sh \
    goviral-lib-workspace-scan.sh goviral-lib-quarantine.sh \
    goviral-autopilot-supervisor
  do
    [ -f "/usr/local/bin/$f" ] && cp -p "/usr/local/bin/$f" "$BACKUP_DIR/scripts/$f"
  done

  for unit in \
    goviral-unified-autopilot.service goviral-unified-autopilot.timer \
    goviral-nl-autopilot-router.service goviral-nl-autopilot-router.timer \
    goviral-prompt-command-center.service goviral-prompt-command-center.timer \
    goviral-brain-auto-workflow.service goviral-brain-auto-workflow.timer
  do
    [ -f "/etc/systemd/system/$unit" ] && cp -p "/etc/systemd/system/$unit" "$BACKUP_DIR/units/$unit"
  done

  pass "Backup complete: $BACKUP_DIR"

  # ── 2. Install libraries ──────────────────────────────────────────────────
  log "[2/6] Installing libraries..."
  install -o root -g root -m 0644 "$OPS/lib-concurrency-guard.sh" /usr/local/bin/goviral-lib-concurrency-guard.sh
  install -o root -g root -m 0644 "$OPS/lib-canonical-dispatch.sh" /usr/local/bin/goviral-lib-canonical-dispatch.sh
  install -o root -g root -m 0644 "$OPS/lib-workspace-scan.sh" /usr/local/bin/goviral-lib-workspace-scan.sh
  install -o root -g root -m 0644 "$OPS/lib-quarantine.sh" /usr/local/bin/goviral-lib-quarantine.sh
  pass "Libraries installed"

  # Install hardened supervisor (quarantine-aware)
  install -o root -g root -m 0755 "$OPS/goviral-autopilot-supervisor" /usr/local/bin/goviral-autopilot-supervisor
  pass "Hardened supervisor installed"

  # ── 3. Install guard wrappers ──────────────────────────────────────────────
  log "[3/6] Installing guard wrappers..."
  for script in \
    goviral-unified-autopilot-guard \
    goviral-nl-autopilot-router-guard \
    goviral-prompt-command-center-guard \
    goviral-brain-auto-workflow-guard
  do
    install -o root -g root -m 0755 "$OPS/$script" "/usr/local/bin/$script"
    log "  installed $script"
  done

  # Restore leaf implementations from hotfix .impl if needed
  for script in goviral-prompt-command-center goviral-brain-auto-workflow; do
    impl_file="$(ls "/usr/local/bin/${script}.impl."* 2>/dev/null | head -1 || true)"
    if [ -n "$impl_file" ] && [ -f "$impl_file" ]; then
      log "  restoring $script from hotfix .impl"
      cp -p "$impl_file" "/usr/local/bin/$script"
      chmod 0755 "/usr/local/bin/$script"
    fi
  done

  pass "Guard wrappers installed"

  # ── 4. Run tests ───────────────────────────────────────────────────────────
  log "[4/6] Running Phase 0.5 tests..."
  if bash "$OPS/test-phase05.sh"; then
    pass "Phase 0.5 tests passed"
  else
    fail "Phase 0.5 tests failed"
    return 1
  fi

  if bash "$OPS/test-concurrency-guard.sh"; then
    pass "Concurrency guard tests passed"
  else
    fail "Concurrency guard tests failed"
    return 1
  fi

  # ── 5. Install systemd units ──────────────────────────────────────────────
  log "[5/6] Installing systemd units..."
  for unit in \
    goviral-unified-autopilot.service goviral-unified-autopilot.timer \
    goviral-nl-autopilot-router.service goviral-nl-autopilot-router.timer \
    goviral-prompt-command-center.service goviral-prompt-command-center.timer \
    goviral-brain-auto-workflow.service goviral-brain-auto-workflow.timer
  do
    install -o root -g root -m 0644 "$OPS/$unit" "/etc/systemd/system/$unit"
    log "  installed $unit"
  done

  systemctl daemon-reload
  pass "systemd daemon-reload complete"

  # ── 6. Verify (do NOT enable timers — that's a separate operator step) ───
  log "[6/6] Post-install verification..."
  do_verify
}

# ═══════════════════════════════════════════════════════════════════════════════
# VERIFY
# ═══════════════════════════════════════════════════════════════════════════════
do_verify() {
  log "=== VERIFY (v3.1 Phase 0.5) ==="

  # Guard chain
  for script in goviral-unified-autopilot goviral-nl-autopilot-router \
    goviral-prompt-command-center goviral-brain-auto-workflow
  do
    if [ -f "/usr/local/bin/${script}-guard" ] && [ -x "/usr/local/bin/${script}-guard" ]; then
      if grep -q 'goviral-lib-concurrency-guard\.sh' "/usr/local/bin/${script}-guard" 2>/dev/null; then
        pass "Guard verified: ${script}-guard"
      else
        fail "Guard missing lib reference: ${script}-guard"
      fi
    else
      fail "Guard missing or not executable: ${script}-guard"
    fi

    # Service must invoke guard
    local svc="/etc/systemd/system/${script}.service"
    if [ -f "$svc" ]; then
      if grep -q "${script}-guard" "$svc" 2>/dev/null; then
        pass "Service invokes guard: $script"
      else
        fail "Service does not invoke guard: $script"
      fi
      if grep -q "TimeoutStartSec=" "$svc" 2>/dev/null; then
        pass "Service has timeout: $script"
      else
        fail "Service missing timeout: $script"
      fi
    else
      fail "Service file missing: $svc"
    fi
  done

  # Libraries
  for lib in goviral-lib-concurrency-guard.sh goviral-lib-canonical-dispatch.sh goviral-lib-workspace-scan.sh; do
    [ -f "/usr/local/bin/$lib" ] && pass "Library: $lib" || fail "Library missing: $lib"
  done

  # Timer properties
  for timer_name in goviral-unified-autopilot goviral-nl-autopilot-router \
    goviral-prompt-command-center goviral-brain-auto-workflow
  do
    local tf="/etc/systemd/system/${timer_name}.timer"
    if [ -f "$tf" ]; then
      grep -q "Persistent=false" "$tf" && pass "Persistent=false: $timer_name" || fail "Persistent!=false: $timer_name"
      grep -q "RandomizedDelaySec=" "$tf" && pass "RandomizedDelaySec: $timer_name" || fail "No RandomizedDelaySec: $timer_name"
    fi
  done

  # Approval queue
  if [ -f "$APPROVAL_QUEUE" ] && [ -n "${AQ_HASH_BEFORE:-}" ]; then
    local aq_after
    aq_after="$(sha256sum "$APPROVAL_QUEUE" | cut -d' ' -f1)"
    [ "$aq_after" = "$AQ_HASH_BEFORE" ] && pass "Approval queue unchanged" || fail "Approval queue changed!"
  fi

  log "Verification errors: $ERRORS"
  [ "$ERRORS" -eq 0 ] && pass "=== ALL VERIFICATION PASSED ===" || { log "=== VERIFICATION FAILED ==="; return 1; }
}

# ═══════════════════════════════════════════════════════════════════════════════
# ROLLBACK
# ═══════════════════════════════════════════════════════════════════════════════
do_rollback() {
  log "=== ROLLBACK (v3.1) ==="
  local latest
  latest="$(ls -1d /var/lib/goviral-archon/backups/deploy-v3.1-* 2>/dev/null | sort | tail -1 || true)"
  if [ -z "$latest" ]; then
    fail "No v3.1 backup found"
    return 1
  fi
  log "Restoring from: $latest"
  [ -d "$latest/scripts" ] && cp -p "$latest/scripts"/* /usr/local/bin/ 2>/dev/null || true
  [ -d "$latest/units" ] && cp -p "$latest/units"/* /etc/systemd/system/ 2>/dev/null || true
  systemctl daemon-reload
  pass "Rollback complete"
}

# ═══════════════════════════════════════════════════════════════════════════════
# MAIN
# ═══════════════════════════════════════════════════════════════════════════════
AQ_HASH_BEFORE=""

case "$MODE" in
  --dry-run)  preflight ;;
  --install)  preflight || exit 1; do_install || { log "=== INSTALL FAILED ==="; exit 1; } ;;
  --verify)   do_verify ;;
  --rollback) do_rollback ;;
  *)          echo "Usage: $0 [--dry-run|--install|--verify|--rollback]" >&2; exit 1 ;;
esac

[ "$ERRORS" -gt 0 ] && { log "=== $ERRORS ERROR(S) ==="; exit 1; }
exit 0
