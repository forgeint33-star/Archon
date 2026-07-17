#!/usr/bin/env bash
# lib-canonical-dispatch.sh — Canonical dispatch contract for GoViral automation.
#
# RULE: No orchestrator may directly execute a mutating leaf implementation.
#       Mutating execution MUST pass through the canonical guard + systemd boundary.
#
# This library provides:
#   1. canonical_dispatch() — route mutating calls through systemd
#   2. Global backpressure enforcement
#   3. Per-workflow lock without blocking legitimate cross-workflow nesting
#   4. Parent cancellation propagation (no orphan children)
#
# Usage in an orchestrator:
#   source /usr/local/bin/goviral-lib-canonical-dispatch.sh
#   canonical_dispatch "goviral-prompt-command-center" submit --prompt "..." --write
#   canonical_dispatch "goviral-brain-auto-workflow" run-all --write
#
# Read-only commands (status, dashboard) are exec'd directly (no systemd boundary).
# ──────────────────────────────────────────────────────────────────────────────

set -u -o pipefail

# Allow override via environment for testing
LOCK_DIR="${GOVIRAL_LOCK_DIR:-/run/lock}"
METRICS_DIR="${GOVIRAL_METRICS_DIR:-/var/lib/goviral-archon/.archon/concurrency-metrics}"
BIN_DIR="${GOVIRAL_BIN_DIR:-/usr/local/bin}"
CAPACITY_STATE="${GOVIRAL_CAPACITY_STATE:-/run/goviral-capacity}"
QUARANTINE_MARKER="${GOVIRAL_QUARANTINE_MARKER:-/run/goviral-heavy-automation-quarantined}"

# ── Global backpressure configuration ─────────────────────────────────────────
MAX_HEAVY_WORKFLOWS="${GOVIRAL_MAX_HEAVY_WORKFLOWS:-2}"

# Heavy workflows: only these count toward global capacity
HEAVY_WORKFLOWS=(
  goviral-unified-autopilot
  goviral-nl-autopilot-router
  goviral-prompt-command-center
  goviral-brain-auto-workflow
)

# ── Quarantine check ─────────────────────────────────────────────────────────
_is_quarantined_heavy() {
  local workflow="$1"
  if [ ! -f "$QUARANTINE_MARKER" ]; then
    return 1  # Not quarantined
  fi
  for wf in "${HEAVY_WORKFLOWS[@]}"; do
    if [ "$workflow" = "$wf" ]; then
      return 0  # This heavy workflow is quarantined
    fi
  done
  return 1  # Not a heavy workflow
}

# ── Mutating command detection ────────────────────────────────────────────────
_is_mutating_command() {
  local args="$*"
  # Mutating patterns: run-all --write, submit ... --write, execute, apply, deploy
  case "$args" in
    *"--write"*) return 0 ;;
    *"execute"*) return 0 ;;
    *"apply"*)   return 0 ;;
    *"deploy"*)  return 0 ;;
    *"start"*)   return 0 ;;
    *)           return 1 ;;
  esac
}

# ── Same-workflow recursion detection ─────────────────────────────────────────
# Uses per-workflow env vars: _GOVIRAL_DISPATCH_<NORMALIZED_NAME>=1
# Different-workflow nesting is allowed (no generic flag that blocks everything)
_check_recursion() {
  local workflow="$1"
  local env_key="_GOVIRAL_DISPATCH_$(echo "$workflow" | tr '[:lower:]-' '[:upper:]_')"
  local current_value
  eval "current_value=\${${env_key}:-}"

  if [ "${current_value}" = "1" ]; then
    return 1  # Recursion detected
  fi
  return 0
}

_export_dispatch_marker() {
  local workflow="$1"
  local env_key="_GOVIRAL_DISPATCH_$(echo "$workflow" | tr '[:lower:]-' '[:upper:]_')"
  export "${env_key}=1"
}

# ── Global capacity check ─────────────────────────────────────────────────────
_count_active_heavy() {
  local count=0
  for wf in "${HEAVY_WORKFLOWS[@]}"; do
    local lock_file="${LOCK_DIR}/${wf}.lock"
    if [ -f "$lock_file" ] && ! /usr/bin/flock -n "$lock_file" true 2>/dev/null; then
      count=$((count + 1))
    fi
  done
  echo "$count"
}

_check_capacity() {
  local active
  active="$(_count_active_heavy)"
  local available=$((MAX_HEAVY_WORKFLOWS - active))

  mkdir -p "$CAPACITY_STATE" 2>/dev/null || true

  # Write capacity state (atomic via temp file)
  local state_file="${CAPACITY_STATE}/state.json"
  local tmp_file="${state_file}.tmp.$$"
  printf '{"active_heavy_workflows":%d,"max_heavy_workflows":%d,"capacity_available":%d,"last_capacity_check_at":"%s"}\n' \
    "$active" "$MAX_HEAVY_WORKFLOWS" "$available" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    > "$tmp_file" && mv "$tmp_file" "$state_file"

  if [ "$available" -le 0 ]; then
    return 1  # No capacity
  fi
  return 0
}

_record_capacity_deferral() {
  local workflow="$1"
  local ts
  ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

  mkdir -p "$CAPACITY_STATE" 2>/dev/null || true
  local deferral_file="${CAPACITY_STATE}/deferrals.jsonl"

  printf '{"ts":"%s","workflow":"%s","reason":"capacity_full","active":%s,"max":%d,"deferred_due_to_capacity":true}\n' \
    "$ts" "$workflow" "$(_count_active_heavy)" "$MAX_HEAVY_WORKFLOWS" \
    >> "$deferral_file" 2>/dev/null || true
}

# ── Emit dispatch metric ──────────────────────────────────────────────────────
_emit_dispatch_metric() {
  local workflow="$1"
  local status="$2"
  local detail="${3:-}"
  local ts
  ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

  mkdir -p "$METRICS_DIR" 2>/dev/null || true
  local metrics_file="${METRICS_DIR}/${workflow}-dispatch.jsonl"

  printf '{"ts":"%s","workflow":"%s","status":"%s","detail":"%s"}\n' \
    "$ts" "$workflow" "$status" "$detail" \
    >> "$metrics_file" 2>/dev/null || true
}

# ── Child PID tracking for parent cancellation ────────────────────────────────
_DISPATCH_CHILD_PIDS=()

_cleanup_children() {
  for pid in "${_DISPATCH_CHILD_PIDS[@]:-}"; do
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      kill -TERM "$pid" 2>/dev/null || true
    fi
  done
}

# Register the cleanup handler (additive — doesn't replace existing traps)
trap '_cleanup_children' EXIT TERM INT

# ═══════════════════════════════════════════════════════════════════════════════
# canonical_dispatch WORKFLOW_NAME [ARGS...]
#
# Routes mutating calls through the canonical guard (systemd-start when available,
# guard-wrapper fallback when not). Read-only calls exec directly.
#
# Set GOVIRAL_DISPATCH_MODE=guard to skip the systemd path and use the guard
# wrapper directly (for testing or environments without systemd unit files).
#
# Exit behavior:
#   - Read-only: exec's directly, never returns
#   - Mutating (success): returns 0
#   - Mutating (overlap_skipped): returns 0, prints overlap_skipped=true
#   - Mutating (deferred): returns 0, prints deferred_due_to_capacity=true
#   - Mutating (recursion): returns 99
#   - Mutating (failure): returns the implementation exit code
# ═══════════════════════════════════════════════════════════════════════════════
canonical_dispatch() {
  local workflow="$1"
  shift

  local guard="${BIN_DIR}/${workflow}-guard"
  local impl="${BIN_DIR}/${workflow}"
  local dispatch_mode="${GOVIRAL_DISPATCH_MODE:-auto}"

  # ── 1. Read-only commands bypass everything ──────────────────────────────
  if ! _is_mutating_command "$@"; then
    if [ -x "$impl" ]; then
      exec "$impl" "$@"
    else
      echo "ERROR: implementation not found: $impl" >&2
      return 127
    fi
  fi

  # ── 2. Same-workflow recursion check ─────────────────────────────────────
  if ! _check_recursion "$workflow"; then
    echo "ERROR: recursive dispatch of $workflow detected — aborting safely" >&2
    _emit_dispatch_metric "$workflow" "recursion_rejected" "same_workflow=$workflow"
    return 99
  fi

  # ── 2b. Quarantine check ────────────────────────────────────────────────
  if _is_quarantined_heavy "$workflow"; then
    echo "quarantined=true"
    echo "workflow=${workflow}"
    echo "marker=${QUARANTINE_MARKER}"
    echo "action=refused (heavy automation quarantined)"
    _emit_dispatch_metric "$workflow" "quarantine_refused" "marker=$QUARANTINE_MARKER"
    return 0
  fi

  # ── 3. Global capacity check ────────────────────────────────────────────
  if ! _check_capacity; then
    echo "deferred_due_to_capacity=true"
    echo "workflow=${workflow}"
    echo "active_heavy_workflows=$(_count_active_heavy)"
    echo "max_heavy_workflows=${MAX_HEAVY_WORKFLOWS}"
    _record_capacity_deferral "$workflow"
    _emit_dispatch_metric "$workflow" "deferred" "capacity_full"
    return 0
  fi

  # ── 4. Mark this workflow as in-flight (recursion guard for children) ────
  _export_dispatch_marker "$workflow"

  # ── 5. Dispatch through canonical guard ──────────────────────────────────
  # Priority: systemd service boundary > guard wrapper > error
  # dispatch_mode=guard skips systemd (for testing)
  local rc=0

  if [ "$dispatch_mode" != "guard" ] && \
     command -v systemctl >/dev/null 2>&1 && \
     systemctl cat "${workflow}.service" >/dev/null 2>&1; then
    # Preferred: start via systemd (correct cgroup attribution)
    _emit_dispatch_metric "$workflow" "systemd_start" "via=systemctl"
    systemctl start "${workflow}.service" 2>/dev/null &
    local child_pid=$!
    _DISPATCH_CHILD_PIDS+=("$child_pid")
    wait "$child_pid" || rc=$?

    # systemctl start returns 0 even if the service exits non-zero for oneshot;
    # check the actual result
    local svc_result
    svc_result="$(systemctl show -p Result "${workflow}.service" 2>/dev/null | cut -d= -f2 || echo unknown)"

    if [ "$svc_result" = "success" ]; then
      _emit_dispatch_metric "$workflow" "completed" "via=systemd"
      return 0
    elif [ "$svc_result" = "exit-code" ]; then
      local exit_status
      exit_status="$(systemctl show -p ExecMainStatus "${workflow}.service" 2>/dev/null | cut -d= -f2 || echo 1)"
      _emit_dispatch_metric "$workflow" "failed" "via=systemd,exit=$exit_status"
      return "${exit_status:-1}"
    else
      # Service might have been skipped by its own guard
      _emit_dispatch_metric "$workflow" "completed" "via=systemd,result=$svc_result"
      return 0
    fi

  elif [ -x "$guard" ]; then
    # Fallback: guard wrapper directly (still gets flock protection)
    _emit_dispatch_metric "$workflow" "guard_start" "via=guard_wrapper"
    "$guard" "$@" &
    local child_pid=$!
    _DISPATCH_CHILD_PIDS+=("$child_pid")
    wait "$child_pid" || rc=$?
    if [ "$rc" -eq 0 ]; then
      _emit_dispatch_metric "$workflow" "completed" "via=guard_wrapper"
    else
      _emit_dispatch_metric "$workflow" "failed" "via=guard_wrapper,exit=$rc"
    fi
    return "$rc"

  else
    # No guard available — REFUSE to dispatch mutating command directly
    echo "ERROR: no canonical guard for $workflow — refusing direct mutating execution" >&2
    _emit_dispatch_metric "$workflow" "refused" "no_guard_or_service"
    return 126
  fi
}

# ── Capacity query (for external tools) ───────────────────────────────────────
goviral_capacity_status() {
  local active
  active="$(_count_active_heavy)"
  local available=$((MAX_HEAVY_WORKFLOWS - active))
  local deferred=0

  if [ -f "${CAPACITY_STATE}/deferrals.jsonl" ]; then
    deferred="$(wc -l < "${CAPACITY_STATE}/deferrals.jsonl" 2>/dev/null || echo 0)"
  fi

  printf 'active_heavy_workflows=%d\n' "$active"
  printf 'max_heavy_workflows=%d\n' "$MAX_HEAVY_WORKFLOWS"
  printf 'capacity_available=%d\n' "$available"
  printf 'deferred_due_to_capacity=%d\n' "$deferred"
  printf 'last_capacity_check_at=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
