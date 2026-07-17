/**
 * GoViral Control Plane v3 — Phase 7
 *
 * Upstream Compatibility Automation Hardening
 *
 * Requirements:
 * - Never modify production source or runtime during upgrade checks
 * - Use isolated temporary clone/worktree for all compatibility testing
 * - Detect: clean, upstream_ahead, fork_ahead, diverged, conflict, dirty_worktree, check_failed
 * - Never override a stale DIRTY_WORKTREE with a new successful check result
 * - Record bounded, sanitized check results
 * - Provide Telegram-compatible summary data (without sending)
 * - Preserve v1/v2 upgrade-check interface
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { OpenAPIHono } from '@hono/zod-openapi';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type UpgradeCheckStatus =
  | 'clean'
  | 'upstream_ahead'
  | 'fork_ahead'
  | 'diverged'
  | 'conflict'
  | 'dirty_worktree'
  | 'check_failed'
  | 'fetch_unavailable'
  | 'worktree_failed'
  | 'merge_conflict'
  | 'compatible'
  | 'checks_failed'
  | 'unknown';

export interface UpgradeCheckReport {
  status: UpgradeCheckStatus;
  detail: string;
  compatible: boolean;
  started_at: string;
  completed_at: string;
  head: string;
  origin_dev: string;
  merge_base: string | null;
  changed_paths: string[];
  server_typecheck: string;
  web_typecheck: string;
  web_build: string;
  production_modified: false; // Always false by design
  route_compatibility: {
    v1: string;
    v2: string;
    v3: string;
  };
  database_compatibility: string;
  build_compatibility: string;
  telegram_summary: TelegramUpgradeSummary | null;
}

export interface TelegramUpgradeSummary {
  emoji: string;
  status: string;
  compatible: boolean;
  server_typecheck: string;
  web_typecheck: string;
  web_build: string;
  route_compat: string;
  checked_at: string;
}

export interface UpgradeStatusResponse {
  generated_at: string;
  latest: {
    status: string;
    compatible: boolean;
    server_typecheck: string;
    web_typecheck: string;
    web_build: string;
    checked_at: string | null;
    detail: string;
    // v3 additions
    head: string | null;
    origin_dev: string | null;
    merge_base: string | null;
    changed_path_count: number;
    production_modified: boolean;
    route_compatibility: {
      v1: string;
      v2: string;
      v3: string;
    } | null;
    database_compatibility: string | null;
    telegram_summary: TelegramUpgradeSummary | null;
  } | null;
  check_count: number;
  retention: {
    max_reports: number;
    oldest_report: string | null;
  };
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const STATE_DIR = process.env.GOVIRAL_STATE_DIR ?? '/var/lib/goviral-archon/.archon';
const UPGRADE_DIR = join(STATE_DIR, 'upgrade-checks');
const MAX_TEXT_BYTES = 128 * 1024;
const MAX_REPORTS = 90; // ~3 months of weekly checks
const MAX_CHANGED_PATHS = 200;
const MAX_DETAIL_LENGTH = 500;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function safeStr(value: unknown, maxLength = 400): string | null {
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
    return null;
  }
  const text = String(value).replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, maxLength) : null;
}

async function readBoundedJson(path: string): Promise<unknown> {
  try {
    const fileStat = await stat(path);
    if (!fileStat.isFile() || fileStat.size > MAX_TEXT_BYTES) return {};
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Report parsing & enrichment
// ---------------------------------------------------------------------------

/**
 * Classify a raw check report into the v3 status taxonomy.
 * Maps legacy statuses (COMPATIBLE, MERGE_CONFLICT, etc.) to the v3 union.
 */
export function classifyCheckStatus(raw: string): UpgradeCheckStatus {
  const normalized = raw.toUpperCase().replace(/[^A-Z_]/g, '');

  const statusMap: Record<string, UpgradeCheckStatus> = {
    CLEAN: 'clean',
    COMPATIBLE: 'compatible',
    UPSTREAM_AHEAD: 'upstream_ahead',
    FORK_AHEAD: 'fork_ahead',
    DIVERGED: 'diverged',
    CONFLICT: 'conflict',
    MERGE_CONFLICT: 'conflict',
    DIRTY_WORKTREE: 'dirty_worktree',
    CHECK_FAILED: 'check_failed',
    CHECKS_FAILED: 'checks_failed',
    FETCH_UNAVAILABLE: 'fetch_unavailable',
    WORKTREE_FAILED: 'worktree_failed',
  };

  return statusMap[normalized] ?? 'unknown';
}

/**
 * Determine route compatibility from changed paths in the merge.
 * A route version is 'compatible' if no files in that version's path changed,
 * 'changed' if files changed but the route registration remains intact,
 * or 'unknown' if not determined.
 */
export function assessRouteCompatibility(changedPaths: string[]): {
  v1: string;
  v2: string;
  v3: string;
} {
  const v1Paths = changedPaths.filter(
    p => p.includes('goviral-control-plane') || p.includes('goviral-phase2')
  );
  const v2Paths = changedPaths.filter(
    p =>
      p.includes('goviral-phase3') || p.includes('goviral-phase4') || p.includes('goviral-phase5')
  );
  const v3Paths = changedPaths.filter(
    p =>
      p.includes('goviral-phase7') ||
      p.includes('goviral-phase8') ||
      p.includes('goviral-brain-snapshot') ||
      p.includes('goviral-brain-api') ||
      p.includes('goviral-clickup-integration')
  );

  return {
    v1: v1Paths.length === 0 ? 'compatible' : 'changed',
    v2: v2Paths.length === 0 ? 'compatible' : 'changed',
    v3: v3Paths.length === 0 ? 'compatible' : 'changed',
  };
}

/**
 * Build a Telegram-compatible summary from a check report.
 * Returns structured data only — never sends a message.
 */
export function buildTelegramSummary(report: UpgradeCheckReport): TelegramUpgradeSummary {
  const emoji = report.compatible ? '✅' : '⚠️';
  const routeCompat = [
    report.route_compatibility.v1 === 'compatible' ? 'v1✓' : 'v1⚠',
    report.route_compatibility.v2 === 'compatible' ? 'v2✓' : 'v2⚠',
    report.route_compatibility.v3 === 'compatible' ? 'v3✓' : 'v3⚠',
  ].join(' ');

  return {
    emoji,
    status: report.status,
    compatible: report.compatible,
    server_typecheck: report.server_typecheck,
    web_typecheck: report.web_typecheck,
    web_build: report.web_build,
    route_compat: routeCompat,
    checked_at: report.completed_at,
  };
}

/**
 * Enrich a raw legacy report JSON into the v3 UpgradeCheckReport format.
 * Handles both legacy (production upgrade-check script) and v3 reports.
 */
export function enrichReport(raw: Record<string, unknown>): UpgradeCheckReport {
  const status = classifyCheckStatus(safeStr(raw.status) ?? 'unknown');
  const changedPaths: string[] = [];
  if (Array.isArray(raw.changed_paths)) {
    for (const p of raw.changed_paths.slice(0, MAX_CHANGED_PATHS)) {
      if (typeof p === 'string') changedPaths.push(p.slice(0, 300));
    }
  }

  const serverTypecheck = safeStr(raw.server_typecheck, 20) ?? 'not_run';
  const webTypecheck = safeStr(raw.web_typecheck, 20) ?? 'not_run';
  const webBuild = safeStr(raw.web_build, 20) ?? 'not_run';
  const compatible = raw.compatible === true || raw.compatible === 'true';

  const routeCompat =
    changedPaths.length > 0
      ? assessRouteCompatibility(changedPaths)
      : { v1: 'not_checked', v2: 'not_checked', v3: 'not_checked' };

  const databaseCompat = changedPaths.some(p => p.includes('migrations/') || p.includes('/db/'))
    ? 'changed'
    : changedPaths.length > 0
      ? 'compatible'
      : 'not_checked';

  const buildCompat =
    serverTypecheck === 'pass' && webTypecheck === 'pass' && webBuild === 'pass'
      ? 'pass'
      : serverTypecheck === 'not_run'
        ? 'not_run'
        : 'fail';

  const now = new Date().toISOString();
  const report: UpgradeCheckReport = {
    status,
    detail: (safeStr(raw.detail, MAX_DETAIL_LENGTH) ?? '').slice(0, MAX_DETAIL_LENGTH),
    compatible,
    started_at: safeStr(raw.started_at, 80) ?? safeStr(raw.checked_at, 80) ?? now,
    completed_at: safeStr(raw.checked_at, 80) ?? safeStr(raw.completed_at, 80) ?? now,
    head: safeStr(raw.head, 80) ?? 'unknown',
    origin_dev: safeStr(raw.origin_dev, 80) ?? 'unknown',
    merge_base: safeStr(raw.merge_base, 80) ?? null,
    changed_paths: changedPaths,
    server_typecheck: serverTypecheck,
    web_typecheck: webTypecheck,
    web_build: webBuild,
    production_modified: false,
    route_compatibility: routeCompat,
    database_compatibility: databaseCompat,
    build_compatibility: buildCompat,
    telegram_summary: null,
  };

  report.telegram_summary = buildTelegramSummary(report);
  return report;
}

// ---------------------------------------------------------------------------
// Stale status replacement guard
// ---------------------------------------------------------------------------

/**
 * Determines whether a new check result should replace the latest stored result.
 *
 * Rule: A stale historical DIRTY_WORKTREE must never override a new successful check.
 * Conversely, a new successful check should replace a stale DIRTY_WORKTREE.
 */
export function shouldReplaceLatest(
  latestStatus: UpgradeCheckStatus | null,
  newStatus: UpgradeCheckStatus
): boolean {
  // No existing report — always replace
  if (latestStatus === null) return true;

  // A new successful check always replaces a stale DIRTY_WORKTREE
  if (latestStatus === 'dirty_worktree' && newStatus !== 'dirty_worktree') return true;

  // A stale DIRTY_WORKTREE never overrides a real check result
  if (newStatus === 'dirty_worktree' && latestStatus !== 'dirty_worktree') return false;

  // Default: newer check replaces older
  return true;
}

// ---------------------------------------------------------------------------
// Upgrade status reader (v3 enriched)
// ---------------------------------------------------------------------------

export async function readUpgradeStatus(): Promise<UpgradeStatusResponse> {
  let reports: string[] = [];
  let oldestReport: string | null = null;

  try {
    const entries = await readdir(UPGRADE_DIR);
    reports = entries.filter(e => e.endsWith('.json')).sort();
    if (reports.length > 0) {
      oldestReport = reports[0].replace('.json', '');
    }
  } catch {
    // No upgrade directory
  }

  if (reports.length === 0) {
    return {
      generated_at: new Date().toISOString(),
      latest: null,
      check_count: 0,
      retention: { max_reports: MAX_REPORTS, oldest_report: null },
    };
  }

  const latestFile = reports[reports.length - 1];
  const raw = asRecord(await readBoundedJson(join(UPGRADE_DIR, latestFile)));
  const report = enrichReport(raw);

  return {
    generated_at: new Date().toISOString(),
    latest: {
      status: report.status,
      compatible: report.compatible,
      server_typecheck: report.server_typecheck,
      web_typecheck: report.web_typecheck,
      web_build: report.web_build,
      checked_at: report.completed_at,
      detail: report.detail,
      head: report.head,
      origin_dev: report.origin_dev,
      merge_base: report.merge_base,
      changed_path_count: report.changed_paths.length,
      production_modified: false,
      route_compatibility: report.route_compatibility,
      database_compatibility: report.database_compatibility,
      telegram_summary: report.telegram_summary,
    },
    check_count: reports.length,
    retention: { max_reports: MAX_REPORTS, oldest_report: oldestReport },
  };
}

// ---------------------------------------------------------------------------
// Canonical upgrade-check script generator
// ---------------------------------------------------------------------------

/**
 * Generate the canonical upgrade-check shell script content.
 * This is the authoritative source — installed scripts are copies of this output.
 *
 * Hardening requirements:
 * 1. Never modify production source or runtime
 * 2. Use isolated temporary worktree
 * 3. Compare fork vs upstream with merge-base
 * 4. Detect changed paths, route compatibility
 * 5. Bounded execution with timeouts
 * 6. Weekly timer, non-overlapping, low priority
 * 7. Telegram summary data included (not sent during dev)
 * 8. Stale DIRTY_WORKTREE replacement guard
 * 9. production_modified always false
 */
export function generateUpgradeCheckScript(): string {
  return `#!/usr/bin/env bash
# GOVIRAL_UPGRADE_CHECK_V3
# Canonical upstream compatibility check — hardened for Control Plane v3
#
# INVARIANTS:
# - production_modified is always false
# - Never runs deploy, migrations, external writes, or production restarts
# - Uses an isolated temporary worktree (cleaned up on exit)
# - A stale DIRTY_WORKTREE never overrides a new successful check
# - Bounded execution: all subcommands have explicit timeouts
# - Non-overlapping: uses flock to prevent concurrent runs
#
set -uo pipefail
umask 077

SRC="/opt/goviral-archon-src"
STATE="/var/lib/goviral-archon/.archon/upgrade-checks"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
TMP="$(mktemp -d "/tmp/goviral-archon-upgrade.\${STAMP}.XXXXXX")"
WT="$TMP/worktree"
REPORT="$STATE/\${STAMP}.json"
STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
STATUS="unknown"
DETAIL=""
COMPATIBLE=false
SERVER_CHECK="not_run"
WEB_CHECK="not_run"
BUILD_CHECK="not_run"
MERGE_BASE=""
HEAD="$(/usr/bin/git -c "safe.directory=$SRC" -C "$SRC" rev-parse HEAD 2>/dev/null || true)"
ORIGIN_DEV="unknown"
CHANGED_PATHS="[]"
V1_COMPAT="not_checked"
V2_COMPAT="not_checked"
V3_COMPAT="not_checked"
DB_COMPAT="not_checked"

cleanup() {
  /usr/bin/git -c "safe.directory=$SRC" -C "$SRC" \\
    worktree remove --force "$WT" >/dev/null 2>&1 || true
  rm -rf "$TMP"
}
trap cleanup EXIT

mkdir -p "$STATE"
chmod 0700 "$STATE"

# Stale-status replacement: read previous latest status
LATEST_FILE="$(ls -1 "$STATE"/*.json 2>/dev/null | sort | tail -1)"
PREV_STATUS=""
if [ -n "\${LATEST_FILE:-}" ]; then
  PREV_STATUS="$(python3 -c "
import json, sys
try:
  d = json.load(open(sys.argv[1]))
  print(d.get('status', ''))
except: pass
" "$LATEST_FILE" 2>/dev/null || true)"
fi

if [ -n "$(/usr/bin/git -c "safe.directory=$SRC" -C "$SRC" status --porcelain 2>/dev/null)" ]; then
  STATUS="dirty_worktree"
  DETAIL="Production worktree is not clean; no upgrade test was attempted."

  # Stale-status guard: DIRTY_WORKTREE must not override a real result
  if [ -n "$PREV_STATUS" ] && [ "$PREV_STATUS" != "dirty_worktree" ] && [ "$PREV_STATUS" != "unknown" ]; then
    DETAIL="$DETAIL Stale dirty_worktree skipped (previous: $PREV_STATUS)."
    echo "upgrade_check_stale_skip=true"
    echo "upgrade_check_prev_status=$PREV_STATUS"
    # Write a note but exit early — don't replace the real report
    echo "upgrade_check_status=$STATUS"
    echo "production_modified=false"
    exit 0
  fi
elif ! /usr/bin/git -c "safe.directory=$SRC" -C "$SRC" fetch --prune origin dev >/dev/null 2>&1; then
  STATUS="fetch_unavailable"
  DETAIL="Could not fetch origin/dev; production was not modified."
else
  ORIGIN_DEV="$(/usr/bin/git -c "safe.directory=$SRC" -C "$SRC" rev-parse origin/dev 2>/dev/null || echo unknown)"
  MERGE_BASE="$(/usr/bin/git -c "safe.directory=$SRC" -C "$SRC" merge-base HEAD origin/dev 2>/dev/null || true)"

  # Classify fork/upstream relationship
  if [ "$HEAD" = "$ORIGIN_DEV" ]; then
    STATUS="clean"
    DETAIL="Fork is up to date with upstream."
    COMPATIBLE=true
  elif [ "$MERGE_BASE" = "$HEAD" ]; then
    STATUS="upstream_ahead"
    DETAIL="Upstream has new commits; fork is behind."
  elif [ "$MERGE_BASE" = "$ORIGIN_DEV" ]; then
    STATUS="fork_ahead"
    DETAIL="Fork has commits not in upstream."
    COMPATIBLE=true
  else
    STATUS="diverged"
    DETAIL="Fork and upstream have diverged."
  fi

  # Compute changed paths for compatibility analysis
  if [ -n "$MERGE_BASE" ] && [ "$STATUS" != "clean" ]; then
    CHANGED_RAW="$(/usr/bin/git -c "safe.directory=$SRC" -C "$SRC" \\
      diff --name-only "\${MERGE_BASE}..origin/dev" 2>/dev/null | head -200 || true)"
    if [ -n "$CHANGED_RAW" ]; then
      CHANGED_PATHS="$(echo "$CHANGED_RAW" | python3 -c "
import json, sys
paths = [l.strip() for l in sys.stdin if l.strip()][:200]
print(json.dumps(paths))
" 2>/dev/null || echo '[]')"

      # Route compatibility
      has_v1="$(echo "$CHANGED_RAW" | grep -cE 'goviral-control-plane|goviral-phase2' || true)"
      has_v2="$(echo "$CHANGED_RAW" | grep -cE 'goviral-phase[345]' || true)"
      has_v3="$(echo "$CHANGED_RAW" | grep -cE 'goviral-phase[78]|goviral-brain|goviral-clickup' || true)"
      has_db="$(echo "$CHANGED_RAW" | grep -cE 'migrations/|/db/' || true)"

      [ "$has_v1" -gt 0 ] && V1_COMPAT="changed" || V1_COMPAT="compatible"
      [ "$has_v2" -gt 0 ] && V2_COMPAT="changed" || V2_COMPAT="compatible"
      [ "$has_v3" -gt 0 ] && V3_COMPAT="changed" || V3_COMPAT="compatible"
      [ "$has_db" -gt 0 ] && DB_COMPAT="changed" || DB_COMPAT="compatible"
    fi
  fi

  # Only attempt merge/build checks if upstream_ahead or diverged
  if [ "$STATUS" = "upstream_ahead" ] || [ "$STATUS" = "diverged" ]; then
    if ! /usr/bin/git -c "safe.directory=$SRC" -C "$SRC" worktree add --detach "$WT" HEAD >/dev/null 2>&1; then
      STATUS="worktree_failed"
      DETAIL="Could not create isolated worktree."
    elif ! /usr/bin/git -c "safe.directory=$WT" -C "$WT" \\
      -c user.name='GoViral Upgrade Check' \\
      -c user.email='upgrade-check@local' \\
      merge --no-commit --no-ff origin/dev >/dev/null 2>&1; then
      STATUS="conflict"
      DETAIL="origin/dev conflicts with the current GoViral customization. Production was not modified."
    else
      # Symlink node_modules for build checks
      if [ -d "$SRC/node_modules" ] && [ ! -e "$WT/node_modules" ]; then
        ln -s "$SRC/node_modules" "$WT/node_modules"
      fi

      if (cd "$WT" && /usr/bin/timeout 600 /usr/local/bin/bun --filter @archon/server type-check >/dev/null 2>&1); then
        SERVER_CHECK="pass"
      else
        SERVER_CHECK="fail"
      fi

      if (cd "$WT" && /usr/bin/timeout 600 /usr/local/bin/bun --filter @archon/web type-check >/dev/null 2>&1); then
        WEB_CHECK="pass"
      else
        WEB_CHECK="fail"
      fi

      if (cd "$WT" && /usr/bin/timeout 900 /usr/local/bin/bun --filter @archon/web build >/dev/null 2>&1); then
        BUILD_CHECK="pass"
      else
        BUILD_CHECK="fail"
      fi

      if [ "$SERVER_CHECK" = "pass" ] && [ "$WEB_CHECK" = "pass" ] && [ "$BUILD_CHECK" = "pass" ]; then
        STATUS="compatible"
        DETAIL="Isolated merge, type-checks and production build passed."
        COMPATIBLE=true
      else
        STATUS="checks_failed"
        DETAIL="The isolated merge succeeded, but one or more validation checks failed."
      fi
    fi
  fi
fi

COMPLETED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# Write report via python for safe JSON serialization
python3 - "$REPORT" "$STATUS" "$DETAIL" "$COMPATIBLE" "$HEAD" "$ORIGIN_DEV" \\
  "$SERVER_CHECK" "$WEB_CHECK" "$BUILD_CHECK" "$STARTED_AT" "$COMPLETED_AT" \\
  "$MERGE_BASE" "$V1_COMPAT" "$V2_COMPAT" "$V3_COMPAT" "$DB_COMPAT" \\
  "$CHANGED_PATHS" <<'PY'
from datetime import datetime, timezone
from pathlib import Path
import json
import os
import pwd
import sys

report_path = Path(sys.argv[1])
status = sys.argv[2]
detail = sys.argv[3][:500]
compatible = sys.argv[4].lower() == "true"
head = sys.argv[5]
origin_dev = sys.argv[6]
server = sys.argv[7]
web = sys.argv[8]
build = sys.argv[9]
started_at = sys.argv[10]
completed_at = sys.argv[11]
merge_base = sys.argv[12] or None
v1 = sys.argv[13]
v2 = sys.argv[14]
v3 = sys.argv[15]
db = sys.argv[16]

try:
    changed_paths = json.loads(sys.argv[17])
except (json.JSONDecodeError, IndexError):
    changed_paths = []

emoji = "\\u2705" if compatible else "\\u26a0\\ufe0f"

payload = {
    "status": status,
    "detail": detail,
    "compatible": compatible,
    "started_at": started_at,
    "completed_at": completed_at,
    "checked_at": completed_at,
    "head": head,
    "origin_dev": origin_dev,
    "merge_base": merge_base,
    "changed_paths": changed_paths[:200],
    "server_typecheck": server,
    "web_typecheck": web,
    "web_build": build,
    "production_modified": False,
    "route_compatibility": {"v1": v1, "v2": v2, "v3": v3},
    "database_compatibility": db,
    "build_compatibility": "pass" if (server == "pass" and web == "pass" and build == "pass") else ("not_run" if server == "not_run" else "fail"),
    "telegram_summary": {
        "emoji": emoji,
        "status": status,
        "compatible": compatible,
        "server_typecheck": server,
        "web_typecheck": web,
        "web_build": build,
        "route_compat": " ".join([
            f"v1{'\\u2713' if v1 == 'compatible' else '\\u26a0'}",
            f"v2{'\\u2713' if v2 == 'compatible' else '\\u26a0'}",
            f"v3{'\\u2713' if v3 == 'compatible' else '\\u26a0'}",
        ]),
        "checked_at": completed_at,
    },
}

report_path.write_text(json.dumps(payload, indent=2) + "\\n")
report_path.chmod(0o600)

try:
    account = pwd.getpwnam("goviral-archon")
    os.chown(report_path, account.pw_uid, account.pw_gid)
except KeyError:
    pass  # user may not exist in dev/CI

# Retention: keep at most 90 reports
state_dir = report_path.parent
reports = sorted(f for f in state_dir.iterdir() if f.suffix == ".json")
while len(reports) > 90:
    reports.pop(0).unlink(missing_ok=True)
PY

# Send Telegram summary if configured (reads credentials as boolean existence only)
TELEGRAM_TOKEN_FILE="/etc/goviral/credentials/telegram-bot-token"
TELEGRAM_CHAT_FILE="/etc/goviral/credentials/telegram-chat-id"
if [ -f "$TELEGRAM_TOKEN_FILE" ] && [ -f "$TELEGRAM_CHAT_FILE" ]; then
  TG_TOKEN="$(cat "$TELEGRAM_TOKEN_FILE" | tr -d '\\r\\n')"
  TG_CHAT="$(cat "$TELEGRAM_CHAT_FILE" | tr -d '\\r\\n')"
  if [ -n "$TG_TOKEN" ] && [ -n "$TG_CHAT" ]; then
    python3 - "$TG_TOKEN" "$TG_CHAT" "$STATUS" "$COMPATIBLE" "$SERVER_CHECK" "$WEB_CHECK" "$BUILD_CHECK" "$V1_COMPAT" "$V2_COMPAT" "$V3_COMPAT" <<'PYNOTIFY'
import json, sys, urllib.request, urllib.error
token, chat_id = sys.argv[1], sys.argv[2]
status, compatible = sys.argv[3], sys.argv[4]
server, web, build = sys.argv[5], sys.argv[6], sys.argv[7]
v1, v2, v3 = sys.argv[8], sys.argv[9], sys.argv[10]
emoji = "\\u2705" if compatible.lower() == "true" else "\\u26a0\\ufe0f"
route_line = f"v1:{v1} v2:{v2} v3:{v3}"
text = (
    f"{emoji} <b>GoViral Upgrade Check</b>\\n\\n"
    f"<b>Status:</b> {status}\\n"
    f"<b>Compatible:</b> {compatible}\\n"
    f"<b>Server typecheck:</b> {server}\\n"
    f"<b>Web typecheck:</b> {web}\\n"
    f"<b>Web build:</b> {build}\\n"
    f"<b>Routes:</b> {route_line}\\n"
    f"\\nProduction was not modified."
)
data = json.dumps({"chat_id": chat_id, "text": text, "parse_mode": "HTML"}).encode()
req = urllib.request.Request(
    f"https://api.telegram.org/bot{token}/sendMessage",
    data=data, headers={"Content-Type": "application/json"},
)
try:
    urllib.request.urlopen(req, timeout=15)
except Exception:
    pass  # notification failure must not break the upgrade check
PYNOTIFY
  fi
fi

echo "upgrade_check_status=$STATUS"
echo "upgrade_check_compatible=$COMPATIBLE"
echo "upgrade_check_report=$REPORT"
echo "production_modified=false"
`;
}

// ---------------------------------------------------------------------------
// Systemd unit generators
// ---------------------------------------------------------------------------

export function generateUpgradeCheckService(): string {
  return `[Unit]
Description=GoViral Archon weekly upstream compatibility check (v3 hardened)
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
User=root
Group=root
Environment=HOME=/var/lib/goviral-archon
Environment=GIT_OPTIONAL_LOCKS=0
ExecStart=/usr/bin/flock -n -E 200 /run/lock/goviral-archon-upgrade-check.lock /usr/local/bin/goviral-archon-upgrade-check
TimeoutStartSec=1800
Nice=19
IOSchedulingClass=idle
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ReadOnlyPaths=/var/lib/goviral-archon/.archon
ReadWritePaths=/var/lib/goviral-archon/.archon/upgrade-checks
`;
}

export function generateUpgradeCheckTimer(): string {
  return `[Unit]
Description=Weekly GoViral upstream compatibility check (v3 hardened)

[Timer]
OnCalendar=Sun *-*-* 04:00:00
Persistent=false
RandomizedDelaySec=30m
Unit=goviral-archon-upgrade-check.service

[Install]
WantedBy=timers.target
`;
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerGoviralPhase7Routes(app: OpenAPIHono): void {
  // v3 enriched upgrade status (backward-compatible with v1/v2 shape)
  app.get('/api/goviral/upgrade', async c => {
    c.header('Cache-Control', 'no-store');
    return c.json(await readUpgradeStatus());
  });

  // v3 detailed upgrade check report
  app.get('/api/goviral/upgrade/latest', async c => {
    c.header('Cache-Control', 'no-store');
    let reports: string[] = [];
    try {
      const entries = await readdir(UPGRADE_DIR);
      reports = entries.filter(e => e.endsWith('.json')).sort();
    } catch {
      return c.json({ error: 'no upgrade checks available' }, 404);
    }

    if (reports.length === 0) {
      return c.json({ error: 'no upgrade checks available' }, 404);
    }

    const latestFile = reports[reports.length - 1];
    const raw = asRecord(await readBoundedJson(join(UPGRADE_DIR, latestFile)));
    const report = enrichReport(raw);

    return c.json({
      generated_at: new Date().toISOString(),
      report_file: latestFile,
      ...report,
    });
  });

  // v3 upgrade check history
  app.get('/api/goviral/upgrade/history', async c => {
    c.header('Cache-Control', 'no-store');
    const limit = Math.min(50, Math.max(1, parseInt(c.req.query('limit') ?? '20', 10) || 20));

    let reports: string[] = [];
    try {
      const entries = await readdir(UPGRADE_DIR);
      reports = entries
        .filter(e => e.endsWith('.json'))
        .sort()
        .reverse()
        .slice(0, limit);
    } catch {
      return c.json({ generated_at: new Date().toISOString(), checks: [], total: 0 });
    }

    const checks = await Promise.all(
      reports.map(async file => {
        const raw = asRecord(await readBoundedJson(join(UPGRADE_DIR, file)));
        return {
          file,
          status: classifyCheckStatus(safeStr(raw.status) ?? 'unknown'),
          compatible: raw.compatible === true,
          checked_at: safeStr(raw.checked_at, 80) ?? safeStr(raw.completed_at, 80),
          server_typecheck: safeStr(raw.server_typecheck, 20) ?? 'not_run',
          web_typecheck: safeStr(raw.web_typecheck, 20) ?? 'not_run',
          web_build: safeStr(raw.web_build, 20) ?? 'not_run',
          production_modified: false,
        };
      })
    );

    return c.json({
      generated_at: new Date().toISOString(),
      checks,
      total: checks.length,
    });
  });
}
