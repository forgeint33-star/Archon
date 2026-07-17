#!/usr/bin/env bash
# lib-quarantine.sh — Quarantine contract for GoViral heavy automation timers.
#
# When the quarantine marker exists, no supervisor, watchdog, repair, or deploy
# script may start, enable, or re-enable the heavy automation timers.
#
# MARKERS (checked in order):
#   1. PERSISTENT (authoritative, survives reboot):
#      /var/lib/goviral-archon/.archon/heavy-automation-quarantined
#   2. RUNTIME (optional mirror, clears on reboot):
#      /run/goviral-heavy-automation-quarantined
#
# Either marker activates quarantine. The persistent marker is the canonical
# source of truth. The runtime marker is an optional fast-path for environments
# where /var is slow or unavailable.
#
# Activation/deactivation is via goviral-quarantine activate|deactivate (root).
# Never remove the marker files directly — use the admin command.
#
# Usage:
#   source /usr/local/bin/goviral-lib-quarantine.sh
#   if is_heavy_quarantined; then echo "quarantined"; fi
#   require_not_quarantined "my-caller-name" || exit 0
#
# ──────────────────────────────────────────────────────────────────────────────

set -u -o pipefail

# Allow override for testing
QUARANTINE_MARKER_PERSISTENT="${GOVIRAL_QUARANTINE_MARKER_PERSISTENT:-/var/lib/goviral-archon/.archon/heavy-automation-quarantined}"
QUARANTINE_MARKER_RUNTIME="${GOVIRAL_QUARANTINE_MARKER_RUNTIME:-/run/goviral-heavy-automation-quarantined}"

# Legacy env var support: if GOVIRAL_QUARANTINE_MARKER is set, use it as the
# persistent marker (backwards compat with Phase 0.5.1 tests)
if [ -n "${GOVIRAL_QUARANTINE_MARKER:-}" ]; then
  QUARANTINE_MARKER_PERSISTENT="$GOVIRAL_QUARANTINE_MARKER"
  QUARANTINE_MARKER_RUNTIME="$GOVIRAL_QUARANTINE_MARKER"
fi

# The five quarantined timer units (4 heavy + supervisor)
QUARANTINED_TIMERS=(
  goviral-unified-autopilot.timer
  goviral-nl-autopilot-router.timer
  goviral-prompt-command-center.timer
  goviral-brain-auto-workflow.timer
  goviral-autopilot-supervisor.timer
)

# Full set of timers managed by the supervisor (superset of QUARANTINED_TIMERS)
QUARANTINED_SUPERVISOR_TIMERS=(
  goviral-brain-auto-workflow.timer
  goviral-agent-council-planner.timer
  goviral-prompt-command-center.timer
  goviral-nl-autopilot-router.timer
  goviral-unified-autopilot.timer
  goviral-workspace-guard.timer
  goviral-autopilot-supervisor.timer
)

# ── is_heavy_quarantined ─────────────────────────────────────────────────────
# Returns 0 (true) when quarantine is active (either marker present).
is_heavy_quarantined() {
  [ -f "$QUARANTINE_MARKER_PERSISTENT" ] || [ -f "$QUARANTINE_MARKER_RUNTIME" ]
}

# ── require_not_quarantined ──────────────────────────────────────────────────
# Prints quarantined=true and returns 1 when quarantine is active.
# Callers should: require_not_quarantined "caller" || exit 0
require_not_quarantined() {
  local caller="${1:-unknown}"
  if is_heavy_quarantined; then
    echo "quarantined=true"
    echo "caller=${caller}"
    echo "persistent_marker=${QUARANTINE_MARKER_PERSISTENT}"
    echo "runtime_marker=${QUARANTINE_MARKER_RUNTIME}"
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
    echo "REFUSED: $timer quarantined (caller=$caller)" >&2
    return 1
  fi

  systemctl enable --now "$timer" >/dev/null 2>&1
}

# ── quarantine_check_for_service ─────────────────────────────────────────────
# Intended for use as an ExecStartPre script or guard entry point.
# Exits 0 if not quarantined (allow service to start).
# Exits 1 if quarantined (prevents service from starting).
quarantine_check_for_service() {
  local service="${1:-unknown-service}"
  if is_heavy_quarantined; then
    echo "QUARANTINED: $service refused to start (marker present)" >&2
    return 1
  fi
  return 0
}
