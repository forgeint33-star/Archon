#!/usr/bin/env bash
# lib-quarantine.sh — Quarantine contract for GoViral heavy automation timers.
#
# When the quarantine marker exists, no supervisor, watchdog, repair, or deploy
# script may start, enable, or re-enable the four heavy automation timers.
#
# MARKER: /run/goviral-heavy-automation-quarantined
#   - Created by an operator: touch /run/goviral-heavy-automation-quarantined
#   - Removed by an operator: rm /run/goviral-heavy-automation-quarantined
#   - Lives in /run so it clears automatically on reboot (intentional).
#
# Usage:
#   source /usr/local/bin/goviral-lib-quarantine.sh
#   if is_heavy_quarantined; then echo "quarantined"; fi
#   require_not_quarantined "my-caller-name" || exit 0
#
# ──────────────────────────────────────────────────────────────────────────────

set -u -o pipefail

# Allow override for testing
QUARANTINE_MARKER="${GOVIRAL_QUARANTINE_MARKER:-/run/goviral-heavy-automation-quarantined}"

# The four heavy timers subject to quarantine
QUARANTINED_TIMERS=(
  goviral-unified-autopilot.timer
  goviral-nl-autopilot-router.timer
  goviral-prompt-command-center.timer
  goviral-brain-auto-workflow.timer
)

# Also quarantine their dependent timers that the supervisor manages
QUARANTINED_SUPERVISOR_TIMERS=(
  goviral-brain-auto-workflow.timer
  goviral-agent-council-planner.timer
  goviral-prompt-command-center.timer
  goviral-nl-autopilot-router.timer
  goviral-unified-autopilot.timer
  goviral-workspace-guard.timer
)

# ── is_heavy_quarantined ─────────────────────────────────────────────────────
# Returns 0 (true) when quarantine is active.
is_heavy_quarantined() {
  [ -f "$QUARANTINE_MARKER" ]
}

# ── require_not_quarantined ──────────────────────────────────────────────────
# Prints quarantined=true and returns 1 when quarantine is active.
# Callers should: require_not_quarantined "caller" || exit 0
require_not_quarantined() {
  local caller="${1:-unknown}"
  if is_heavy_quarantined; then
    echo "quarantined=true"
    echo "caller=${caller}"
    echo "marker=${QUARANTINE_MARKER}"
    echo "action=skipped (heavy automation quarantined)"
    return 1
  fi
  return 0
}

# ── is_quarantined_timer ─────────────────────────────────────────────────────
# Returns 0 (true) if the given unit name is one of the quarantined timers.
is_quarantined_timer() {
  local unit="$1"
  for qt in "${QUARANTINED_TIMERS[@]}"; do
    if [ "$unit" = "$qt" ]; then
      return 0
    fi
  done
  return 1
}

# ── safe_enable_timer ────────────────────────────────────────────────────────
# Enable a timer only if it is NOT quarantined (or quarantine is not active).
# Returns 0 on success or skip, 1 on refused-by-quarantine.
safe_enable_timer() {
  local timer="$1"
  local caller="${2:-unknown}"

  if is_heavy_quarantined && is_quarantined_timer "$timer"; then
    echo "REFUSED: $timer quarantined (caller=$caller, marker=$QUARANTINE_MARKER)" >&2
    return 1
  fi

  systemctl enable --now "$timer" >/dev/null 2>&1
}
