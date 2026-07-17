#!/usr/bin/env bash
# lib-workspace-scan.sh — Bounded workspace scanning for GoViral automation.
#
# Provides a single workspace inventory function that:
#   - Excludes .git, node_modules, build artifacts, backups, caches, databases
#   - Uses bounded depth (default 4)
#   - Has a configurable timeout (default 10s)
#   - Caches results for the lifetime of the orchestration chain
#   - Does NOT log private content (only file paths/counts)
#
# Usage:
#   source /usr/local/bin/goviral-lib-workspace-scan.sh
#   files="$(workspace_inventory /path/to/workspace)"
#   count="$(workspace_file_count /path/to/workspace)"
#
# Cache behavior:
#   The first call scans and caches in $GOVIRAL_SCAN_CACHE (default /tmp).
#   Subsequent calls within the same process tree reuse the cache.
#   Cache is keyed by absolute path and has a 5-minute TTL.
# ──────────────────────────────────────────────────────────────────────────────

set -u -o pipefail

SCAN_CACHE_DIR="${GOVIRAL_SCAN_CACHE:-/tmp/goviral-scan-cache}"
SCAN_MAX_DEPTH="${GOVIRAL_SCAN_MAX_DEPTH:-4}"
SCAN_TIMEOUT="${GOVIRAL_SCAN_TIMEOUT:-10}"
SCAN_TTL_SECONDS="${GOVIRAL_SCAN_TTL:-300}"

# Standard exclusion list
_SCAN_EXCLUDES=(
  -path '*/.git' -prune -o
  -path '*/node_modules' -prune -o
  -path '*/dist' -prune -o
  -path '*/.next' -prune -o
  -path '*/build' -prune -o
  -path '*/__pycache__' -prune -o
  -path '*/.cache' -prune -o
  -path '*/backups' -prune -o
  -path '*/*.db' -prune -o
  -path '*/*.sqlite*' -prune -o
  -path '*/.archon/state' -prune -o
  -path '*/coverage' -prune -o
  -path '*/.turbo' -prune -o
  -path '*/.venv' -prune -o
  -path '*/vendor' -prune -o
)

_cache_key() {
  local path="$1"
  echo "${path}" | sha256sum | cut -d' ' -f1
}

_cache_is_valid() {
  local cache_file="$1"
  if [ ! -f "$cache_file" ]; then
    return 1
  fi

  local now
  now="$(date +%s)"
  local mtime
  mtime="$(stat -c %Y "$cache_file" 2>/dev/null || echo 0)"
  local age=$((now - mtime))

  if [ "$age" -gt "$SCAN_TTL_SECONDS" ]; then
    return 1
  fi
  return 0
}

# workspace_inventory PATH
#   Returns the list of files (one per line), bounded and cached.
workspace_inventory() {
  local target_path="${1:-.}"
  local abs_path
  abs_path="$(cd "$target_path" 2>/dev/null && pwd || echo "$target_path")"

  mkdir -p "$SCAN_CACHE_DIR" 2>/dev/null || true
  local cache_file="${SCAN_CACHE_DIR}/$(_cache_key "$abs_path").inventory"

  if _cache_is_valid "$cache_file"; then
    cat "$cache_file"
    return 0
  fi

  # Bounded scan with timeout
  local result
  result="$(timeout "${SCAN_TIMEOUT}s" find "$abs_path" \
    -maxdepth "$SCAN_MAX_DEPTH" \
    "${_SCAN_EXCLUDES[@]}" \
    -type f -print \
    2>/dev/null || true)"

  # Cache the result (best-effort)
  printf '%s\n' "$result" > "$cache_file" 2>/dev/null || true

  printf '%s\n' "$result"
}

# workspace_file_count PATH
#   Returns just the count (faster for decision-making).
workspace_file_count() {
  local inventory
  inventory="$(workspace_inventory "${1:-.}")"
  if [ -z "$inventory" ]; then
    echo "0"
  else
    echo "$inventory" | wc -l
  fi
}

# workspace_invalidate_cache PATH
#   Force a fresh scan on next call.
workspace_invalidate_cache() {
  local target_path="${1:-.}"
  local abs_path
  abs_path="$(cd "$target_path" 2>/dev/null && pwd || echo "$target_path")"
  local cache_file="${SCAN_CACHE_DIR}/$(_cache_key "$abs_path").inventory"
  rm -f "$cache_file" 2>/dev/null || true
}
