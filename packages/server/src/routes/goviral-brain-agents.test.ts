/**
 * Tests for Phase 3 agents enrichment in goviral-phase3.ts.
 *
 * Validates that /api/goviral/agents integrates the Brain snapshot service,
 * surfaces registered agents, drift detection, and preserves backward-compatible
 * summary fields alongside the new canonical fields.
 */
import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { OpenAPIHono } from '@hono/zod-openapi';
import type { BrainSnapshot, BrainAgent } from './goviral-brain-snapshot';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeBrainAgent(overrides: Partial<BrainAgent> = {}): BrainAgent {
  return {
    name: 'iktinos',
    display_name: 'Iktinos',
    lane: 'engineering',
    type: 'worker',
    can_execute: true,
    can_modify_prod: false,
    approval_requirements: [],
    registry_source: true,
    definition_source: true,
    policy_source: true,
    consistency: 'consistent',
    skills: [],
    categories: ['engineering'],
    ...overrides,
  };
}

function makeSnapshot(agents: BrainAgent[] = []): BrainSnapshot {
  return {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    source_root: '/var/lib/goviral-archon/workspaces/goviral-brain',
    refresh_duration_ms: 42,
    health: 'healthy',
    warnings: [],
    agents: {
      source: '.governance/agents/',
      freshness: new Date().toISOString(),
      status: 'ok',
      data: {
        registered_count: agents.filter(a => a.registry_source).length,
        discovered_definition_count: agents.filter(a => a.definition_source).length,
        registry_drift_count: agents.filter(a => a.consistency !== 'consistent').length,
        worker_count: agents.filter(a => a.type === 'worker').length,
        gate_count: agents.filter(a => a.type === 'gate').length,
        orchestrator_count: 0,
        enabled_count: agents.filter(a => a.can_execute).length,
        items: agents,
      },
      warnings: [],
    },
    skills: {
      source: '.governance/skills/',
      freshness: null,
      status: 'ok',
      data: {
        catalog_count: 0,
        canonical_count: 0,
        bridge_count: 0,
        operational_count: 0,
        agent_skill_count: 0,
        gsap_count: 0,
        total_skill_md_count: 0,
        categories: {},
        items: [],
      },
      warnings: [],
    },
    tools: {
      source: '.governance/tools/',
      freshness: null,
      status: 'ok',
      data: { registered_count: 0, active_count: 0, items: [], mcp_servers: [] },
      warnings: [],
    },
    clients: {
      source: '.governance/client-context/',
      freshness: null,
      status: 'ok',
      data: {
        indexed_count: 0,
        directory_count: 0,
        runtime_knowledge_clients: 0,
        runtime_knowledge_files: 0,
        drift_count: 0,
        items: [],
      },
      warnings: [],
    },
    projects: {
      source: '.governance/client-project-bridge/',
      freshness: null,
      status: 'ok',
      data: { bridged_count: 0, items: [] },
      warnings: [],
    },
    memory: {
      source: '.governance/brain-memory/',
      freshness: null,
      status: 'ok',
      data: {
        brain_memory: { entry_count: 0, generated_at: null },
        knowledge_graph: { status: 'unavailable' },
        learning_engine: { status: 'unavailable' },
        runtime_knowledge: { status: 'unknown', files_count: 0, clients_count: 0 },
      },
      warnings: [],
    },
    brain_os: {
      source: '.governance/brain-os/',
      freshness: null,
      status: 'ok',
      data: { phase: null, status: 'unknown', generated_at: null },
      warnings: [],
    },
    councils: {
      source: '.governance/',
      freshness: null,
      status: 'ok',
      data: {
        worker_swarm: {
          name: 'worker-swarm',
          has_dashboard: false,
          has_status: false,
          latest_run: null,
        },
        wow_engine: {
          name: 'wow-engine',
          has_dashboard: false,
          has_status: false,
          latest_run: null,
        },
        fast_subagent: {
          name: 'fast-subagent-runtime',
          has_dashboard: false,
          has_status: false,
          latest_run: null,
        },
      },
      warnings: [],
    },
    telegram: {
      source: 'systemd + notifications/',
      freshness: null,
      status: 'ok',
      data: {
        framework_installed: false,
        credentials_configured: false,
        validation_test_passed: false,
        notifier_timer_active: false,
        daily_digest_timer_active: false,
        last_successful_delivery: null,
        detection_method: 'test',
      },
      warnings: [],
    },
    clickup: {
      source: '.governance/clickup-*',
      freshness: null,
      status: 'ok',
      data: {
        policy_count: 0,
        governance_dir_count: 0,
        v2_source_enabled: false,
        configured: false,
        state: 'not_configured',
      },
      warnings: [],
    },
    drift: [],
  };
}

// ---------------------------------------------------------------------------
// Mocks — must be before dynamic import of goviral-phase3
// ---------------------------------------------------------------------------

const mockGetBrainSnapshot = mock(async () => makeSnapshot());

mock.module('./goviral-brain-snapshot', () => ({
  getBrainSnapshot: mockGetBrainSnapshot,
  getCachedSnapshot: mock(() => null),
  getSnapshotCacheStatus: mock(() => ({
    has_cached: false,
    cached_at: null,
    age_ms: null,
    ttl_ms: 300_000,
    stale: true,
  })),
  refreshBrainSnapshot: mockGetBrainSnapshot,
  BRAIN_SNAPSHOT_SCHEMA_VERSION: 1,
}));

// Dynamic import after mocks
const { registerGoviralPhase3Routes } = await import('./goviral-phase3');

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function buildApp(): OpenAPIHono {
  const app = new OpenAPIHono();
  registerGoviralPhase3Routes(app);
  return app;
}

async function fetchAgents(app: OpenAPIHono): Promise<Response> {
  return app.request('/api/goviral/agents');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /api/goviral/agents (Phase 3 enrichment)', () => {
  beforeEach(() => {
    mockGetBrainSnapshot.mockReset();
    mockGetBrainSnapshot.mockImplementation(async () => makeSnapshot());
  });

  test('returns 200 with canonical response shape', async () => {
    const app = buildApp();
    const res = await fetchAgents(app);
    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, unknown>;
    expect(body.generated_at).toBeString();
    expect(body.registered_agents).toBeArray();
    expect(body.discovered_definitions).toBeArray();
    expect(body.enabled_agents).toBeArray();
    expect(body.disabled_agents).toBeArray();
    expect(body.active_runs).toBeArray();
    expect(body.runs_today).toBeArray();
    expect(body.recent_runs).toBeArray();
    expect(body.registry_definition_drift).toBeArray();
    expect(body.runs).toBeArray();

    const summary = body.summary as Record<string, number>;
    expect(typeof summary.registered_count).toBe('number');
    expect(typeof summary.discovered_definition_count).toBe('number');
    expect(typeof summary.enabled_count).toBe('number');
    expect(typeof summary.disabled_count).toBe('number');
    expect(typeof summary.active_run_count).toBe('number');
    expect(typeof summary.runs_today_count).toBe('number');
    expect(typeof summary.recent_run_count).toBe('number');
    expect(typeof summary.drift_count).toBe('number');
    // Backward-compat
    expect(typeof summary.total).toBe('number');
    expect(typeof summary.active).toBe('number');
    expect(typeof summary.recent).toBe('number');
    expect(typeof summary.idle).toBe('number');
    expect(typeof summary.unknown).toBe('number');
  });

  test('maps registered agents from snapshot', async () => {
    const agents = [
      makeBrainAgent({ name: 'iktinos', can_execute: true, registry_source: true }),
      makeBrainAgent({ name: 'pheidias', can_execute: false, registry_source: true }),
    ];
    mockGetBrainSnapshot.mockImplementation(async () => makeSnapshot(agents));

    const app = buildApp();
    const body = (await (await fetchAgents(app)).json()) as Record<string, unknown>;
    const registered = body.registered_agents as Record<string, unknown>[];

    expect(registered).toHaveLength(2);
    expect(registered[0]!.name).toBe('iktinos');
    expect(registered[0]!.enabled).toBe(true);
    expect(registered[1]!.name).toBe('pheidias');
    expect(registered[1]!.enabled).toBe(false);
  });

  test('splits enabled and disabled agents', async () => {
    const agents = [
      makeBrainAgent({ name: 'a1', can_execute: true, registry_source: true }),
      makeBrainAgent({ name: 'a2', can_execute: false, registry_source: true }),
      makeBrainAgent({ name: 'a3', can_execute: true, registry_source: true }),
    ];
    mockGetBrainSnapshot.mockImplementation(async () => makeSnapshot(agents));

    const app = buildApp();
    const body = (await (await fetchAgents(app)).json()) as Record<string, unknown>;

    expect((body.enabled_agents as unknown[]).length).toBe(2);
    expect((body.disabled_agents as unknown[]).length).toBe(1);
    expect((body.summary as Record<string, number>).enabled_count).toBe(2);
    expect((body.summary as Record<string, number>).disabled_count).toBe(1);
  });

  test('filters registry_source for registered_agents', async () => {
    const agents = [
      makeBrainAgent({ name: 'registered', registry_source: true }),
      makeBrainAgent({ name: 'definition-only', registry_source: false, definition_source: true }),
    ];
    mockGetBrainSnapshot.mockImplementation(async () => makeSnapshot(agents));

    const app = buildApp();
    const body = (await (await fetchAgents(app)).json()) as Record<string, unknown>;
    const registered = body.registered_agents as Record<string, unknown>[];

    expect(registered).toHaveLength(1);
    expect(registered[0]!.name).toBe('registered');
  });

  test('surfaces discovered_definitions from definition_source', async () => {
    const agents = [
      makeBrainAgent({ name: 'both', registry_source: true, definition_source: true }),
      makeBrainAgent({ name: 'def-only', registry_source: false, definition_source: true }),
      makeBrainAgent({ name: 'reg-only', registry_source: true, definition_source: false }),
    ];
    mockGetBrainSnapshot.mockImplementation(async () => makeSnapshot(agents));

    const app = buildApp();
    const body = (await (await fetchAgents(app)).json()) as Record<string, unknown>;
    const definitions = body.discovered_definitions as string[];

    expect(definitions).toHaveLength(2);
    expect(definitions).toContain('both');
    expect(definitions).toContain('def-only');
  });

  test('detects drift excluding orchestrators and operator_personas', async () => {
    const agents = [
      makeBrainAgent({
        name: 'drifted-worker',
        consistency: 'drift_missing_registry',
        type: 'worker',
      }),
      makeBrainAgent({
        name: 'drifted-orch',
        consistency: 'drift_missing_definition',
        type: 'orchestrator',
      }),
      makeBrainAgent({
        name: 'drifted-persona',
        consistency: 'drift_missing_policy',
        type: 'operator_persona',
      }),
      makeBrainAgent({ name: 'clean-worker', consistency: 'consistent', type: 'worker' }),
    ];
    mockGetBrainSnapshot.mockImplementation(async () => makeSnapshot(agents));

    const app = buildApp();
    const body = (await (await fetchAgents(app)).json()) as Record<string, unknown>;
    const drift = body.registry_definition_drift as Record<string, string>[];

    expect(drift).toHaveLength(1);
    expect(drift[0]!.agent).toBe('drifted-worker');
    expect(drift[0]!.issue).toBe('missing_registry');
    expect((body.summary as Record<string, number>).drift_count).toBe(1);
  });

  test('drift recommendation varies by consistency type', async () => {
    const agents = [
      makeBrainAgent({
        name: 'missing-reg',
        consistency: 'drift_missing_registry',
        type: 'worker',
      }),
      makeBrainAgent({
        name: 'missing-def',
        consistency: 'drift_missing_definition',
        type: 'gate',
      }),
    ];
    mockGetBrainSnapshot.mockImplementation(async () => makeSnapshot(agents));

    const app = buildApp();
    const body = (await (await fetchAgents(app)).json()) as Record<string, unknown>;
    const drift = body.registry_definition_drift as Record<string, string>[];

    expect(drift).toHaveLength(2);
    expect(drift[0]!.recommendation).toContain('registry.json');
    expect(drift[1]!.recommendation).toContain('missing definition');
  });

  test('backward-compat summary.total equals registered_count', async () => {
    const agents = [
      makeBrainAgent({ name: 'a1', registry_source: true }),
      makeBrainAgent({ name: 'a2', registry_source: true }),
    ];
    mockGetBrainSnapshot.mockImplementation(async () => makeSnapshot(agents));

    const app = buildApp();
    const body = (await (await fetchAgents(app)).json()) as Record<string, unknown>;
    const summary = body.summary as Record<string, number>;

    expect(summary.total).toBe(summary.registered_count);
    expect(summary.total).toBe(2);
  });

  test('empty snapshot returns zeroed counts', async () => {
    mockGetBrainSnapshot.mockImplementation(async () => makeSnapshot([]));

    const app = buildApp();
    const body = (await (await fetchAgents(app)).json()) as Record<string, unknown>;
    const summary = body.summary as Record<string, number>;

    expect(summary.registered_count).toBe(0);
    expect(summary.enabled_count).toBe(0);
    expect(summary.disabled_count).toBe(0);
    expect(summary.drift_count).toBe(0);
    expect((body.registered_agents as unknown[]).length).toBe(0);
    expect((body.registry_definition_drift as unknown[]).length).toBe(0);
  });
});
