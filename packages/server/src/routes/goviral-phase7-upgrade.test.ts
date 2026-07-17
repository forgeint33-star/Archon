/**
 * GoViral Control Plane v3 — Phase 7 Tests
 *
 * Tests for upstream compatibility automation hardening:
 * - Status classification (clean, ahead, diverged, dirty, conflict, timeout)
 * - Stale-status replacement guard
 * - Route compatibility assessment
 * - Report enrichment
 * - Telegram summary building
 * - Production immutability (production_modified always false)
 * - Upgrade check script syntax
 */
import { describe, test, expect } from 'bun:test';
import {
  classifyCheckStatus,
  assessRouteCompatibility,
  buildTelegramSummary,
  enrichReport,
  shouldReplaceLatest,
  generateUpgradeCheckScript,
  generateUpgradeCheckService,
  generateUpgradeCheckTimer,
  readUpgradeStatus,
  type UpgradeCheckReport,
  type UpgradeCheckStatus,
} from './goviral-phase7-upgrade';

// ---------------------------------------------------------------------------
// classifyCheckStatus
// ---------------------------------------------------------------------------

describe('classifyCheckStatus', () => {
  test('maps clean status', () => {
    expect(classifyCheckStatus('CLEAN')).toBe('clean');
    expect(classifyCheckStatus('clean')).toBe('clean');
  });

  test('maps upstream_ahead', () => {
    expect(classifyCheckStatus('UPSTREAM_AHEAD')).toBe('upstream_ahead');
  });

  test('maps fork_ahead', () => {
    expect(classifyCheckStatus('FORK_AHEAD')).toBe('fork_ahead');
  });

  test('maps diverged', () => {
    expect(classifyCheckStatus('DIVERGED')).toBe('diverged');
  });

  test('maps conflict and merge_conflict', () => {
    expect(classifyCheckStatus('CONFLICT')).toBe('conflict');
    expect(classifyCheckStatus('MERGE_CONFLICT')).toBe('conflict');
  });

  test('maps dirty_worktree', () => {
    expect(classifyCheckStatus('DIRTY_WORKTREE')).toBe('dirty_worktree');
  });

  test('maps check_failed and checks_failed', () => {
    expect(classifyCheckStatus('CHECK_FAILED')).toBe('check_failed');
    expect(classifyCheckStatus('CHECKS_FAILED')).toBe('checks_failed');
  });

  test('maps fetch_unavailable', () => {
    expect(classifyCheckStatus('FETCH_UNAVAILABLE')).toBe('fetch_unavailable');
  });

  test('maps worktree_failed', () => {
    expect(classifyCheckStatus('WORKTREE_FAILED')).toBe('worktree_failed');
  });

  test('maps compatible (legacy)', () => {
    expect(classifyCheckStatus('COMPATIBLE')).toBe('compatible');
  });

  test('returns unknown for unrecognized status', () => {
    expect(classifyCheckStatus('SOMETHING_NEW')).toBe('unknown');
    expect(classifyCheckStatus('')).toBe('unknown');
  });

  test('handles mixed case and whitespace', () => {
    expect(classifyCheckStatus('  Clean  ')).toBe('clean');
    expect(classifyCheckStatus('Dirty_Worktree')).toBe('dirty_worktree');
  });
});

// ---------------------------------------------------------------------------
// shouldReplaceLatest (stale-status replacement guard)
// ---------------------------------------------------------------------------

describe('shouldReplaceLatest', () => {
  test('always replaces when no existing report', () => {
    expect(shouldReplaceLatest(null, 'clean')).toBe(true);
    expect(shouldReplaceLatest(null, 'dirty_worktree')).toBe(true);
  });

  test('new success replaces stale dirty_worktree', () => {
    expect(shouldReplaceLatest('dirty_worktree', 'clean')).toBe(true);
    expect(shouldReplaceLatest('dirty_worktree', 'compatible')).toBe(true);
    expect(shouldReplaceLatest('dirty_worktree', 'upstream_ahead')).toBe(true);
    expect(shouldReplaceLatest('dirty_worktree', 'conflict')).toBe(true);
  });

  test('stale dirty_worktree never overrides real check', () => {
    expect(shouldReplaceLatest('clean', 'dirty_worktree')).toBe(false);
    expect(shouldReplaceLatest('compatible', 'dirty_worktree')).toBe(false);
    expect(shouldReplaceLatest('conflict', 'dirty_worktree')).toBe(false);
    expect(shouldReplaceLatest('upstream_ahead', 'dirty_worktree')).toBe(false);
  });

  test('dirty_worktree replaces dirty_worktree (same status)', () => {
    expect(shouldReplaceLatest('dirty_worktree', 'dirty_worktree')).toBe(true);
  });

  test('newer check replaces older by default', () => {
    expect(shouldReplaceLatest('clean', 'upstream_ahead')).toBe(true);
    expect(shouldReplaceLatest('conflict', 'clean')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// assessRouteCompatibility
// ---------------------------------------------------------------------------

describe('assessRouteCompatibility', () => {
  test('all compatible when no relevant paths changed', () => {
    const result = assessRouteCompatibility(['README.md', 'package.json']);
    expect(result.v1).toBe('compatible');
    expect(result.v2).toBe('compatible');
    expect(result.v3).toBe('compatible');
  });

  test('v1 changed when control-plane file modified', () => {
    const result = assessRouteCompatibility([
      'packages/server/src/routes/goviral-control-plane.ts',
    ]);
    expect(result.v1).toBe('changed');
    expect(result.v2).toBe('compatible');
    expect(result.v3).toBe('compatible');
  });

  test('v2 changed when phase3-5 files modified', () => {
    const result = assessRouteCompatibility([
      'packages/server/src/routes/goviral-phase3.ts',
      'packages/server/src/routes/goviral-phase5.ts',
    ]);
    expect(result.v1).toBe('compatible');
    expect(result.v2).toBe('changed');
    expect(result.v3).toBe('compatible');
  });

  test('v3 changed when brain-snapshot or clickup files modified', () => {
    const result = assessRouteCompatibility([
      'packages/server/src/routes/goviral-brain-snapshot.ts',
      'packages/server/src/routes/goviral-clickup-integration.ts',
    ]);
    expect(result.v1).toBe('compatible');
    expect(result.v2).toBe('compatible');
    expect(result.v3).toBe('changed');
  });

  test('handles empty paths', () => {
    const result = assessRouteCompatibility([]);
    expect(result.v1).toBe('compatible');
    expect(result.v2).toBe('compatible');
    expect(result.v3).toBe('compatible');
  });
});

// ---------------------------------------------------------------------------
// enrichReport
// ---------------------------------------------------------------------------

describe('enrichReport', () => {
  test('enriches a legacy compatible report', () => {
    const report = enrichReport({
      status: 'COMPATIBLE',
      compatible: true,
      server_typecheck: 'pass',
      web_typecheck: 'pass',
      web_build: 'pass',
      head: 'abc123',
      origin_dev: 'def456',
      checked_at: '2026-07-16T10:00:00Z',
    });

    expect(report.status).toBe('compatible');
    expect(report.compatible).toBe(true);
    expect(report.production_modified).toBe(false);
    expect(report.server_typecheck).toBe('pass');
    expect(report.build_compatibility).toBe('pass');
    expect(report.telegram_summary).not.toBeNull();
    expect(report.telegram_summary!.emoji).toBe('✅');
  });

  test('enriches a conflict report', () => {
    const report = enrichReport({
      status: 'MERGE_CONFLICT',
      compatible: false,
      detail: 'origin/dev conflicts with customization',
    });

    expect(report.status).toBe('conflict');
    expect(report.compatible).toBe(false);
    expect(report.production_modified).toBe(false);
    expect(report.telegram_summary!.emoji).toBe('⚠️');
  });

  test('production_modified is always false regardless of input', () => {
    const report = enrichReport({
      status: 'COMPATIBLE',
      production_modified: true, // Attempt to override
    });

    expect(report.production_modified).toBe(false);
  });

  test('handles missing fields gracefully', () => {
    const report = enrichReport({});
    expect(report.status).toBe('unknown');
    expect(report.compatible).toBe(false);
    expect(report.production_modified).toBe(false);
    expect(report.server_typecheck).toBe('not_run');
    expect(report.web_typecheck).toBe('not_run');
    expect(report.web_build).toBe('not_run');
    expect(report.changed_paths).toEqual([]);
  });

  test('bounds detail length', () => {
    const longDetail = 'x'.repeat(2000);
    const report = enrichReport({ detail: longDetail });
    expect(report.detail.length).toBeLessThanOrEqual(500);
  });

  test('bounds changed_paths count', () => {
    const manyPaths = Array.from({ length: 300 }, (_, i) => `file${i}.ts`);
    const report = enrichReport({ changed_paths: manyPaths });
    expect(report.changed_paths.length).toBeLessThanOrEqual(200);
  });

  test('detects database compatibility from changed paths', () => {
    const report = enrichReport({
      status: 'COMPATIBLE',
      changed_paths: ['migrations/001_new.sql', 'packages/core/src/db/queries.ts'],
    });
    expect(report.database_compatibility).toBe('changed');
  });

  test('route compatibility assessed from changed paths', () => {
    const report = enrichReport({
      status: 'COMPATIBLE',
      changed_paths: [
        'packages/server/src/routes/goviral-phase3.ts',
        'packages/server/src/routes/goviral-brain-snapshot.ts',
      ],
    });
    expect(report.route_compatibility.v1).toBe('compatible');
    expect(report.route_compatibility.v2).toBe('changed');
    expect(report.route_compatibility.v3).toBe('changed');
  });
});

// ---------------------------------------------------------------------------
// buildTelegramSummary
// ---------------------------------------------------------------------------

describe('buildTelegramSummary', () => {
  const makeReport = (overrides: Partial<UpgradeCheckReport> = {}): UpgradeCheckReport => ({
    status: 'compatible',
    detail: 'test',
    compatible: true,
    started_at: '2026-07-16T10:00:00Z',
    completed_at: '2026-07-16T10:05:00Z',
    head: 'abc',
    origin_dev: 'def',
    merge_base: 'aaa',
    changed_paths: [],
    server_typecheck: 'pass',
    web_typecheck: 'pass',
    web_build: 'pass',
    production_modified: false,
    route_compatibility: { v1: 'compatible', v2: 'compatible', v3: 'compatible' },
    database_compatibility: 'compatible',
    build_compatibility: 'pass',
    telegram_summary: null,
    ...overrides,
  });

  test('builds summary with correct emoji for compatible', () => {
    const summary = buildTelegramSummary(makeReport());
    expect(summary.emoji).toBe('✅');
    expect(summary.compatible).toBe(true);
    expect(summary.route_compat).toContain('v1✓');
    expect(summary.route_compat).toContain('v2✓');
    expect(summary.route_compat).toContain('v3✓');
  });

  test('builds summary with warning emoji for incompatible', () => {
    const summary = buildTelegramSummary(
      makeReport({
        compatible: false,
        route_compatibility: { v1: 'changed', v2: 'compatible', v3: 'compatible' },
      })
    );
    expect(summary.emoji).toBe('⚠️');
    expect(summary.route_compat).toContain('v1⚠');
    expect(summary.route_compat).toContain('v2✓');
  });
});

// ---------------------------------------------------------------------------
// Upgrade check script syntax & content
// ---------------------------------------------------------------------------

describe('generateUpgradeCheckScript', () => {
  const script = generateUpgradeCheckScript();

  test('has bash shebang', () => {
    expect(script.startsWith('#!/usr/bin/env bash')).toBe(true);
  });

  test('contains GOVIRAL_UPGRADE_CHECK_V3 marker', () => {
    expect(script).toContain('GOVIRAL_UPGRADE_CHECK_V3');
  });

  test('never contains deploy, migration, or restart commands', () => {
    // These are forbidden by safety rules
    expect(script).not.toContain('systemctl restart');
    expect(script).not.toContain('systemctl start');
    expect(script).not.toContain('bun run migrate');
    expect(script).not.toContain('npm install');
    expect(script).not.toContain('bun install');
  });

  test('always sets production_modified=false', () => {
    expect(script).toContain('production_modified=false');
    // And never sets it to true
    expect(script).not.toContain('production_modified=true');
  });

  test('uses isolated temporary worktree', () => {
    expect(script).toContain('mktemp -d');
    expect(script).toContain('worktree add --detach');
    expect(script).toContain('worktree remove --force');
  });

  test('has timeout on build checks', () => {
    expect(script).toContain('timeout 600');
    expect(script).toContain('timeout 900');
  });

  test('has stale-status replacement guard', () => {
    expect(script).toContain('Stale dirty_worktree skipped');
    expect(script).toContain('PREV_STATUS');
  });

  test('has retention limit', () => {
    expect(script).toContain('90');
  });

  test('contains route compatibility checks', () => {
    expect(script).toContain('V1_COMPAT');
    expect(script).toContain('V2_COMPAT');
    expect(script).toContain('V3_COMPAT');
  });

  test('detects merge-base', () => {
    expect(script).toContain('merge-base');
    expect(script).toContain('MERGE_BASE');
  });

  test('includes changed_paths analysis', () => {
    expect(script).toContain('CHANGED_PATHS');
    expect(script).toContain('diff --name-only');
  });
});

describe('generateUpgradeCheckService', () => {
  const unit = generateUpgradeCheckService();

  test('uses flock for non-overlapping execution', () => {
    expect(unit).toContain('flock');
  });

  test('has Nice=19 for low priority', () => {
    expect(unit).toContain('Nice=19');
  });

  test('has IOSchedulingClass=idle', () => {
    expect(unit).toContain('IOSchedulingClass=idle');
  });

  test('has bounded timeout', () => {
    expect(unit).toContain('TimeoutStartSec=1800');
  });
});

describe('generateUpgradeCheckTimer', () => {
  const timer = generateUpgradeCheckTimer();

  test('runs weekly on Sunday', () => {
    expect(timer).toContain('OnCalendar=Sun');
  });

  test('has Persistent=false to avoid catch-up storms', () => {
    expect(timer).toContain('Persistent=false');
  });

  test('has randomized delay', () => {
    expect(timer).toContain('RandomizedDelaySec=30m');
  });
});

// ---------------------------------------------------------------------------
// readUpgradeStatus (integration-style — reads real filesystem state)
// ---------------------------------------------------------------------------

describe('readUpgradeStatus', () => {
  test('returns null latest when no reports exist', async () => {
    // This test relies on the actual upgrade-checks directory state.
    // It validates the response shape regardless of whether reports exist.
    const result = await readUpgradeStatus();

    expect(result).toHaveProperty('generated_at');
    expect(result).toHaveProperty('check_count');
    expect(result).toHaveProperty('retention');
    expect(typeof result.check_count).toBe('number');
    expect(result.retention.max_reports).toBe(90);

    if (result.latest) {
      // Validate v3 enriched fields
      expect(result.latest).toHaveProperty('status');
      expect(result.latest).toHaveProperty('compatible');
      expect(result.latest).toHaveProperty('production_modified');
      expect(result.latest.production_modified).toBe(false);
      expect(result.latest).toHaveProperty('route_compatibility');
      expect(result.latest).toHaveProperty('database_compatibility');
    }
  });
});
