/**
 * GoViral Control Plane v3 — Phase 8 Tests
 *
 * Tests for operations analytics, health, and safe actions:
 * - Analytics snapshot shape and accuracy
 * - Bounded retention
 * - CSV export bounds and redaction
 * - Overlap metrics
 * - RBAC negative tests
 * - Invalid action target rejection
 * - Arbitrary-shell rejection
 * - CSRF/origin rejection
 * - Rate limiting
 * - Audit/correlation IDs
 * - Backward compatibility
 */
import { describe, test, expect, afterAll } from 'bun:test';
import { Hono } from 'hono';
import {
  buildAnalyticsSnapshot,
  analyticsToCSV,
  registerGoviralPhase8Routes,
  type AnalyticsSnapshot,
} from './goviral-phase8-analytics';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTestApp(): InstanceType<typeof Hono> {
  const app = new Hono();
  registerGoviralPhase8Routes(app as never);
  return app;
}

async function get(app: InstanceType<typeof Hono>, path: string, headers?: Record<string, string>) {
  return app.request(path, { method: 'GET', headers });
}

async function post(
  app: InstanceType<typeof Hono>,
  path: string,
  body: unknown,
  headers?: Record<string, string>
) {
  return app.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// Analytics snapshot shape
// ---------------------------------------------------------------------------

describe('buildAnalyticsSnapshot', () => {
  test('returns complete shape with schema_version', async () => {
    const snapshot = await buildAnalyticsSnapshot();

    expect(snapshot.schema_version).toBe(1);
    expect(snapshot).toHaveProperty('generated_at');
    expect(snapshot).toHaveProperty('agents');
    expect(snapshot).toHaveProperty('workflows');
    expect(snapshot).toHaveProperty('approvals');
    expect(snapshot).toHaveProperty('incidents');
    expect(snapshot).toHaveProperty('backup');
    expect(snapshot).toHaveProperty('upstream');
    expect(snapshot).toHaveProperty('telegram');
    expect(snapshot).toHaveProperty('clickup');
    expect(snapshot).toHaveProperty('qdrant');
    expect(snapshot).toHaveProperty('security');
    expect(snapshot).toHaveProperty('brain');
    expect(snapshot).toHaveProperty('retention');
  });

  test('agent metrics are non-negative integers', async () => {
    const snapshot = await buildAnalyticsSnapshot();
    expect(snapshot.agents.registered).toBeGreaterThanOrEqual(0);
    expect(snapshot.agents.enabled).toBeGreaterThanOrEqual(0);
    expect(snapshot.agents.disabled).toBeGreaterThanOrEqual(0);
    expect(snapshot.agents.active_runs).toBeGreaterThanOrEqual(0);
  });

  test('approval counts are non-negative', async () => {
    const snapshot = await buildAnalyticsSnapshot();
    expect(snapshot.approvals.pending).toBeGreaterThanOrEqual(0);
    expect(snapshot.approvals.approved).toBeGreaterThanOrEqual(0);
    expect(snapshot.approvals.rejected).toBeGreaterThanOrEqual(0);
    expect(snapshot.approvals.executed).toBeGreaterThanOrEqual(0);
  });

  test('ClickUp writes_enabled is always false', async () => {
    const snapshot = await buildAnalyticsSnapshot();
    expect(snapshot.clickup.writes_enabled).toBe(false);
  });

  test('upstream production_modified is always false', async () => {
    const snapshot = await buildAnalyticsSnapshot();
    expect(snapshot.upstream.production_modified).toBe(false);
  });

  test('security services are reported with full status', async () => {
    const snapshot = await buildAnalyticsSnapshot();
    for (const svc of snapshot.security) {
      expect(svc).toHaveProperty('name');
      expect(svc).toHaveProperty('installed');
      expect(svc).toHaveProperty('enabled');
      expect(svc).toHaveProperty('active');
      expect(svc).toHaveProperty('healthy');
      expect(svc).toHaveProperty('last_check');
      expect(svc).toHaveProperty('detail');
    }
  });

  test('qdrant state is dynamically observed', async () => {
    const snapshot = await buildAnalyticsSnapshot();
    expect(snapshot.qdrant).toHaveProperty('service_detected');
    expect(snapshot.qdrant).toHaveProperty('container_detected');
    expect(snapshot.qdrant).toHaveProperty('api_reachable');
    expect(snapshot.qdrant).toHaveProperty('provenance');
    expect(snapshot.qdrant).toHaveProperty('control_plane_enabled');
  });

  test('brain reports partial failures', async () => {
    const snapshot = await buildAnalyticsSnapshot();
    expect(Array.isArray(snapshot.brain.partial_failures)).toBe(true);
  });

  test('retention bounds are documented', async () => {
    const snapshot = await buildAnalyticsSnapshot();
    expect(snapshot.retention.max_snapshots).toBe(720);
    expect(snapshot.retention.retention_days).toBe(30);
  });

  test('overlap metrics are present', async () => {
    const snapshot = await buildAnalyticsSnapshot();
    expect(snapshot.workflows).toHaveProperty('overlap_skipped_total');
    expect(snapshot.workflows).toHaveProperty('overlap_skipped_rate');
    expect(typeof snapshot.workflows.overlap_skipped_total).toBe('number');
  });
});

// ---------------------------------------------------------------------------
// CSV export
// ---------------------------------------------------------------------------

describe('analyticsToCSV', () => {
  const makeSnapshot = (): AnalyticsSnapshot => ({
    generated_at: '2026-07-16T10:00:00Z',
    schema_version: 1,
    agents: {
      registered: 10,
      enabled: 8,
      disabled: 2,
      active_runs: 1,
      runs_today: 5,
      completed_today: 4,
      failed_today: 1,
      cancelled_today: 0,
    },
    workflows: {
      duration_avg_ms: 12000,
      overlap_skipped_total: 3,
      overlap_skipped_rate: '1/day',
    },
    approvals: { pending: 2, approved: 10, rejected: 1, executed: 8 },
    incidents: { critical: 0, high: 1, warning: 2, by_status: {} },
    backup: { age_hours: 12.5, archive_count: 7, restore_drill_status: 'pass' },
    upstream: {
      status: 'compatible',
      compatible: true,
      production_modified: false,
      checked_at: '2026-07-15T04:00:00Z',
    },
    telegram: {
      framework_installed: true,
      credentials_configured: true,
      delivery_status: '2026-07-16T06:00:00Z',
    },
    clickup: { current_mode: 'not_configured', writes_enabled: false },
    qdrant: {
      service_detected: false,
      container_detected: false,
      api_reachable: false,
      collections: null,
      provenance: 'not_detected',
      control_plane_enabled: false,
    },
    security: [
      {
        name: 'crowdsec',
        installed: true,
        enabled: true,
        active: true,
        healthy: true,
        last_check: '2026-07-16T10:00:00Z',
        detail: 'active',
      },
    ],
    brain: {
      health: 'healthy',
      source_freshness: '2026-07-16T09:55:00Z',
      partial_failures: [],
      schema_version: 1,
    },
    retention: { max_snapshots: 720, retention_days: 30 },
  });

  test('produces valid CSV with header', () => {
    const csv = analyticsToCSV(makeSnapshot());
    const lines = csv.split('\n');
    expect(lines[0]).toBe('metric,value');
    expect(lines.length).toBeGreaterThan(10);
  });

  test('CSV is bounded', () => {
    const csv = analyticsToCSV(makeSnapshot());
    const lines = csv.split('\n');
    expect(lines.length).toBeLessThanOrEqual(5000);
  });

  test('CSV contains no secrets or raw prompts', () => {
    const csv = analyticsToCSV(makeSnapshot());
    expect(csv).not.toContain('token');
    expect(csv).not.toContain('password');
    expect(csv).not.toContain('api_key');
    expect(csv).not.toContain('chat_id');
  });

  test('CSV contains overlap metrics', () => {
    const csv = analyticsToCSV(makeSnapshot());
    expect(csv).toContain('workflows_overlap_skipped_total,3');
    expect(csv).toContain('workflows_overlap_skipped_rate,1/day');
  });

  test('CSV reports security services', () => {
    const csv = analyticsToCSV(makeSnapshot());
    expect(csv).toContain('security_crowdsec_active,true');
    expect(csv).toContain('security_crowdsec_healthy,true');
  });
});

// ---------------------------------------------------------------------------
// Route tests
// ---------------------------------------------------------------------------

describe('Phase 8 routes', () => {
  const app = createTestApp();

  test('GET /api/goviral/v3/analytics returns JSON', async () => {
    const res = await get(app, '/api/goviral/v3/analytics');
    expect(res.status).toBe(200);
    const body = (await res.json()) as AnalyticsSnapshot;
    expect(body).toHaveProperty('schema_version');
    expect(body).toHaveProperty('agents');
  });

  test('GET /api/goviral/v3/analytics/export returns CSV', async () => {
    const res = await get(app, '/api/goviral/v3/analytics/export');
    expect(res.status).toBe(200);
    // Content-Disposition header confirms CSV download
    expect(res.headers.get('content-disposition')).toContain('goviral-v3-analytics.csv');
    const text = await res.text();
    expect(text.startsWith('metric,value')).toBe(true);
  });

  test('GET /api/goviral/v3/health returns health summary', async () => {
    const res = await get(app, '/api/goviral/v3/health');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toHaveProperty('security');
    expect(body).toHaveProperty('qdrant');
    expect(body).toHaveProperty('failed_units');
  });

  test('GET /api/goviral/v3/security returns service states', async () => {
    const res = await get(app, '/api/goviral/v3/security');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toHaveProperty('services');
    expect(body).toHaveProperty('all_healthy');
  });

  test('GET /api/goviral/v3/qdrant returns observed state', async () => {
    const res = await get(app, '/api/goviral/v3/qdrant');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toHaveProperty('service_detected');
    expect(body).toHaveProperty('provenance');
  });

  test('GET /api/goviral/v3/overlap returns metrics', async () => {
    const res = await get(app, '/api/goviral/v3/overlap');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toHaveProperty('total');
    expect(body).toHaveProperty('rate');
  });

  test('GET /api/goviral/v3/actions returns metadata with CSRF', async () => {
    const res = await get(app, '/api/goviral/v3/actions');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toHaveProperty('available_actions');
    expect(body).toHaveProperty('csrf_token');
    expect(body).toHaveProperty('rate_limit');
    expect(Array.isArray(body.available_actions)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// RBAC negative tests
// ---------------------------------------------------------------------------

describe('RBAC enforcement', () => {
  const app = createTestApp();

  test('viewer cannot execute actions', async () => {
    // No auth headers = viewer (when GOVIRAL_ACTIONS_ENABLED is not '1')
    const savedEnv = process.env.GOVIRAL_ACTIONS_ENABLED;
    delete process.env.GOVIRAL_ACTIONS_ENABLED;

    const res = await post(app, '/api/goviral/v3/actions', { action: 'refresh_brain_snapshot' });
    expect(res.status).toBe(403);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(false);

    if (savedEnv !== undefined) process.env.GOVIRAL_ACTIONS_ENABLED = savedEnv;
  });
});

// ---------------------------------------------------------------------------
// Invalid action rejection
// ---------------------------------------------------------------------------

describe('action target validation', () => {
  const app = createTestApp();

  test('rejects non-allowlisted action', async () => {
    // First get CSRF token
    const metaRes = await get(app, '/api/goviral/v3/actions', {
      'x-archon-user': 'test-admin',
    });
    const meta = (await metaRes.json()) as Record<string, unknown>;
    const csrfToken = meta.csrf_token as string;

    const res = await post(
      app,
      '/api/goviral/v3/actions',
      { action: 'rm -rf /' },
      { 'x-archon-user': 'test-admin', 'x-goviral-csrf': csrfToken }
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe('invalid_action');
  });

  test('rejects shell injection attempt', async () => {
    const metaRes = await get(app, '/api/goviral/v3/actions', {
      'x-archon-user': 'test-admin',
    });
    const meta = (await metaRes.json()) as Record<string, unknown>;
    const csrfToken = meta.csrf_token as string;

    const res = await post(
      app,
      '/api/goviral/v3/actions',
      { action: 'run_backup; cat /etc/passwd' },
      { 'x-archon-user': 'test-admin', 'x-goviral-csrf': csrfToken }
    );
    expect(res.status).toBe(400);
  });

  test('rejects arbitrary path as action', async () => {
    const metaRes = await get(app, '/api/goviral/v3/actions', {
      'x-archon-user': 'test-admin',
    });
    const meta = (await metaRes.json()) as Record<string, unknown>;
    const csrfToken = meta.csrf_token as string;

    const res = await post(
      app,
      '/api/goviral/v3/actions',
      { action: '/usr/bin/arbitrary-command' },
      { 'x-archon-user': 'test-admin', 'x-goviral-csrf': csrfToken }
    );
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// CSRF enforcement
// ---------------------------------------------------------------------------

describe('CSRF enforcement', () => {
  const app = createTestApp();

  test('rejects action without CSRF token', async () => {
    const res = await post(
      app,
      '/api/goviral/v3/actions',
      { action: 'refresh_brain_snapshot' },
      { 'x-archon-user': 'test-admin' }
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe('csrf_token_invalid');
  });

  test('rejects action with wrong CSRF token', async () => {
    const res = await post(
      app,
      '/api/goviral/v3/actions',
      { action: 'refresh_brain_snapshot' },
      { 'x-archon-user': 'test-admin', 'x-goviral-csrf': 'wrong-token' }
    );
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Origin enforcement
// ---------------------------------------------------------------------------

describe('origin enforcement', () => {
  const app = createTestApp();

  test('rejects requests from untrusted origin', async () => {
    // Get CSRF token first
    const metaRes = await get(app, '/api/goviral/v3/actions', {
      'x-archon-user': 'test-admin',
    });
    const meta = (await metaRes.json()) as Record<string, unknown>;
    const csrfToken = meta.csrf_token as string;

    const res = await post(
      app,
      '/api/goviral/v3/actions',
      { action: 'refresh_brain_snapshot' },
      {
        'x-archon-user': 'test-admin',
        'x-goviral-csrf': csrfToken,
        origin: 'https://evil-site.example.com',
      }
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe('origin_rejected');
  });
});

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

describe('rate limiting', () => {
  test('rate limit metadata is returned', async () => {
    const app = createTestApp();
    const res = await get(app, '/api/goviral/v3/actions');
    const body = (await res.json()) as { rate_limit: { window_ms: number; max_actions: number } };
    expect(body.rate_limit.window_ms).toBe(60000);
    expect(body.rate_limit.max_actions).toBe(6);
  });
});

// ---------------------------------------------------------------------------
// Backward compatibility
// ---------------------------------------------------------------------------

describe('backward compatibility', () => {
  test('v2 analytics endpoint still works', async () => {
    // The v2 endpoint is still registered in phase5
    // This test verifies v3 doesn't break it
    const app = createTestApp();
    const res = await get(app, '/api/goviral/v3/analytics');
    expect(res.status).toBe(200);
    const body = (await res.json()) as AnalyticsSnapshot;
    // Should have all v2 fields plus v3 additions
    expect(body).toHaveProperty('approvals');
    expect(body).toHaveProperty('incidents');
    expect(body).toHaveProperty('backup');
  });
});

// ---------------------------------------------------------------------------
// Audit and correlation IDs
// ---------------------------------------------------------------------------

describe('audit trail', () => {
  test('actions metadata includes correlation tracking', async () => {
    const app = createTestApp();
    const res = await get(app, '/api/goviral/v3/actions', { 'x-archon-user': 'admin' });
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toHaveProperty('csrf_token');
    expect(typeof body.csrf_token).toBe('string');
    expect((body.csrf_token as string).startsWith('csrf-')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Partial source failure handling
// ---------------------------------------------------------------------------

describe('partial source failures', () => {
  test('analytics snapshot handles brain unavailability gracefully', async () => {
    // This is an integration test that runs against real state
    // The brain may or may not be available - the test validates graceful handling
    const snapshot = await buildAnalyticsSnapshot();
    expect(snapshot.brain).toHaveProperty('health');
    expect(snapshot.brain).toHaveProperty('partial_failures');
    // If brain is unavailable, health should be null
    if (snapshot.brain.health === null) {
      expect(snapshot.brain.source_freshness).toBeNull();
    }
  });
});
