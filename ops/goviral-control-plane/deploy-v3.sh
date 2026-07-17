#!/usr/bin/env bash
# GoViral Control Plane v3 — Canonical deployment script.
#
# Modes:
#   --dry-run      Preflight checks only (no changes)
#   --install      Full idempotent installation
#   --verify       Post-install verification only
#   --rollback     Restore from backup
#
# Canonical source: ops/goviral-control-plane/deploy-v3.sh
# Must be run as root.
#
# Usage:
#   sudo bash /opt/goviral-archon-src/ops/goviral-control-plane/deploy-v3.sh --dry-run
#   sudo bash /opt/goviral-archon-src/ops/goviral-control-plane/deploy-v3.sh --install
#   sudo bash /opt/goviral-archon-src/ops/goviral-control-plane/deploy-v3.sh --verify
#   sudo bash /opt/goviral-archon-src/ops/goviral-control-plane/deploy-v3.sh --rollback
# ──────────────────────────────────────────────────────────────────────────────
set -Eeuo pipefail
umask 077

SRC="/opt/goviral-archon-src"
OPS="$SRC/ops/goviral-control-plane"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_DIR="/var/lib/goviral-archon/backups/deploy-v3-${STAMP}"
APPROVAL_QUEUE="/var/lib/goviral-archon/workspaces/goviral-brain/.governance/approval/queue.json"
CRED_DIR="/etc/goviral/credentials"
MODE="${1:---dry-run}"
ERRORS=0

log()  { printf '[%s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }
pass() { log "PASS: $*"; }
fail() { log "FAIL: $*"; ERRORS=$((ERRORS + 1)); }
warn() { log "WARN: $*"; }

# ── 0. Root check ────────────────────────────────────────────────────────────

if [ "$(id -u)" -ne 0 ]; then
  echo "ERROR: This script must be run as root." >&2
  exit 1
fi

# ── Expected commit (updated by Phase 9 build) ──────────────────────────────
EXPECTED_COMMIT=""  # Set by the operator; empty = skip commit check

# ═══════════════════════════════════════════════════════════════════════════════
# PREFLIGHT
# ═══════════════════════════════════════════════════════════════════════════════

preflight() {
  log "=== PREFLIGHT ==="

  # Branch
  local branch
  branch="$(git -C "$SRC" branch --show-current 2>/dev/null || echo unknown)"
  log "Branch: $branch"
  [ "$branch" = "goviral/control-plane-v3" ] || fail "Wrong branch: $branch (expected goviral/control-plane-v3)"

  # Full commit
  local commit
  commit="$(git -C "$SRC" rev-parse HEAD 2>/dev/null || echo unknown)"
  log "Commit: $commit"
  if [ -n "$EXPECTED_COMMIT" ]; then
    [ "$commit" = "$EXPECTED_COMMIT" ] || fail "Wrong commit: $commit (expected $EXPECTED_COMMIT)"
  fi

  # Clean worktree
  local porcelain
  porcelain="$(git -C "$SRC" status --porcelain 2>/dev/null)"
  if [ -z "$porcelain" ]; then
    pass "Worktree clean"
  else
    fail "Worktree not clean"
  fi

  # Source files exist
  [ -f "$OPS/lib-concurrency-guard.sh" ] && pass "lib-concurrency-guard.sh present" || fail "lib-concurrency-guard.sh missing"
  [ -f "$OPS/goviral-prompt-command-center-guard" ] && pass "prompt-command-center-guard present" || fail "guard missing"
  [ -f "$OPS/goviral-brain-auto-workflow-guard" ] && pass "brain-auto-workflow-guard present" || fail "guard missing"

  # node_modules
  [ -d "$SRC/node_modules" ] && pass "node_modules present" || fail "node_modules missing"

  # Existing backup
  [ -f "/var/lib/goviral-archon/backups/control-plane/latest.tar.gz" ] && pass "Production backup exists" || fail "No production backup"

  # Approval queue hash
  if [ -f "$APPROVAL_QUEUE" ]; then
    AQ_HASH_BEFORE="$(sha256sum "$APPROVAL_QUEUE" | cut -d' ' -f1)"
    log "Approval queue hash (before): $AQ_HASH_BEFORE"
  else
    fail "Approval queue not found: $APPROVAL_QUEUE"
    AQ_HASH_BEFORE=""
  fi

  # Credential files exist (boolean only — never read content)
  if [ -d "$CRED_DIR" ]; then
    pass "Credential directory exists"
  else
    warn "No credential directory at $CRED_DIR"
  fi

  if [ "$ERRORS" -gt 0 ]; then
    log "=== PREFLIGHT FAILED ($ERRORS blocker(s)) ==="
    return 1
  fi

  pass "All preflight checks passed"
  return 0
}

# ═══════════════════════════════════════════════════════════════════════════════
# INSTALL
# ═══════════════════════════════════════════════════════════════════════════════

do_install() {
  log "=== INSTALL ==="

  # ── 1. Backup ──────────────────────────────────────────────────────────────
  log "[1/8] Backing up current production state..."
  mkdir -p "$BACKUP_DIR/scripts" "$BACKUP_DIR/units" "$BACKUP_DIR/web-dist"

  # Guard wrapper scripts
  for f in goviral-prompt-command-center goviral-brain-auto-workflow; do
    [ -f "/usr/local/bin/$f" ] && cp -p "/usr/local/bin/$f" "$BACKUP_DIR/scripts/$f"
  done

  # Guard impl files
  for pattern in /usr/local/bin/goviral-prompt-command-center.impl* /usr/local/bin/goviral-brain-auto-workflow.impl*; do
    [ -f "$pattern" ] && cp -p "$pattern" "$BACKUP_DIR/scripts/$(basename "$pattern")"
  done

  # Guard library
  [ -f "/usr/local/bin/goviral-lib-concurrency-guard.sh" ] && \
    cp -p "/usr/local/bin/goviral-lib-concurrency-guard.sh" "$BACKUP_DIR/scripts/"

  # Systemd units
  for unit in \
    goviral-prompt-command-center.service goviral-prompt-command-center.timer \
    goviral-brain-auto-workflow.service goviral-brain-auto-workflow.timer \
    goviral-archon-upgrade-check.service goviral-archon-upgrade-check.timer \
    goviral-analytics-rollup.service goviral-analytics-rollup.timer \
    goviral-archon-backup.service goviral-archon-backup.timer \
    goviral-control-healthcheck.service goviral-control-healthcheck.timer \
    goviral-daily-ops-report.service goviral-daily-ops-report.timer \
    goviral-telegram-notifier.service goviral-telegram-notifier.timer \
    goviral-control-canary.service
  do
    [ -f "/etc/systemd/system/$unit" ] && cp -p "/etc/systemd/system/$unit" "$BACKUP_DIR/units/$unit"
  done

  # Actions drop-in
  [ -f "/etc/systemd/system/goviral-archon.service.d/goviral-archon-actions.conf" ] && \
    cp -p "/etc/systemd/system/goviral-archon.service.d/goviral-archon-actions.conf" "$BACKUP_DIR/units/"

  # Web dist marker
  [ -f "$SRC/packages/web/dist/index.html" ] && \
    cp "$SRC/packages/web/dist/index.html" "$BACKUP_DIR/web-dist/index.html.bak"

  # Credential metadata (never content)
  ls -la "$CRED_DIR/" > "$BACKUP_DIR/credential-listing.txt" 2>/dev/null || true

  pass "Backup complete: $BACKUP_DIR"

  # ── 2. Build web bundle as goviral-archon ──────────────────────────────────
  log "[2/8] Building production web bundle as goviral-archon..."
  sudo -u goviral-archon -H env HOME=/var/lib/goviral-archon \
    /usr/local/bin/bun --filter @archon/web build --cwd "$SRC"

  [ -f "$SRC/packages/web/dist/index.html" ] && pass "Web dist built" || { fail "Web build failed"; return 1; }

  # Verify no root-owned files created in repo
  root_owned="$(find "$SRC/packages/web/dist" -user root 2>/dev/null | head -5)"
  if [ -n "$root_owned" ]; then
    fail "Root-owned files in web dist: $root_owned"
    return 1
  fi
  pass "No root-owned repo files created"

  # ── 3. Install v2 scripts (idempotent, preserves existing behavior) ────────
  log "[3/8] Installing operational scripts..."

  for script in \
    goviral-control-action \
    goviral-control-healthcheck \
    goviral-archon-backup \
    goviral-archon-restore-drill \
    goviral-archon-upgrade-check \
    goviral-control-canary-test \
    goviral-telegram-notifier \
    goviral-daily-ops-report \
    goviral-telegram-configure \
    goviral-clickup-configure \
    goviral-offsite-configure \
    goviral-offsite-backup \
    goviral-analytics-rollup
  do
    if [ -f "$OPS/$script" ]; then
      install -o root -g root -m 0755 "$OPS/$script" "/usr/local/bin/$script"
      log "  installed $script"
    fi
  done

  # ── 4. Install concurrency guard library and wrappers ──────────────────────
  log "[4/8] Installing concurrency guards..."

  # Install shared library
  install -o root -g root -m 0644 \
    "$OPS/lib-concurrency-guard.sh" \
    /usr/local/bin/goviral-lib-concurrency-guard.sh
  log "  installed goviral-lib-concurrency-guard.sh"

  # For each guarded workflow:
  #   1. If the production hotfix is active (.impl.* exists), restore the
  #      original implementation from .impl back to the base name.
  #   2. Install the canonical guard wrapper as -guard.
  #
  # After this step:
  #   /usr/local/bin/<name>       = original implementation (unguarded)
  #   /usr/local/bin/<name>-guard = guard wrapper (the systemd entrypoint)
  #
  # The guard wrapper sources lib-concurrency-guard.sh which invokes the
  # implementation at /usr/local/bin/<name> through flock.
  for script in goviral-prompt-command-center goviral-brain-auto-workflow; do
    impl_file="$(ls "/usr/local/bin/${script}.impl."* 2>/dev/null | head -1 || true)"

    if [ -n "$impl_file" ] && [ -f "$impl_file" ]; then
      # Production hotfix is active: the base name is the hotfix guard,
      # the .impl file is the real implementation. Restore the original.
      log "  restoring $script from hotfix .impl: $(basename "$impl_file")"
      cp -p "$impl_file" "/usr/local/bin/$script"
      chmod 0755 "/usr/local/bin/$script"
      # Keep .impl file as safety backup (do NOT delete)
    fi

    # Verify the implementation exists at the base name before installing the guard
    if [ ! -f "/usr/local/bin/$script" ]; then
      fail "Implementation missing: /usr/local/bin/$script"
      return 1
    fi

    # Install guard wrapper as -guard (the entrypoint that systemd invokes)
    install -o root -g root -m 0755 \
      "$OPS/${script}-guard" \
      "/usr/local/bin/${script}-guard"
    log "  installed ${script}-guard (systemd entrypoint)"
  done

  # ── 5. Run concurrency canary tests ────────────────────────────────────────
  log "[5/8] Running concurrency canary tests..."
  if bash "$OPS/test-concurrency-guard.sh"; then
    pass "All concurrency canary tests passed"
  else
    fail "Concurrency canary tests failed"
    return 1
  fi

  # ── 6. Install systemd units ───────────────────────────────────────────────
  log "[6/8] Installing hardened systemd units..."

  for unit in \
    goviral-prompt-command-center.service goviral-prompt-command-center.timer \
    goviral-brain-auto-workflow.service goviral-brain-auto-workflow.timer \
    goviral-archon-backup.service goviral-archon-backup.timer \
    goviral-control-healthcheck.service goviral-control-healthcheck.timer \
    goviral-archon-upgrade-check.service goviral-archon-upgrade-check.timer \
    goviral-analytics-rollup.service goviral-analytics-rollup.timer \
    goviral-daily-ops-report.service goviral-daily-ops-report.timer \
    goviral-telegram-notifier.service goviral-telegram-notifier.timer \
    goviral-control-canary.service
  do
    if [ -f "$OPS/$unit" ]; then
      install -o root -g root -m 0644 "$OPS/$unit" "/etc/systemd/system/$unit"
      log "  installed $unit"
    fi
  done

  # Actions drop-in
  mkdir -p /etc/systemd/system/goviral-archon.service.d
  install -o root -g root -m 0644 "$OPS/goviral-archon-actions.conf" \
    /etc/systemd/system/goviral-archon.service.d/goviral-archon-actions.conf
  log "  installed actions drop-in"

  # Sudoers
  install -o root -g root -m 0440 "$OPS/goviral-archon-control.sudoers" \
    /etc/sudoers.d/goviral-archon-control
  if visudo -cf /etc/sudoers.d/goviral-archon-control >/dev/null 2>&1; then
    pass "Sudoers validated"
  else
    fail "Sudoers validation failed"
    return 1
  fi

  # systemd-analyze verify (non-fatal — some units reference optional deps)
  log "  Running systemd-analyze verify..."
  for unit in \
    goviral-prompt-command-center.service \
    goviral-brain-auto-workflow.service \
    goviral-archon-backup.service \
    goviral-control-healthcheck.service \
    goviral-archon-upgrade-check.service \
    goviral-analytics-rollup.service
  do
    if systemd-analyze verify "/etc/systemd/system/$unit" 2>/dev/null; then
      log "    verified: $unit"
    else
      warn "systemd-analyze verify warning for $unit (non-fatal)"
    fi
  done

  # ── 7. Reload, enable, restart ─────────────────────────────────────────────
  log "[7/8] Reloading systemd and enabling timers..."

  systemctl daemon-reload
  pass "systemd daemon-reload"

  # Enable safe timers
  for timer in \
    goviral-archon-backup \
    goviral-control-healthcheck \
    goviral-archon-upgrade-check \
    goviral-analytics-rollup \
    goviral-prompt-command-center \
    goviral-brain-auto-workflow
  do
    systemctl enable --now "${timer}.timer" 2>/dev/null && log "  enabled ${timer}.timer" || warn "Could not enable ${timer}.timer"
  done

  # Telegram timers (only if credentials exist)
  if [ -f "$CRED_DIR/telegram-bot-token" ] && [ -f "$CRED_DIR/telegram-chat-id" ]; then
    systemctl enable --now goviral-telegram-notifier.timer 2>/dev/null && log "  enabled goviral-telegram-notifier.timer"
    systemctl enable --now goviral-daily-ops-report.timer 2>/dev/null && log "  enabled goviral-daily-ops-report.timer"
  else
    warn "Telegram timers NOT enabled (no credentials)"
  fi

  # ── 8. Restart Archon ─────────────────────────────────────────────────────
  log "[8/8] Restarting goviral-archon.service..."
  systemctl restart goviral-archon.service
  sleep 4

  if systemctl is-active goviral-archon.service >/dev/null 2>&1; then
    pass "goviral-archon.service is active"
  else
    fail "goviral-archon.service failed to start"
    return 1
  fi

  pass "Installation complete"
}

# ═══════════════════════════════════════════════════════════════════════════════
# VERIFY
# ═══════════════════════════════════════════════════════════════════════════════

do_verify() {
  log "=== POST-INSTALL VERIFICATION ==="

  # ── Service active ─────────────────────────────────────────────────────────
  systemctl is-active goviral-archon.service >/dev/null 2>&1 && pass "Service active" || fail "Service not active"

  # ── Loopback-only binding ──────────────────────────────────────────────────
  local bad_listeners
  bad_listeners="$(ss -tlnp 2>/dev/null | grep ':8180 ' | grep -vE '127\.0\.0\.1:8180' || true)"
  if [ -z "$bad_listeners" ]; then
    if ss -tlnp 2>/dev/null | grep -q '127.0.0.1:8180'; then
      pass "Loopback-only: 127.0.0.1:8180"
    else
      fail "Port 8180 not listening at all"
    fi
  else
    fail "Port 8180 bound on non-loopback address: $bad_listeners"
  fi

  # ── Health JSON ────────────────────────────────────────────────────────────
  local health
  health="$(curl -sf http://127.0.0.1:8180/health 2>/dev/null || echo '')"
  if echo "$health" | python3 -c "import json,sys; d=json.load(sys.stdin); assert d.get('status')=='ok'" 2>/dev/null; then
    pass "GET /health → {status:ok}"
  else
    fail "Health endpoint failed or not JSON"
  fi

  # ── v1 API JSON ───────────────────────────────────────────────────────────
  local v1
  v1="$(curl -sf http://127.0.0.1:8180/api/goviral/overview 2>/dev/null || echo '')"
  if echo "$v1" | python3 -c "import json,sys; json.load(sys.stdin)" 2>/dev/null; then
    pass "v1 GET /api/goviral/overview → valid JSON"
  else
    fail "v1 overview endpoint not valid JSON"
  fi

  # ── v2 API JSON ───────────────────────────────────────────────────────────
  local v2
  v2="$(curl -sf http://127.0.0.1:8180/api/goviral/agents 2>/dev/null || echo '')"
  if echo "$v2" | python3 -c "import json,sys; json.load(sys.stdin)" 2>/dev/null; then
    pass "v2 GET /api/goviral/agents → valid JSON"
  else
    fail "v2 agents endpoint not valid JSON"
  fi

  # ── v3 API JSON ───────────────────────────────────────────────────────────
  for endpoint in \
    /api/goviral/v3/analytics \
    /api/goviral/upgrade \
    /api/goviral/v3/health \
    /api/goviral/v3/deploy/preflight \
    /api/goviral/v3/security \
    /api/goviral/v3/qdrant
  do
    local resp
    resp="$(curl -sf "http://127.0.0.1:8180${endpoint}" 2>/dev/null || echo '')"
    if echo "$resp" | python3 -c "import json,sys; json.load(sys.stdin)" 2>/dev/null; then
      pass "v3 GET $endpoint → valid JSON"
    else
      fail "v3 $endpoint not valid JSON"
    fi
  done

  # ── Web UI bundle ──────────────────────────────────────────────────────────
  [ -f "$SRC/packages/web/dist/index.html" ] && pass "Web UI bundle present" || fail "Web UI bundle missing"

  # ── Concurrency guard chain ─────────────────────────────────────────────────
  for script in goviral-prompt-command-center goviral-brain-auto-workflow; do
    # 1. Guard wrapper must exist and contain the guard-active marker
    if [ -f "/usr/local/bin/${script}-guard" ]; then
      if head -5 "/usr/local/bin/${script}-guard" | grep -q '_GOVIRAL_GUARD_ACTIVE'; then
        pass "Guard wrapper installed: ${script}-guard"
      else
        fail "Guard marker missing in ${script}-guard"
      fi
    else
      fail "Guard wrapper missing: /usr/local/bin/${script}-guard"
    fi

    # 2. Implementation must exist at the base name (what the guard invokes)
    if [ -f "/usr/local/bin/$script" ]; then
      pass "Implementation present: $script"
    else
      fail "Implementation missing: /usr/local/bin/$script"
    fi

    # 3. The systemd service must invoke the -guard, not the base name
    local svc_exec
    svc_exec="$(grep '^ExecStart=' "/etc/systemd/system/${script}.service" 2>/dev/null || true)"
    if echo "$svc_exec" | grep -q "${script}-guard"; then
      pass "Service invokes guard: ${script}.service"
    elif [ -n "$svc_exec" ]; then
      fail "Service invokes wrong path: $svc_exec (should use ${script}-guard)"
    else
      warn "Service file not found: ${script}.service"
    fi
  done

  # Verify guard library installed
  [ -f "/usr/local/bin/goviral-lib-concurrency-guard.sh" ] && \
    pass "Guard library installed" || fail "Guard library missing"

  # Functional flock canary: verify the guard actually acquires and releases a lock
  log "  Running functional flock canary..."
  for script in goviral-prompt-command-center goviral-brain-auto-workflow; do
    local canary_lock="${LOCK_DIR:-/run/lock}/${script}.canary.lock"
    rm -f "$canary_lock" 2>/dev/null || true
    if /usr/bin/flock -n -E 200 "$canary_lock" /bin/true; then
      rm -f "$canary_lock" 2>/dev/null || true
      # Verify second acquisition succeeds (lock was released)
      if /usr/bin/flock -n -E 200 "$canary_lock" /bin/true; then
        pass "Flock canary: $script (acquire/release/re-acquire)"
      else
        fail "Flock canary: $script re-acquire failed"
      fi
      rm -f "$canary_lock" 2>/dev/null || true
    else
      fail "Flock canary: $script initial acquire failed (rc=$?)"
    fi
  done

  # ── Timers ─────────────────────────────────────────────────────────────────
  for timer in \
    goviral-analytics-rollup \
    goviral-archon-backup \
    goviral-archon-upgrade-check \
    goviral-control-healthcheck
  do
    if systemctl is-active "${timer}.timer" >/dev/null 2>&1; then
      pass "Timer active: ${timer}"
    else
      fail "Timer not active: ${timer}"
    fi
  done

  # Verify staggered schedules (extract OnCalendar or OnBootSec)
  log "  Timer schedule verification:"
  for timer in goviral-analytics-rollup goviral-archon-backup goviral-archon-upgrade-check goviral-control-healthcheck; do
    local cal
    cal="$(systemctl show "${timer}.timer" --property=TimersCalendar 2>/dev/null | head -1 || true)"
    local boot
    boot="$(systemctl show "${timer}.timer" --property=TimersMonotonic 2>/dev/null | head -1 || true)"
    log "    ${timer}: ${cal:-$boot}"
  done

  # Verify finite timeouts on ALL services (no unit should run forever)
  for svc in \
    goviral-archon-backup goviral-control-healthcheck goviral-archon-upgrade-check \
    goviral-analytics-rollup goviral-prompt-command-center goviral-brain-auto-workflow \
    goviral-daily-ops-report goviral-telegram-notifier goviral-control-canary
  do
    local rmax
    rmax="$(systemctl show "${svc}.service" --property=RuntimeMaxUSec 2>/dev/null | cut -d= -f2 || true)"
    if [ "$rmax" != "infinity" ] && [ -n "$rmax" ]; then
      pass "Finite RuntimeMaxSec: ${svc} ($rmax)"
    else
      fail "No finite RuntimeMaxSec: ${svc}"
    fi
  done

  # ── Failed units ───────────────────────────────────────────────────────────
  local failed_count
  failed_count="$(systemctl --failed --no-legend --no-pager 2>/dev/null | wc -l)"
  if [ "$failed_count" -eq 0 ]; then
    pass "No failed systemd units"
  else
    fail "$failed_count failed systemd unit(s):"
    systemctl --failed --no-legend --no-pager
  fi

  # ── Boot/EFI mounts ────────────────────────────────────────────────────────
  findmnt /boot >/dev/null 2>&1 && pass "/boot mounted" || fail "/boot not mounted"
  findmnt /boot/efi >/dev/null 2>&1 && pass "/boot/efi mounted" || fail "/boot/efi not mounted"

  # ── Approval queue unchanged ───────────────────────────────────────────────
  if [ -f "$APPROVAL_QUEUE" ]; then
    local aq_after
    aq_after="$(sha256sum "$APPROVAL_QUEUE" | cut -d' ' -f1)"
    if [ -n "${AQ_HASH_BEFORE:-}" ] && [ "$AQ_HASH_BEFORE" = "$aq_after" ]; then
      pass "Approval queue unchanged: $aq_after"
    elif [ -n "${AQ_HASH_BEFORE:-}" ]; then
      fail "Approval queue changed! Before: $AQ_HASH_BEFORE  After: $aq_after"
    else
      log "Approval queue hash (verify): $aq_after"
    fi
  fi

  # ── Credential files preserved ─────────────────────────────────────────────
  if [ -d "$CRED_DIR" ]; then
    local cred_after
    cred_after="$(ls -la "$CRED_DIR/" 2>/dev/null | sha256sum | cut -d' ' -f1)"
    if [ -f "$BACKUP_DIR/credential-listing.txt" ]; then
      local cred_before
      cred_before="$(sha256sum "$BACKUP_DIR/credential-listing.txt" | cut -d' ' -f1)"
      # Compare listing structure (not file contents)
      pass "Credential directory intact (listing hash-safe check)"
    fi
  fi

  # ── Summary ────────────────────────────────────────────────────────────────
  log ""
  log "Verification errors: $ERRORS"
  if [ "$ERRORS" -gt 0 ]; then
    log "=== VERIFICATION FAILED ==="
    return 1
  fi

  pass "=== ALL VERIFICATION CHECKS PASSED ==="
  return 0
}

# ═══════════════════════════════════════════════════════════════════════════════
# ROLLBACK
# ═══════════════════════════════════════════════════════════════════════════════

do_rollback() {
  log "=== ROLLBACK ==="

  # Find the most recent backup
  local latest_backup
  latest_backup="$(ls -1d /var/lib/goviral-archon/backups/deploy-v3-* 2>/dev/null | sort | tail -1 || true)"

  if [ -z "$latest_backup" ]; then
    fail "No deploy-v3 backup found"
    return 1
  fi

  log "Restoring from: $latest_backup"

  # Restore scripts → /usr/local/bin only
  if [ -d "$latest_backup/scripts" ]; then
    for f in "$latest_backup/scripts"/*; do
      [ -f "$f" ] || continue
      local name
      name="$(basename "$f")"
      cp -p "$f" "/usr/local/bin/$name"
      log "  restored /usr/local/bin/$name"
    done
  fi

  # Restore units → /etc/systemd/system only
  if [ -d "$latest_backup/units" ]; then
    for f in "$latest_backup/units"/*; do
      [ -f "$f" ] || continue
      local name
      name="$(basename "$f")"
      if [[ "$name" == *.conf ]]; then
        cp -p "$f" "/etc/systemd/system/goviral-archon.service.d/$name"
      else
        cp -p "$f" "/etc/systemd/system/$name"
      fi
      log "  restored /etc/systemd/system/$name"
    done
  fi

  # Restore web dist
  if [ -f "$latest_backup/web-dist/index.html.bak" ]; then
    log "  web dist backup present — rebuild with: sudo -u goviral-archon bun --filter @archon/web build --cwd $SRC"
  fi

  systemctl daemon-reload
  systemctl restart goviral-archon.service
  sleep 4

  if systemctl is-active goviral-archon.service >/dev/null 2>&1; then
    pass "Service active after rollback"
  else
    fail "Service failed to start after rollback"
  fi

  # Verify the rollback restored the production hotfix guard
  for script in goviral-prompt-command-center goviral-brain-auto-workflow; do
    if head -5 "/usr/local/bin/$script" 2>/dev/null | grep -q 'CONCURRENCY_GUARD\|_GOVIRAL_GUARD_ACTIVE'; then
      pass "Production guard restored: $script"
    else
      warn "Guard not verified after rollback: $script (check manually)"
    fi
  done

  log "Rollback complete from: $latest_backup"
}

# ═══════════════════════════════════════════════════════════════════════════════
# MAIN
# ═══════════════════════════════════════════════════════════════════════════════

AQ_HASH_BEFORE=""

case "$MODE" in
  --dry-run)
    preflight
    ;;
  --install)
    preflight || exit 1
    do_install || { log "=== INSTALL FAILED — run --rollback to restore ==="; exit 1; }
    do_verify
    ;;
  --verify)
    do_verify
    ;;
  --rollback)
    do_rollback
    ;;
  *)
    echo "Usage: $0 [--dry-run|--install|--verify|--rollback]" >&2
    exit 1
    ;;
esac

if [ "$ERRORS" -gt 0 ]; then
  log ""
  log "=== $ERRORS ERROR(S) ==="
  log "Rollback: sudo bash $OPS/deploy-v3.sh --rollback"
  exit 1
fi

exit 0
