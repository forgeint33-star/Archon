#!/usr/bin/env bash
# GoViral Control Plane v2 deployment script.
# Must be run as root. Installs ops scripts and systemd units from the
# tracked repository into their production locations.
#
# Usage: sudo bash /opt/goviral-archon-src/ops/goviral-control-plane/deploy-v2.sh
set -Eeuo pipefail

OPS="/opt/goviral-archon-src/ops/goviral-control-plane"

if [ "$(id -u)" -ne 0 ]; then
  echo "ERROR: This script must be run as root." >&2
  exit 1
fi

echo "GoViral Control Plane v2 — Deployment"
echo "======================================"
echo

# ─── Install scripts to /usr/local/bin ────────────────────────────────────────
echo "[1/5] Installing scripts to /usr/local/bin..."

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
  install -o root -g root -m 0755 "$OPS/$script" "/usr/local/bin/$script"
  echo "  installed $script"
done

# ─── Install systemd units ───────────────────────────────────────────────────
echo
echo "[2/5] Installing systemd units..."

for unit in \
  goviral-archon-backup.service \
  goviral-archon-backup.timer \
  goviral-control-healthcheck.service \
  goviral-control-healthcheck.timer \
  goviral-control-canary.service \
  goviral-telegram-notifier.service \
  goviral-telegram-notifier.timer \
  goviral-daily-ops-report.service \
  goviral-daily-ops-report.timer \
  goviral-archon-upgrade-check.service \
  goviral-archon-upgrade-check.timer \
  goviral-analytics-rollup.service \
  goviral-analytics-rollup.timer
do
  install -o root -g root -m 0644 "$OPS/$unit" "/etc/systemd/system/$unit"
  echo "  installed $unit"
done

# ─── Install actions drop-in ─────────────────────────────────────────────────
echo
echo "[3/5] Installing actions drop-in..."

mkdir -p /etc/systemd/system/goviral-archon.service.d
install -o root -g root -m 0644 "$OPS/goviral-archon-actions.conf" \
  /etc/systemd/system/goviral-archon.service.d/goviral-archon-actions.conf
echo "  installed goviral-archon-actions.conf"

# ─── Install sudoers ─────────────────────────────────────────────────────────
echo
echo "[4/5] Installing sudoers policy..."

install -o root -g root -m 0440 "$OPS/goviral-archon-control.sudoers" \
  /etc/sudoers.d/goviral-archon-control
visudo -cf /etc/sudoers.d/goviral-archon-control
echo "  sudoers validated and installed"

# ─── Create state directories ────────────────────────────────────────────────
echo
echo "[5/5] Creating state directories..."

install -d -o goviral-archon -g goviral-archon -m 0700 \
  /var/lib/goviral-archon/.archon/notifications \
  /var/lib/goviral-archon/.archon/upgrade-checks \
  /var/lib/goviral-archon/.archon/restore-drills \
  /var/lib/goviral-archon/.archon/analytics \
  /var/lib/goviral-archon/.archon/saved-filters

mkdir -p /etc/goviral/credentials
chmod 0700 /etc/goviral/credentials
chown root:root /etc/goviral/credentials

echo "  state directories created"

# ─── Reload systemd ──────────────────────────────────────────────────────────
echo
echo "Reloading systemd daemon..."
systemctl daemon-reload

# ─── Enable timers that have no external credential dependency ────────────────
echo
echo "Enabling safe timers..."
systemctl enable --now goviral-archon-backup.timer
echo "  goviral-archon-backup.timer enabled"
systemctl enable --now goviral-control-healthcheck.timer
echo "  goviral-control-healthcheck.timer enabled"
systemctl enable --now goviral-archon-upgrade-check.timer
echo "  goviral-archon-upgrade-check.timer enabled"
systemctl enable --now goviral-analytics-rollup.timer
echo "  goviral-analytics-rollup.timer enabled"

# ─── Telegram timers (only if credentials exist) ─────────────────────────────
if [ -f /etc/goviral/credentials/telegram-bot-token ] && \
   [ -f /etc/goviral/credentials/telegram-chat-id ]; then
  systemctl enable --now goviral-telegram-notifier.timer
  echo "  goviral-telegram-notifier.timer enabled (credentials found)"
  systemctl enable --now goviral-daily-ops-report.timer
  echo "  goviral-daily-ops-report.timer enabled (credentials found)"
else
  echo "  goviral-telegram-notifier.timer NOT enabled (no credentials)"
  echo "  goviral-daily-ops-report.timer NOT enabled (no credentials)"
  echo "  Run: sudo goviral-telegram-configure"
fi

echo
echo "Deployment complete."
echo
echo "Next steps:"
echo "  1. Restart goviral-archon: systemctl restart goviral-archon"
echo "  2. Wait for service: sleep 10 && systemctl is-active goviral-archon"
echo "  3. Verify v2 APIs: curl -s http://127.0.0.1:8180/api/goviral/telegram | python3 -m json.tool"
echo "  4. Configure Telegram: sudo goviral-telegram-configure"
echo "  5. Configure ClickUp: sudo goviral-clickup-configure"
echo "  6. Configure off-site backup: sudo goviral-offsite-configure"
