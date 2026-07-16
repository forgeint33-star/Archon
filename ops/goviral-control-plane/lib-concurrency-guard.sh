#!/usr/bin/env bash
# lib-concurrency-guard.sh — Shared concurrency guard for GoViral leaf workflows.
#
# Provides a non-blocking flock guard that:
#   - Allows exactly one "run-all --write" execution per leaf workflow
#   - Exits successfully (0) when an overlap is detected
#   - Propagates genuine implementation errors
#   - Emits structured metrics to a JSONL audit log
#   - Does NOT guard non-mutating commands (status, dashboard, etc.)
#
# Usage in a leaf-workflow wrapper script:
#   source /usr/local/bin/goviral-lib-concurrency-guard.sh
#   concurrency_guard "goviral-prompt-command-center" "$@"
#
# The function never returns — it either execs the implementation or exits.
# ──────────────────────────────────────────────────────────────────────────────

set -u -o pipefail

# Allow override via environment for testing; default to production paths
LOCK_DIR="${GOVIRAL_LOCK_DIR:-/run/lock}"
METRICS_DIR="${GOVIRAL_METRICS_DIR:-/var/lib/goviral-archon/.archon/concurrency-metrics}"

# concurrency_guard WORKFLOW_NAME [ARGS...]
#
# WORKFLOW_NAME — base name of the script (e.g. "goviral-prompt-command-center").
#                 The implementation must exist at /usr/local/bin/${WORKFLOW_NAME}.
#
# If ARGS begin with "run-all --write", the flock guard activates.
# Otherwise the implementation is exec'd directly (no lock).
concurrency_guard() {
  local workflow_name="$1"
  shift

  local impl="/usr/local/bin/${workflow_name}"
  local lock_file="${LOCK_DIR}/${workflow_name}.lock"

  mkdir -p "$METRICS_DIR" 2>/dev/null || true

  # Only guard the mutating path
  if [ "${1:-}" = "run-all" ] && [ "${2:-}" = "--write" ]; then
    _guarded_exec "$workflow_name" "$impl" "$lock_file" "$@"
  else
    # Non-mutating command — pass through directly
    exec "$impl" "$@"
  fi
}

# _guarded_exec WORKFLOW_NAME IMPL LOCK_FILE [ARGS...]
_guarded_exec() {
  local workflow_name="$1"
  local impl="$2"
  local lock_file="$3"
  shift 3

  local start_epoch
  start_epoch="$(date +%s)"
  local start_ts
  start_ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

  # Non-blocking flock. Exit code 200 = lock busy (overlap).
  if /usr/bin/flock -n -E 200 "$lock_file" "$impl" "$@"; then
    local end_epoch
    end_epoch="$(date +%s)"
    local duration=$(( end_epoch - start_epoch ))

    _emit_metric "$workflow_name" "completed" "$start_ts" "$duration" ""
    exit 0
  else
    local rc=$?
    local end_epoch
    end_epoch="$(date +%s)"
    local duration=$(( end_epoch - start_epoch ))

    if [ "$rc" -eq 200 ]; then
      # Lock was held by another process — overlap skipped
      printf '%s\n' \
        "overlap_skipped=true" \
        "workflow=${workflow_name}"
      _emit_metric "$workflow_name" "overlap_skipped" "$start_ts" "$duration" ""
      exit 0
    fi

    # Genuine implementation error — propagate
    _emit_metric "$workflow_name" "failed" "$start_ts" "$duration" "exit_code=${rc}"
    exit "$rc"
  fi
}

# _emit_metric WORKFLOW STATUS STARTED_AT DURATION_SECS [DETAIL]
_emit_metric() {
  local workflow="$1"
  local status="$2"
  local started_at="$3"
  local duration="$4"
  local detail="${5:-}"
  local ts
  ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

  local metrics_file="${METRICS_DIR}/${workflow}.jsonl"

  # Append a single JSONL line. Best-effort — never fail the workflow for metrics.
  printf '{"ts":"%s","workflow":"%s","status":"%s","started_at":"%s","duration_s":%d,"detail":"%s"}\n' \
    "$ts" "$workflow" "$status" "$started_at" "$duration" "$detail" \
    >> "$metrics_file" 2>/dev/null || true
}
