#!/usr/bin/env bash
# deploy-concurrency-fix.sh — Idempotent deployment of the permanent concurrency guard.
#
# Replaces the production hotfix wrapper scripts with the canonical
# concurrency-guarded versions from the repository, installs the shared
# guard library, and applies systemd hardening.
#
# This script is idempotent — running it multiple times produces the same result.
# It does NOT restart services or reload timers automatically.
#
# Usage: sudo bash /opt/goviral-archon-src/ops/goviral-control-plane/deploy-concurrency-fix.sh
#
# Rollback: sudo bash /opt/goviral-archon-src/ops/goviral-control-plane/deploy-concurrency-fix.sh --rollback
# ──────────────────────────────────────────────────────────────────────────────
set -Eeuo pipefail

OPS="/opt/goviral-archon-src/ops/goviral-control-plane"
BACKUP_DIR="/var/lib/goviral-archon/backups/concurrency-fix"
METRICS_DIR="/var/lib/goviral-archon/.archon/concurrency-metrics"

if [ "$(id -u)" -ne 0 ]; then
  echo "ERROR: This script must be run as root." >&2
  exit 1
fi

# ── Rollback mode ────────────────────────────────────────────────────────────

if [ "${1:-}" = "--rollback" ]; then
  echo "GoViral Concurrency Fix — Rollback"
  echo "==================================="
  echo

  if [ ! -d "$BACKUP_DIR" ]; then
    echo "ERROR: No backup directory found at $BACKUP_DIR" >&2
    echo "Cannot rollback — no previous state saved." >&2
    exit 1
  fi

  echo "[1/3] Restoring original scripts..."
  for f in "$BACKUP_DIR"/usr-local-bin-*; do
    [ -f "$f" ] || continue
    original_name="${f##*/usr-local-bin-}"
    cp -p "$f" "/usr/local/bin/$original_name"
    echo "  restored $original_name"
  done

  echo
  echo "[2/3] Restoring original systemd units..."
  for f in "$BACKUP_DIR"/systemd-*; do
    [ -f "$f" ] || continue
    original_name="${f##*/systemd-}"
    cp -p "$f" "/etc/systemd/system/$original_name"
    echo "  restored $original_name"
  done

  echo
  echo "[3/3] Reloading systemd..."
  systemctl daemon-reload
  echo "  daemon reloaded"

  echo
  echo "Rollback complete. Review with:"
  echo "  systemctl cat goviral-prompt-command-center.service"
  echo "  systemctl cat goviral-brain-auto-workflow.service"
  exit 0
fi

# ── Deployment mode ──────────────────────────────────────────────────────────

echo "GoViral Concurrency Fix — Deployment"
echo "====================================="
echo

# ── Step 1: Backup current production state ──────────────────────────────────
echo "[1/6] Backing up current production state..."
mkdir -p "$BACKUP_DIR"

for script in goviral-prompt-command-center goviral-brain-auto-workflow; do
  if [ -f "/usr/local/bin/$script" ]; then
    cp -p "/usr/local/bin/$script" "$BACKUP_DIR/usr-local-bin-${script}"
    echo "  backed up /usr/local/bin/$script"
  fi
done

for unit in \
  goviral-prompt-command-center.service \
  goviral-prompt-command-center.timer \
  goviral-brain-auto-workflow.service \
  goviral-brain-auto-workflow.timer
do
  if [ -f "/etc/systemd/system/$unit" ]; then
    cp -p "/etc/systemd/system/$unit" "$BACKUP_DIR/systemd-${unit}"
    echo "  backed up /etc/systemd/system/$unit"
  fi
done

# ── Step 2: Install shared concurrency guard library ─────────────────────────
echo
echo "[2/6] Installing concurrency guard library..."
install -o root -g root -m 0644 \
  "$OPS/lib-concurrency-guard.sh" \
  /usr/local/bin/goviral-lib-concurrency-guard.sh
echo "  installed goviral-lib-concurrency-guard.sh"

# ── Step 3: Install guard wrappers ───────────────────────────────────────────
echo
echo "[3/6] Installing concurrency guard wrappers..."

# If production hotfix renamed the original to .impl.*, we need to restore it first.
# The guard wrappers call the original script name via the library (no .impl suffix).
for script in goviral-prompt-command-center goviral-brain-auto-workflow; do
  impl_file=$(ls "/usr/local/bin/${script}.impl."* 2>/dev/null | head -1 || true)

  if [ -n "$impl_file" ] && [ -f "$impl_file" ]; then
    # Production hotfix is in place: restore original from .impl file
    echo "  restoring original $script from hotfix .impl backup"
    cp -p "$impl_file" "/usr/local/bin/$script"
    chmod 0755 "/usr/local/bin/$script"
    # Keep the .impl file for safety — do NOT delete it
    echo "  kept $impl_file (safety backup)"
  fi

  # Install the guard wrapper as a separate file
  install -o root -g root -m 0755 \
    "$OPS/${script}-guard" \
    "/usr/local/bin/${script}-guard"
  echo "  installed ${script}-guard"
done

# ── Step 4: Rewire systemd to use guarded wrappers ──────────────────────────
echo
echo "[4/6] Installing hardened systemd units..."

for unit in \
  goviral-prompt-command-center.service \
  goviral-prompt-command-center.timer \
  goviral-brain-auto-workflow.service \
  goviral-brain-auto-workflow.timer
do
  install -o root -g root -m 0644 "$OPS/$unit" "/etc/systemd/system/$unit"
  echo "  installed $unit"
done

# ── Step 5: Create metrics directory ─────────────────────────────────────────
echo
echo "[5/6] Creating metrics directory..."
mkdir -p "$METRICS_DIR"
chown root:root "$METRICS_DIR"
chmod 0755 "$METRICS_DIR"
echo "  created $METRICS_DIR"

# ── Step 6: Reload systemd (but do NOT restart services) ─────────────────────
echo
echo "[6/6] Reloading systemd daemon..."
systemctl daemon-reload
echo "  daemon reloaded (services NOT restarted)"

echo
echo "Deployment complete."
echo
echo "Production hotfix preserved — .impl.* files NOT deleted."
echo
echo "Next steps (manual):"
echo "  1. Verify units:  systemctl cat goviral-prompt-command-center.service"
echo "  2. Verify timers: systemctl list-timers | grep goviral"
echo "  3. Rollback:      sudo bash $OPS/deploy-concurrency-fix.sh --rollback"
echo
echo "To activate hardened timers (optional — wait for maintenance window):"
echo "  systemctl restart goviral-prompt-command-center.timer"
echo "  systemctl restart goviral-brain-auto-workflow.timer"
