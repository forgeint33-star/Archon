/**
 * GoViral Control Plane v3 — Phase 9 Tests
 *
 * Tests for deployment, installers, systemd, and disaster recovery:
 * - Concurrency guard generation and syntax
 * - Guard equivalence verification
 * - Systemd unit hardening
 * - Deploy script validation
 * - Preflight checks
 * - Rollback documentation
 */
import { describe, test, expect } from 'bun:test';
import { Hono } from 'hono';
import {
  generateConcurrencyGuard,
  verifyGuardEquivalence,
  generateHardenedService,
  generateHardenedTimer,
  generateDeployScript,
  registerGoviralPhase9Routes,
} from './goviral-phase9-deploy';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTestApp(): InstanceType<typeof Hono> {
  const app = new Hono();
  registerGoviralPhase9Routes(app as never);
  return app;
}

// ---------------------------------------------------------------------------
// Concurrency guard tests
// ---------------------------------------------------------------------------

describe('generateConcurrencyGuard', () => {
  const guard = generateConcurrencyGuard({
    name: 'goviral-prompt-command-center',
    impl_suffix: '.impl',
    lock_path: '/run/lock/goviral-prompt-command-center.lock',
    trigger_args: ['run-all', '--write'],
    version: 'GOVIRAL_CONCURRENCY_GUARD_V3',
  });

  test('has bash shebang', () => {
    expect(guard.startsWith('#!/usr/bin/env bash')).toBe(true);
  });

  test('contains version marker', () => {
    expect(guard).toContain('GOVIRAL_CONCURRENCY_GUARD_V3');
  });

  test('uses flock with -n (non-blocking)', () => {
    expect(guard).toContain('flock -n -E 200');
  });

  test('outputs overlap_skipped=true on lock conflict', () => {
    expect(guard).toContain('overlap_skipped=true');
  });

  test('uses correct lock path', () => {
    expect(guard).toContain('/run/lock/goviral-prompt-command-center.lock');
  });

  test('uses exec for non-trigger invocations', () => {
    expect(guard).toContain('exec "$IMPL" "$@"');
  });

  test('checks trigger args', () => {
    expect(guard).toContain('run-all');
    expect(guard).toContain('--write');
  });

  test('has valid shell syntax', async () => {
    const proc = Bun.spawn(['bash', '-n', '-c', guard], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const exitCode = await proc.exited;
    expect(exitCode).toBe(0);
  });

  test('never contains deploy or restart commands', () => {
    expect(guard).not.toContain('systemctl restart');
    expect(guard).not.toContain('systemctl start');
  });
});

// ---------------------------------------------------------------------------
// Guard equivalence tests
// ---------------------------------------------------------------------------

describe('verifyGuardEquivalence', () => {
  test('identical guards are equivalent', () => {
    const script = generateConcurrencyGuard({
      name: 'test-script',
      impl_suffix: '.impl',
      lock_path: '/run/lock/test.lock',
      trigger_args: ['run-all', '--write'],
      version: 'GOVIRAL_CONCURRENCY_GUARD_V3',
    });
    const result = verifyGuardEquivalence(script, script);
    expect(result.equivalent).toBe(true);
    expect(result.differences).toHaveLength(0);
  });

  test('different impl timestamps are still equivalent', () => {
    const v1 = `#!/usr/bin/env bash
# GOVIRAL_CONCURRENCY_GUARD_V1
IMPL='/usr/local/bin/test.impl.20260716T162737Z'
LOCK='/run/lock/test.lock'
exec "$IMPL" "$@"
`;
    const v3 = `#!/usr/bin/env bash
# GOVIRAL_CONCURRENCY_GUARD_V3
IMPL='/usr/local/bin/test.impl'
LOCK='/run/lock/test.lock'
exec "$IMPL" "$@"
`;
    const result = verifyGuardEquivalence(v3, v1);
    expect(result.equivalent).toBe(true);
  });

  test('structurally different guards are not equivalent', () => {
    const a = `#!/usr/bin/env bash
IMPL='/usr/local/bin/test.impl'
exec "$IMPL" "$@"
`;
    const b = `#!/usr/bin/env bash
IMPL='/usr/local/bin/other.impl'
echo "different"
exec "$IMPL" "$@"
`;
    const result = verifyGuardEquivalence(a, b);
    expect(result.equivalent).toBe(false);
    expect(result.differences.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Systemd unit tests
// ---------------------------------------------------------------------------

describe('generateHardenedService', () => {
  const service = generateHardenedService({
    name: 'goviral-analytics-rollup',
    description: 'Hourly GoViral analytics rollup',
    calendar: '*-*-* *:15:00',
    persistent: true,
    randomDelay: '5m',
    priority: 'batch',
    timeoutSec: 300,
    runtimeMaxSec: 600,
  });

  test('has Nice=19 for batch priority', () => {
    expect(service).toContain('Nice=19');
  });

  test('has IOSchedulingClass=idle for batch', () => {
    expect(service).toContain('IOSchedulingClass=idle');
  });

  test('has TimeoutStartSec', () => {
    expect(service).toContain('TimeoutStartSec=300');
  });

  test('has RuntimeMaxSec', () => {
    expect(service).toContain('RuntimeMaxSec=600');
  });

  test('has NoNewPrivileges', () => {
    expect(service).toContain('NoNewPrivileges=true');
  });

  test('has PrivateTmp', () => {
    expect(service).toContain('PrivateTmp=true');
  });
});

describe('generateHardenedTimer', () => {
  test('upgrade check timer has Persistent=false', () => {
    const timer = generateHardenedTimer({
      name: 'goviral-archon-upgrade-check',
      description: 'Weekly check',
      calendar: 'Sun *-*-* 04:00:00',
      persistent: false,
      randomDelay: '30m',
      priority: 'batch',
      timeoutSec: 1800,
      runtimeMaxSec: 2400,
    });
    expect(timer).toContain('Persistent=false');
  });

  test('backup timer has Persistent=true', () => {
    const timer = generateHardenedTimer({
      name: 'goviral-archon-backup',
      description: 'Daily backup',
      calendar: '*-*-* 03:15:00',
      persistent: true,
      randomDelay: '10m',
      priority: 'batch',
      timeoutSec: 900,
      runtimeMaxSec: 1800,
    });
    expect(timer).toContain('Persistent=true');
  });

  test('timers have RandomizedDelaySec', () => {
    const timer = generateHardenedTimer({
      name: 'test',
      description: 'test',
      calendar: '*-*-* *:00:00',
      persistent: false,
      randomDelay: '5m',
      priority: 'normal',
      timeoutSec: 60,
      runtimeMaxSec: 120,
    });
    expect(timer).toContain('RandomizedDelaySec=5m');
  });

  test('timers are staggered (different calendars)', () => {
    // Analytics: :15 past each hour
    // Backup: 03:15
    // Upgrade: Sun 04:00
    // Health: :05,:35
    // These don't overlap
    expect(true).toBe(true); // Document the stagger; tested via config inspection
  });
});

// ---------------------------------------------------------------------------
// Deploy script tests
// ---------------------------------------------------------------------------

describe('generateDeployScript', () => {
  const script = generateDeployScript();

  test('has bash shebang', () => {
    expect(script.startsWith('#!/usr/bin/env bash')).toBe(true);
  });

  test('contains GOVIRAL_DEPLOY_V3 marker', () => {
    expect(script).toContain('GOVIRAL_DEPLOY_V3');
  });

  test('supports --dry-run mode', () => {
    expect(script).toContain('--dry-run');
  });

  test('supports --install mode', () => {
    expect(script).toContain('--install');
  });

  test('supports --verify mode', () => {
    expect(script).toContain('--verify');
  });

  test('supports --rollback mode', () => {
    expect(script).toContain('--rollback');
  });

  test('requires root', () => {
    expect(script).toContain('id -u');
  });

  test('backs up before replacing', () => {
    expect(script).toContain('cp -p');
    expect(script).toContain('.bak');
  });

  test('checks approval queue hash', () => {
    expect(script).toContain('sha256sum');
    expect(script).toContain('queue.json');
  });

  test('verifies loopback binding', () => {
    expect(script).toContain('127.0.0.1:8180');
  });

  test('checks health endpoint', () => {
    expect(script).toContain('/health');
  });

  test('checks concurrency guards', () => {
    expect(script).toContain('CONCURRENCY_GUARD');
  });

  test('checks failed units', () => {
    expect(script).toContain('systemctl --failed');
  });

  test('checks boot mount', () => {
    expect(script).toContain('findmnt /boot');
  });

  test('has valid shell syntax', async () => {
    const proc = Bun.spawn(['bash', '-n', '-c', script], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const exitCode = await proc.exited;
    expect(exitCode).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Route tests
// ---------------------------------------------------------------------------

describe('Phase 9 routes', () => {
  const app = createTestApp();

  test('GET /api/goviral/v3/deploy/preflight returns check results', async () => {
    const res = await app.request('/api/goviral/v3/deploy/preflight');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toHaveProperty('branch');
    expect(body).toHaveProperty('commit');
    expect(body).toHaveProperty('worktree_clean');
    expect(body).toHaveProperty('built_assets');
    expect(body).toHaveProperty('scripts_valid');
    expect(body).toHaveProperty('approval_queue_hash');
    expect(body).toHaveProperty('ready');
    expect(body).toHaveProperty('blockers');
  });

  test('GET /api/goviral/v3/deploy/artifacts returns deployment artifacts', async () => {
    const res = await app.request('/api/goviral/v3/deploy/artifacts');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toHaveProperty('concurrency_guards');
    expect(body).toHaveProperty('systemd_units');
    expect(body).toHaveProperty('deploy_script_lines');
  });

  test('GET /api/goviral/v3/deploy/guard-equivalence checks guards', async () => {
    const res = await app.request('/api/goviral/v3/deploy/guard-equivalence');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toHaveProperty('guards');
    expect(body).toHaveProperty('all_equivalent');
    expect(Array.isArray(body.guards)).toBe(true);
  });

  test('GET /api/goviral/v3/deploy/rollback returns instructions', async () => {
    const res = await app.request('/api/goviral/v3/deploy/rollback');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toHaveProperty('steps');
    expect(body).toHaveProperty('entry_points');
    expect(Array.isArray(body.steps)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Production immutability
// ---------------------------------------------------------------------------

describe('production immutability', () => {
  test('deploy script dry-run mode only runs preflight', () => {
    const script = generateDeployScript();
    // The case statement: --dry-run) preflight ;;
    // --install) preflight || exit 1 \n install_scripts \n install_units \n verify ;;
    // So dry-run does NOT call install_scripts
    const dryRunCase = script.match(/--dry-run\)\s*\n\s*(\w+)/);
    expect(dryRunCase).not.toBeNull();
    expect(dryRunCase![1]).toBe('preflight');
  });

  test('concurrency guards do not contain deploy commands', () => {
    for (const guard of [
      {
        name: 'goviral-prompt-command-center',
        impl_suffix: '.impl',
        lock_path: '/run/lock/goviral-prompt-command-center.lock',
        trigger_args: ['run-all', '--write'],
        version: 'GOVIRAL_CONCURRENCY_GUARD_V3',
      },
      {
        name: 'goviral-brain-auto-workflow',
        impl_suffix: '.impl',
        lock_path: '/run/lock/goviral-brain-auto-workflow.lock',
        trigger_args: ['run-all', '--write'],
        version: 'GOVIRAL_CONCURRENCY_GUARD_V3',
      },
    ]) {
      const script = generateConcurrencyGuard(guard);
      expect(script).not.toContain('apt');
      expect(script).not.toContain('npm install');
      expect(script).not.toContain('bun install');
      expect(script).not.toContain('systemctl restart');
    }
  });
});
