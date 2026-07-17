#!/usr/bin/env bash
# lint-no-direct-mutating-leaf.sh — Static analyzer that rejects direct mutating
# invocations of leaf workflows from orchestrators.
#
# RULE: Orchestrators must call leaf workflows through canonical_dispatch(),
#       never by directly invoking the implementation binary with mutating args.
#
# This script scans all source-controlled shell scripts and Python files in
# ops/goviral-control-plane/ and /usr/local/bin/goviral-* for violations.
#
# Exit 0 = clean, Exit 1 = violations found.
# ──────────────────────────────────────────────────────────────────────────────
set -euo pipefail

VIOLATIONS=0
SRC="${1:-/opt/goviral-archon-src}"
OPS="$SRC/ops/goviral-control-plane"

# Leaf workflows that MUST NOT be invoked directly with mutating commands
LEAVES=(
  "goviral-prompt-command-center"
  "goviral-brain-auto-workflow"
)

# Mutating argument patterns (grep -E)
MUTATING_PATTERN='(run-all\s+--write|submit\s+.*--write|execute|apply\s+--write|deploy\s+--write)'

# Files that are ALLOWED to call leaves directly (guards, libs, tests, deploy)
ALLOWED_FILES=(
  "lib-concurrency-guard.sh"
  "lib-canonical-dispatch.sh"
  "lib-quarantine.sh"
  "goviral-prompt-command-center-guard"
  "goviral-brain-auto-workflow-guard"
  "goviral-autopilot-supervisor"
  "goviral-quarantine"
  "test-concurrency-guard.sh"
  "test-canonical-dispatch.sh"
  "test-phase05.sh"
  "deploy-v3.sh"
  "deploy-v3.1.sh"
  "deploy-concurrency-fix.sh"
  "lint-no-direct-mutating-leaf.sh"
)

is_allowed() {
  local file="$1"
  local basename
  basename="$(basename "$file")"
  for allowed in "${ALLOWED_FILES[@]}"; do
    if [ "$basename" = "$allowed" ]; then
      return 0
    fi
  done
  return 1
}

scan_file() {
  local file="$1"

  if is_allowed "$file"; then
    return 0
  fi

  for leaf in "${LEAVES[@]}"; do
    # Look for: <leaf-name> <mutating-args>
    # But NOT: <leaf-name>-guard (that's the guard wrapper, which is OK)
    # And NOT: canonical_dispatch "<leaf-name>"
    local matches
    matches="$(grep -nE "${leaf}[\"' ]+.*${MUTATING_PATTERN}" "$file" 2>/dev/null \
      | grep -v "${leaf}-guard" \
      | grep -v "canonical_dispatch" \
      | grep -v "^[[:space:]]*#" \
      || true)"

    if [ -n "$matches" ]; then
      echo "VIOLATION in $file:"
      echo "$matches" | while IFS= read -r line; do
        echo "  $line"
      done
      echo "  -> Must use: canonical_dispatch \"$leaf\" <args>"
      echo ""
      VIOLATIONS=$((VIOLATIONS + 1))
    fi
  done
}

echo "=== Static Analysis: No Direct Mutating Leaf Invocation ==="
echo ""

# Scan ops directory
if [ -d "$OPS" ]; then
  while IFS= read -r -d '' file; do
    scan_file "$file"
  done < <(find "$OPS" -maxdepth 1 \( -name '*.sh' -o -name 'goviral-*' \) -type f -print0 2>/dev/null)
fi

# Scan installed scripts (production)
if [ -d /usr/local/bin ]; then
  while IFS= read -r -d '' file; do
    # Only scan orchestrator scripts (not leaf implementations)
    basename="$(basename "$file")"
    case "$basename" in
      goviral-unified-autopilot|goviral-nl-autopilot-router|goviral-universal-autopilot)
        scan_file "$file"
        ;;
    esac
  done < <(find /usr/local/bin -maxdepth 1 -name 'goviral-*' -type f -print0 2>/dev/null)
fi

echo "=== Results ==="
if [ "$VIOLATIONS" -eq 0 ]; then
  echo "PASS: No direct mutating leaf invocations found"
  exit 0
else
  echo "FAIL: $VIOLATIONS violation(s) found"
  echo ""
  echo "Fix: Replace direct calls with canonical_dispatch() from lib-canonical-dispatch.sh"
  exit 1
fi
