#!/usr/bin/env bash
# GoViral Control Plane v3.1 — Phase 0.5.2 Stabilization deployment.
#
# Extends deploy-v3.sh with:
#   - Canonical dispatch library + quarantine library
#   - Orchestrator guard wrappers (unified-autopilot, nl-autopilot-router)
#   - Hardened orchestrator systemd units with ExecStartPre quarantine check
#   - Staggered timers with Persistent=false
#   - Global backpressure enforcement
#   - Workspace scan library
#   - Hardened autopilot supervisor (quarantine-aware)
#   - Quarantine admin command (goviral-quarantine)
#   - Reboot-safe persistent quarantine marker
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

# Quarantine markers
QUARANTINE_PERSISTENT="/var/lib/goviral-archon/.archon/heavy-automation-quarantined"
QUARANTINE_RUNTIME="/run/goviral-heavy-automation-quarantined"

# The five quarantined timers
QUARANTINED_TIMERS=(
  goviral-unified-autopilot.timer
  goviral-nl-autopilot-router.timer
  goviral-prompt-command-center.timer
  goviral-brain-auto-workflow.timer
  goviral-autopilot-supervisor.timer
)

log()  { printf '[%s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }
pass() { log "PASS: $*"; }
fail() { log "FAIL: $*"; ERRORS=$((ERRORS + 1)); }
warn() { log "WARN: $*"; }

is_quarantined() {
  [ -f "$QUARANTINE_PERSISTENT" ] || [ -f "$QUARANTINE_RUNTIME" ]
}

if [ "$(id -u)" -ne 0 ]; then
  echo "ERROR: This script must be run as root." >&2
  exit 1
fi

# ═══════════════════════════════════════════════════════════════════════════════
# PREFLIGHT
# ═══════════════════════════════════════════════════════════════════════════════
preflight() {
  log "=== PREFLIGHT (v3.1 Phase 0.5.2) ==="

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
    goviral-quarantine \
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

  # Service units must have ExecStartPre quarantine check
  for svc in \
    goviral-prompt-command-center.service \
    goviral-brain-auto-workflow.service \
    goviral-unified-autopilot.service \
    goviral-nl-autopilot-router.service
  do
    if grep -q "ExecStartPre=.*heavy-automation-quarantined" "$OPS/$svc" 2>/dev/null; then
      pass "ExecStartPre quarantine check: $svc"
    else
      fail "Missing ExecStartPre quarantine check: $svc"
    fi
  done

  # Approval queue integrity
  if [ -f "$APPROVAL_QUEUE" ]; then
    AQ_HASH_BEFORE="$(sha256sum "$APPROVAL_QUEUE" | cut -d' ' -f1)"
    log "Approval queue hash (before): $AQ_HASH_BEFORE"
  else
    fail "Approval queue not found"
    AQ_HASH_BEFORE=""
  fi

  # Quarantine marker status
  log "--- Quarantine status ---"
  if [ -f "$QUARANTINE_PERSISTENT" ]; then
    pass "Persistent quarantine marker present: $QUARANTINE_PERSISTENT"
  else
    warn "Persistent quarantine marker NOT present"
  fi
  if [ -f "$QUARANTINE_RUNTIME" ]; then
    log "  Runtime quarantine marker present: $QUARANTINE_RUNTIME"
  else
    log "  Runtime quarantine marker absent"
  fi

  if ! is_quarantined; then
    warn "Quarantine is NOT active — supervisor may re-enable timers during deploy"
    warn "  Activate with: goviral-quarantine activate"
    warn "  Or manually: touch $QUARANTINE_PERSISTENT && touch $QUARANTINE_RUNTIME"
  fi

  # Supervisor timer: must be stopped or quarantine must be active
  if systemctl is-active goviral-autopilot-supervisor.timer >/dev/null 2>&1; then
    if ! is_quarantined; then
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
        local invocation_id trigger_info
        invocation_id="$(systemctl show -p InvocationID --value "${timer}.timer" 2>/dev/null || true)"
        trigger_info="$(systemctl show -p TriggeredBy --value "${timer}.timer" 2>/dev/null || true)"
        fail "Timer ${timer}.timer is ${active_state} (sub=${sub_state}, load=${load_state})"
        log "  InvocationID: ${invocation_id:-unknown}"
        log "  TriggeredBy: ${trigger_info:-unknown}"
        log "  LIKELY CAUSE: goviral-autopilot-supervisor re-enabled it"
        log "  FIX: goviral-quarantine activate"
        ;;
      inactive)
        pass "Timer ${timer}.timer is inactive (safe)"
        ;;
      failed)
        pass "Timer ${timer}.timer is failed (safe — not running)"
        ;;
      *)
        if [ "$load_state" = "not-found" ]; then
          pass "Timer ${timer}.timer is not-found (not installed — safe)"
        else
          warn "Timer ${timer}.timer in unexpected state: active=${active_state} load=${load_state} sub=${sub_state}"
        fi
        ;;
    esac
  done

  # Runtime mask detection
  for timer in "${QUARANTINED_TIMERS[@]}"; do
    local load
    load="$(systemctl show -p LoadState --value "$timer" 2>/dev/null || echo "not-found")"
    if [ "$load" = "masked" ]; then
      log "  MASKED: $timer (load=masked) — will preserve mask"
    fi
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
  log "=== INSTALL (v3.1 Phase 0.5.2) ==="

  # ── 1. Backup ──────────────────────────────────────────────────────────────
  log "[1/8] Backing up current state..."
  mkdir -p "$BACKUP_DIR/scripts" "$BACKUP_DIR/units"

  for f in \
    goviral-unified-autopilot goviral-unified-autopilot-guard \
    goviral-nl-autopilot-router goviral-nl-autopilot-router-guard \
    goviral-prompt-command-center goviral-prompt-command-center-guard \
    goviral-brain-auto-workflow goviral-brain-auto-workflow-guard \
    goviral-lib-concurrency-guard.sh goviral-lib-canonical-dispatch.sh \
    goviral-lib-workspace-scan.sh goviral-lib-quarantine.sh \
    goviral-autopilot-supervisor goviral-quarantine
  do
    [ -f "/usr/local/bin/$f" ] && cp -p "/usr/local/bin/$f" "$BACKUP_DIR/scripts/$f"
  done

  for unit in \
    goviral-unified-autopilot.service goviral-unified-autopilot.timer \
    goviral-nl-autopilot-router.service goviral-nl-autopilot-router.timer \
    goviral-prompt-command-center.service goviral-prompt-command-center.timer \
    goviral-brain-auto-workflow.service goviral-brain-auto-workflow.timer \
    goviral-autopilot-supervisor.service goviral-autopilot-supervisor.timer
  do
    [ -f "/etc/systemd/system/$unit" ] && cp -p "/etc/systemd/system/$unit" "$BACKUP_DIR/units/$unit"
  done

  pass "Backup complete: $BACKUP_DIR"

  # ── 2. Install libraries ──────────────────────────────────────────────────
  log "[2/8] Installing libraries..."
  install -o root -g root -m 0644 "$OPS/lib-concurrency-guard.sh" /usr/local/bin/goviral-lib-concurrency-guard.sh
  install -o root -g root -m 0644 "$OPS/lib-canonical-dispatch.sh" /usr/local/bin/goviral-lib-canonical-dispatch.sh
  install -o root -g root -m 0644 "$OPS/lib-workspace-scan.sh" /usr/local/bin/goviral-lib-workspace-scan.sh
  install -o root -g root -m 0644 "$OPS/lib-quarantine.sh" /usr/local/bin/goviral-lib-quarantine.sh
  pass "Libraries installed"

  # ── 3. Install supervisor + quarantine admin ──────────────────────────────
  log "[3/8] Installing supervisor and quarantine admin..."
  install -o root -g root -m 0755 "$OPS/goviral-autopilot-supervisor" /usr/local/bin/goviral-autopilot-supervisor
  install -o root -g root -m 0755 "$OPS/goviral-quarantine" /usr/local/bin/goviral-quarantine
  pass "Supervisor and quarantine admin installed"

  # ── 4. Install guard wrappers ──────────────────────────────────────────────
  log "[4/8] Installing guard wrappers..."
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

  # ── 5. Run tests ───────────────────────────────────────────────────────────
  log "[5/8] Running Phase 0.5 tests..."
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

  # ── 6. Install systemd units ──────────────────────────────────────────────
  log "[6/8] Installing systemd units..."
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

  # ── 7. Disable quarantined timers (remove enabled symlinks) ───────────────
  log "[7/8] Disabling quarantined timers (removing enabled symlinks)..."
  for timer in "${QUARANTINED_TIMERS[@]}"; do
    if systemctl cat "$timer" >/dev/null 2>&1; then
      systemctl disable --now "$timer" 2>/dev/null || true
      log "  disabled+stopped: $timer"
    else
      log "  not installed (skip): $timer"
    fi
  done
  pass "Quarantined timers disabled — enabled symlinks removed"

  # Do NOT remove quarantine markers (persistent or runtime)
  if is_quarantined; then
    log "  Quarantine markers preserved (persistent + runtime)"
  fi

  # Do NOT enable heavy timers — that's a separate operator step

  # ── 8. Verify ──────────────────────────────────────────────────────────────
  log "[8/8] Post-install verification..."
  do_verify

  log ""
  log "══════════════════════════════════════════════════════════"
  log " Installation complete. Timers are DISABLED."
  log ""
  log " To activate timers after verification:"
  log "   1. goviral-quarantine deactivate"
  log "   2. goviral-quarantine enable-timers"
  log "══════════════════════════════════════════════════════════"
}

# ═══════════════════════════════════════════════════════════════════════════════
# VERIFY
# ═══════════════════════════════════════════════════════════════════════════════
do_verify() {
  log "=== VERIFY (v3.1 Phase 0.5.2) ==="

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
      if grep -q "ExecStartPre=.*heavy-automation-quarantined" "$svc" 2>/dev/null; then
        pass "Service has ExecStartPre quarantine check: $script"
      else
        fail "Service missing ExecStartPre quarantine check: $script"
      fi
    else
      fail "Service file missing: $svc"
    fi
  done

  # Libraries
  for lib in goviral-lib-concurrency-guard.sh goviral-lib-canonical-dispatch.sh \
    goviral-lib-workspace-scan.sh goviral-lib-quarantine.sh
  do
    [ -f "/usr/local/bin/$lib" ] && pass "Library: $lib" || fail "Library missing: $lib"
  done

  # Admin commands
  [ -f "/usr/local/bin/goviral-quarantine" ] && [ -x "/usr/local/bin/goviral-quarantine" ] \
    && pass "Quarantine admin: goviral-quarantine" \
    || fail "Missing or not executable: goviral-quarantine"

  # Supervisor
  if [ -f "/usr/local/bin/goviral-autopilot-supervisor" ]; then
    if grep -q "is_heavy_quarantined\|lib-quarantine" "/usr/local/bin/goviral-autopilot-supervisor" 2>/dev/null; then
      pass "Supervisor is quarantine-aware"
    else
      fail "Supervisor is NOT quarantine-aware (old v1?)"
    fi
  else
    fail "Supervisor missing"
  fi

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

  # Do NOT remove quarantine markers during rollback
  if is_quarantined; then
    log "  Quarantine markers preserved during rollback"
  fi

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
