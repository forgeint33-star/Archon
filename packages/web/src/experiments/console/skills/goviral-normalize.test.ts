/**
 * Contract + behaviour regression tests for the GoViral Control Plane console.
 *
 * The fixtures below are captured verbatim from the live service on
 * 2026-07-19 (http://127.0.0.1:8180). They exist because the previous console
 * types described shapes the backend never emitted, which crashed render with
 * `Cannot read properties of undefined (reading 'pending')`. Any future drift
 * between these fixtures and the real payloads should fail here rather than in
 * the browser.
 */

import { describe, test, expect } from 'bun:test';
import {
  normalizeOverview,
  normalizeApprovalAnalysis,
  normalizeSemanticServices,
  normalizeModules,
  normalizeIntegrations,
  normalizeReconciliation,
  normalizeCanary,
  normalizeAccess,
  normalizeRuntime,
  toSectionState,
  renderCount,
  renderText,
  renderRatio,
  ABSENT,
} from './goviral-normalize';

// ─── Captured live payloads ─────────────────────────────────────────────────

const LIVE_OVERVIEW = {
  generated_at: '2026-07-19T20:01:13.260Z',
  brain_root: '/var/lib/goviral-archon/workspaces/goviral-brain',
  doctor: {
    status: 'PASS',
    source: '.governance/brainos-master/doctor/latest.txt',
    modified_at: '2026-07-19T19:25:53.155Z',
  },
  approvals: {
    pending: 0,
    approved: 0,
    rejected: 0,
    executed: 0,
    modified_at: '2026-07-18T17:51:06.341Z',
  },
  brain: {
    health: 'healthy',
    schema_version: 1,
    drift_count: 17,
    warning_count: 0,
    cache: { has_cached: true, age_seconds: 117, stale: false, freshness: 'fresh' },
    snapshot_freshness: {
      generated_at: '2026-07-19T19:59:33.042Z',
      source_updated_at: '2026-06-27T14:52:17.309Z',
      age_seconds: 117,
      freshness: 'fresh',
      producer: 'goviral-brain-snapshot',
      producer_status: 'idle',
      last_success_at: '2026-07-19T19:59:33.042Z',
      last_error_at: null,
      last_error_summary: null,
      threshold_seconds: 600,
    },
  },
  modules: [
    {
      id: 'approval_inbox',
      label: 'Approval Inbox',
      run_id: 'approval-inbox-20260719-195252',
      updated_at: '2026-07-19T19:52:52.337Z',
      owner_agent: 'system',
      health: 'healthy',
      state: 'identified',
    },
  ],
  recent_threads: [
    {
      id: 'thread-20260627-220905',
      status: 'planned',
      lane: 'engineering',
      lead_agent: 'iktinos',
      agent_type: 'worker',
      created_at: '2026-06-27T22:09:06+00:00',
    },
  ],
  latest_prd: {
    run_id: 'run-20260717-165147-ba2a021876',
    title: 'GoViral Prompt-to-PRD',
    path: '.governance/brain-auto-workflow/runs/run-20260717-165147-ba2a021876/PRD.md',
    modified_at: '2026-07-17T16:51:47.782Z',
  },
};

const LIVE_APPROVAL_ANALYSIS = {
  generated_at: '2026-07-19T20:01:13.260Z',
  queue_hash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  total_pending: 0,
  groups: [],
  classifications: {},
  validation_errors: [],
  malformed_count: 0,
  duplicate_group_count: 0,
};

const LIVE_SEMANTIC = {
  generated_at: '2026-07-19T20:01:21.573Z',
  services: [
    {
      name: 'goviral-action-firewall.timer',
      description: 'Run GoViral Action Firewall every 30 minutes',
      semantic_state: 'scheduled',
      unit_type: 'timer',
      active_now: false,
      enabled: true,
      timer_active: true,
      scheduled: true,
      next_run_at: null,
      last_run_at: null,
      last_result: null,
      health: 'healthy',
      expected_idle: true,
    },
  ],
  aggregates: {
    running: 0,
    healthy_idle: 0,
    scheduled: 22,
    disabled: 18,
    degraded: 0,
    failed: 0,
    unknown: 0,
  },
  summary: { total: 40, healthy: 22, attention: 0, disabled: 18 },
};

const LIVE_MODULES = {
  generated_at: '2026-07-19T20:01:13.260Z',
  modules: [
    {
      module_id: 'approval_inbox',
      display_name: 'Approval Inbox',
      owner_agent: 'system',
      workflow: 'goviral-approval-inbox',
      latest_run_id: 'approval-inbox-20260719-195252',
      latest_run_at: '2026-07-19T19:52:52.337Z',
      enabled: true,
      health: 'healthy',
      state: 'identified',
    },
    {
      module_id: 'prompt_command_center',
      display_name: 'Prompt Command Center',
      owner_agent: 'system',
      workflow: 'goviral-prompt-command-center',
      latest_run_id: null,
      latest_run_at: null,
      enabled: true,
      health: 'unknown',
      state: 'partially_identified',
    },
  ],
};

const LIVE_INTEGRATIONS = {
  generated_at: '2026-07-19T20:01:30.250Z',
  telegram: {
    configured: true,
    enabled: true,
    reachable: true,
    last_test_at: null,
    last_delivery_at: '2026-07-19T08:03:33.386465Z',
    last_error_summary: null,
    notifier_timer_active: true,
    daily_digest_timer_active: true,
    credentials_present: false,
    platform_adapter_active: true,
    goviral_scripts_active: true,
  },
  clickup: {
    configured: false,
    stage: 'not_configured',
    writes_enabled: false,
    connectivity_tested: false,
    last_connectivity_test_at: null,
    governance_tier_count: 24,
  },
  qdrant: {
    configured: false,
    reachable: true,
    healthy: false,
    collections_count: null,
    last_checked_at: '2026-07-19T20:01:30.250Z',
    status: 'running',
  },
};

const LIVE_RECONCILIATION = {
  generated_at: '2026-07-19T20:01:13.299Z',
  canonical_identity_key: 'agent_name',
  registered: ['iktinos', 'demosthenes', 'pheidias'],
  defined: ['iktinos', 'demosthenes', 'pheidias', 'herodotos'],
  runtime_discovered: [],
  drift: [
    {
      agent: 'herodotos',
      classification: 'missing_registry',
      evidence:
        'Definition file exists at .claude/agents/herodotos.md but no entry in registry.json',
      recommendation: 'Add "herodotos" to .governance/agents/registry.json',
      safe_action: null,
    },
  ],
  reconciliation_proposal: [
    {
      agent: 'herodotos',
      action: 'Register agent "herodotos" in registry.json',
      requires_approval: true,
      justification: 'Agent has a definition file but is not registered',
    },
  ],
  drift_count: 1,
  resolved_count: 8,
};

const LIVE_CANARY = {
  generated_at: '2026-07-19T20:01:13.275Z',
  canary: {
    id: null,
    status: 'none',
    started_at: null,
    completed_at: null,
    error: null,
  },
};

const LIVE_ACCESS = {
  generated_at: '2026-07-19T20:01:21.599Z',
  access_mode: 'loopback_private',
  bind_address: '127.0.0.1',
  port: 8180,
  auth_enabled: false,
  public_exposure: false,
  rbac: {
    active: true,
    roles: ['viewer', 'operator', 'admin'],
    current_role: 'operator',
    enforcement: 'active',
  },
  design_document: 'ops/goviral-control-plane/RBAC-DESIGN.md',
};

/** Live and genuinely degraded: HTTP 200, but systemd details could not be read. */
const LIVE_RUNTIME_DEGRADED = {
  generated_at: '2026-07-19T20:01:13.299Z',
  available: false,
  services: [],
  timers: [
    {
      name: 'goviral-action-firewall.timer',
      description: 'Run GoViral Action Firewall every 30 minutes',
      active_state: 'active',
      sub_state: 'waiting',
      unit_file_state: 'enabled',
      next_trigger: null,
    },
  ],
  summary: {
    services_total: 0,
    services_active: 0,
    timers_total: 40,
    timers_active: 22,
    failed_units: 0,
  },
  error: 'systemd unit details unavailable',
};

/** Every payload shape a normalizer must survive without throwing. */
const HOSTILE_INPUTS: [string, unknown][] = [
  ['null', null],
  ['undefined', undefined],
  ['a number', 42],
  ['a string', 'not json'],
  ['an array', [1, 2, 3]],
  ['an empty object', {}],
  ['nested nulls', { doctor: null, approvals: null, brain: null, summary: null, canary: null }],
  [
    'wrong-typed fields',
    {
      doctor: 'PASS',
      approvals: [],
      counts: 5,
      aggregates: 'none',
      services: {},
      modules: 'many',
      drift: null,
      canary: 7,
      summary: [],
      rbac: false,
    },
  ],
  ['NaN counts', { total_pending: NaN, drift_count: Infinity, summary: { total: NaN } }],
];

const ALL_NORMALIZERS: [string, (raw: unknown) => { availability: unknown }][] = [
  ['normalizeOverview', normalizeOverview],
  ['normalizeApprovalAnalysis', normalizeApprovalAnalysis],
  ['normalizeSemanticServices', normalizeSemanticServices],
  ['normalizeModules', normalizeModules],
  ['normalizeIntegrations', normalizeIntegrations],
  ['normalizeReconciliation', normalizeReconciliation],
  ['normalizeCanary', normalizeCanary],
  ['normalizeAccess', normalizeAccess],
  ['normalizeRuntime', normalizeRuntime],
];

// ─── The reported live defect ───────────────────────────────────────────────

describe('regression: the reported live crash', () => {
  test('the approval payload has no `counts` key at all — reading it was the bug', () => {
    expect('counts' in LIVE_APPROVAL_ANALYSIS).toBe(false);
    // The old consumer evaluated `approvalAnalysis?.counts.pending`, which guards
    // the parent but not `counts`, throwing on the real payload.
    const raw = LIVE_APPROVAL_ANALYSIS as unknown as { counts?: { pending: number } };
    expect(() => raw.counts!.pending).toThrow();
  });

  test('normalizing the same payload yields the pending count without throwing', () => {
    const view = normalizeApprovalAnalysis(LIVE_APPROVAL_ANALYSIS);
    expect(view.totalPending).toBe(0);
    expect(view.availability).toEqual({ kind: 'ready' });
  });

  test('the canary payload nests under `canary` — reading it flat produced undefined', () => {
    expect('status' in LIVE_CANARY).toBe(false);
    const view = normalizeCanary(LIVE_CANARY);
    expect(view.status).toBe('none');
    expect(view.isRunning).toBe(false);
  });

  test('the reconciliation payload has `drift`, not `drift_items`', () => {
    expect('drift_items' in LIVE_RECONCILIATION).toBe(false);
    const view = normalizeReconciliation(LIVE_RECONCILIATION);
    expect(view.drift).toHaveLength(1);
    expect(view.driftCount).toBe(1);
  });
});

// ─── No input can throw ─────────────────────────────────────────────────────

describe('every normalizer survives every hostile payload', () => {
  for (const [normalizerName, normalize] of ALL_NORMALIZERS) {
    for (const [inputName, input] of HOSTILE_INPUTS) {
      test(`${normalizerName} does not throw on ${inputName}`, () => {
        expect(() => normalize(input)).not.toThrow();
        expect(normalize(input).availability).toBeDefined();
      });
    }
  }
});

// ─── Missing never becomes a measurement ────────────────────────────────────

describe('absent data is never rendered as a measured value', () => {
  test('an empty overview reports null counts and null doctor status, not 0 / UNKNOWN', () => {
    const view = normalizeOverview({});
    expect(view.doctorStatus).toBeNull();
    expect(view.approvals).toEqual({
      pending: null,
      approved: null,
      rejected: null,
      executed: null,
    });
    // The old page rendered `?? 'UNKNOWN'` and `?? 0` here.
    expect(view.doctorStatus).not.toBe('UNKNOWN');
    expect(view.approvals.pending).not.toBe(0);
  });

  test('an empty semantic payload reports null aggregates, not zeros', () => {
    const view = normalizeSemanticServices({});
    expect(view.total).toBeNull();
    expect(view.aggregates.failed).toBeNull();
    expect(view.aggregates.running).toBeNull();
  });

  test('a genuine zero is preserved as a zero, not confused with absence', () => {
    const view = normalizeSemanticServices(LIVE_SEMANTIC);
    expect(view.aggregates.failed).toBe(0);
    expect(view.aggregates.scheduled).toBe(22);
    expect(view.total).toBe(40);
  });

  test('NaN and Infinity are treated as absent, never as counts', () => {
    const view = normalizeApprovalAnalysis({ total_pending: NaN });
    expect(view.totalPending).toBeNull();
    expect(normalizeReconciliation({ drift_count: Infinity }).driftCount).toBeNull();
  });

  test('render helpers turn absence into a glyph and never into 0', () => {
    expect(renderCount(null)).toBe(ABSENT);
    expect(renderCount(0)).toBe('0');
    expect(renderText(null)).toBe(ABSENT);
    expect(renderRatio(null, 40)).toBe(ABSENT);
    expect(renderRatio(22, null)).toBe(ABSENT);
    expect(renderRatio(22, 40)).toBe('22/40');
  });
});

// ─── API-provided values render accurately ──────────────────────────────────

describe('values the API does provide are preserved exactly', () => {
  test('overview: PASS, source, freshness and staleness evidence', () => {
    const view = normalizeOverview(LIVE_OVERVIEW);
    expect(view.doctorStatus).toBe('PASS');
    expect(view.doctorSource).toBe('.governance/brainos-master/doctor/latest.txt');
    expect(view.generatedAt).toBe('2026-07-19T20:01:13.260Z');
    expect(view.brainHealth).toBe('healthy');
    expect(view.brainDriftCount).toBe(17);
    expect(view.freshness?.level).toBe('fresh');
    expect(view.freshness?.ageSeconds).toBe(117);
    expect(view.freshness?.producer).toBe('goviral-brain-snapshot');
    expect(view.freshness?.sourceUpdatedAt).toBe('2026-06-27T14:52:17.309Z');
    expect(view.latestPrdTitle).toBe('GoViral Prompt-to-PRD');
    expect(view.threads).toHaveLength(1);
    expect(view.threads[0]?.leadAgent).toBe('iktinos');
  });

  test('modules: `module_id`/`display_name` spelling is read correctly', () => {
    const view = normalizeModules(LIVE_MODULES);
    expect(view.modules).toHaveLength(2);
    expect(view.modules[0]?.id).toBe('approval_inbox');
    expect(view.modules[0]?.label).toBe('Approval Inbox');
    expect(view.modules[0]?.runId).toBe('approval-inbox-20260719-195252');
    expect(view.modules[1]?.state).toBe('partially_identified');
    expect(view.modules[1]?.runId).toBeNull();
  });

  test('modules: the overview `id`/`label` spelling is also accepted', () => {
    const view = normalizeOverview(LIVE_OVERVIEW);
    expect(view.modules[0]?.id).toBe('approval_inbox');
    expect(view.modules[0]?.label).toBe('Approval Inbox');
  });

  test('services: every live unit is retained with its semantic state', () => {
    const view = normalizeSemanticServices(LIVE_SEMANTIC);
    expect(view.services).toHaveLength(1);
    expect(view.services[0]?.name).toBe('goviral-action-firewall.timer');
    expect(view.services[0]?.semanticState).toBe('scheduled');
    expect(view.healthy).toBe(22);
  });

  test('services: an unrecognized semantic state degrades to `unknown`, not a crash', () => {
    const view = normalizeSemanticServices({
      services: [{ name: 'x.service', semantic_state: 'brand_new_state' }],
      aggregates: {},
    });
    expect(view.services[0]?.semanticState).toBe('unknown');
  });

  test('access: RBAC role is read from the nested `rbac` object', () => {
    const view = normalizeAccess(LIVE_ACCESS);
    expect(view.accessMode).toBe('loopback_private');
    expect(view.rbacRole).toBe('operator');
    expect(view.rbacEnforcement).toBe('active');
    expect(view.publicExposure).toBe(false);
    expect(view.port).toBe(8180);
  });

  test('integrations: state is derived and configuration is reported honestly', () => {
    const view = normalizeIntegrations(LIVE_INTEGRATIONS);
    expect(view.telegram?.configured).toBe(true);
    expect(view.telegram?.state).toBe('healthy');
    expect(view.telegram?.lastActivityAt).toBe('2026-07-19T08:03:33.386465Z');
    expect(view.clickup?.configured).toBe(false);
    expect(view.clickup?.state).toBe('not_configured');
    // Live qdrant reports reachable:true, healthy:false but configured:false.
    // "Not configured" takes precedence: a service that was never configured is
    // not "degraded", and claiming otherwise would invent a fault.
    expect(view.qdrant?.state).toBe('not configured');
    expect(view.qdrant?.reachable).toBe(true);
  });

  test('a configured but unhealthy service does read as degraded', () => {
    const view = normalizeIntegrations({
      qdrant: { configured: true, reachable: true, healthy: false },
    });
    expect(view.qdrant?.state).toBe('degraded');
  });

  test('integrations: unknown configuration is not asserted as "not configured"', () => {
    const view = normalizeIntegrations({ telegram: {}, clickup: {}, qdrant: {} });
    expect(view.telegram?.configured).toBeNull();
    expect(view.telegram?.state).toBeNull();
  });

  test('reconciliation: drift and proposals are read from their real keys', () => {
    const view = normalizeReconciliation(LIVE_RECONCILIATION);
    expect(view.drift[0]?.agent).toBe('herodotos');
    expect(view.drift[0]?.classification).toBe('missing_registry');
    expect(view.proposals[0]?.requiresApproval).toBe(true);
    expect(view.registered).toHaveLength(3);
    expect(view.defined).toHaveLength(4);
  });
});

// ─── /runtime partial availability must not be falsified ────────────────────

describe('/runtime availability is reported truthfully', () => {
  test('a degraded probe is partial, not ready, and keeps the server reason', () => {
    const view = normalizeRuntime(LIVE_RUNTIME_DEGRADED);
    expect(view.availability).toEqual({
      kind: 'partial',
      reason: 'systemd unit details unavailable',
    });
  });

  test('the half that did return data stays visible', () => {
    const view = normalizeRuntime(LIVE_RUNTIME_DEGRADED);
    expect(view.timers).toHaveLength(1);
    expect(view.timers[0]?.name).toBe('goviral-action-firewall.timer');
    expect(view.timersTotal).toBe(40);
    expect(view.timersActive).toBe(22);
  });

  test('the half that failed reports null counts, never a measured zero', () => {
    const view = normalizeRuntime(LIVE_RUNTIME_DEGRADED);
    // The server sends services_total: 0 alongside available: false. Rendering
    // that 0 would assert "there are no services", which is false — the probe
    // simply could not read them.
    expect(LIVE_RUNTIME_DEGRADED.summary.services_total).toBe(0);
    expect(view.servicesTotal).toBeNull();
    expect(view.servicesActive).toBeNull();
    expect(view.failedUnits).toBeNull();
  });

  test('a fully failed probe is unavailable, not partial', () => {
    const view = normalizeRuntime({
      available: false,
      services: [],
      timers: [],
      error: 'systemd query unavailable',
      summary: {},
    });
    expect(view.availability).toEqual({
      kind: 'unavailable',
      reason: 'systemd query unavailable',
    });
  });

  test('a degraded probe with no error string still gets a real reason', () => {
    const view = normalizeRuntime({ available: false, services: [], timers: [] });
    expect(view.availability.kind).toBe('unavailable');
    if (view.availability.kind !== 'ready') {
      expect(view.availability.reason.length).toBeGreaterThan(0);
    }
  });

  test('a healthy probe is ready and reports its counts', () => {
    const view = normalizeRuntime({
      available: true,
      services: [{ name: 'a.service', active_state: 'active' }],
      timers: [],
      summary: {
        services_total: 1,
        services_active: 1,
        timers_total: 0,
        timers_active: 0,
        failed_units: 0,
      },
    });
    expect(view.availability).toEqual({ kind: 'ready' });
    expect(view.servicesTotal).toBe(1);
    expect(view.failedUnits).toBe(0);
  });

  test('a missing `available` flag is partial — absence of the flag is not health', () => {
    const view = normalizeRuntime({ services: [], timers: [], summary: {} });
    expect(view.availability.kind).toBe('partial');
  });
});

// ─── Loading / error / unavailable are distinct ─────────────────────────────

describe('load state is distinct from data availability', () => {
  test('a rejected fetch becomes an error state carrying the real message', () => {
    const state = toSectionState(
      { status: 'rejected', reason: new Error('API error 500 (/api/goviral/overview): boom') },
      normalizeOverview
    );
    expect(state.status).toBe('error');
    if (state.status === 'error') {
      expect(state.message).toContain('500');
    }
  });

  test('a rejection with no message still yields a non-empty error', () => {
    const state = toSectionState({ status: 'rejected', reason: undefined }, normalizeOverview);
    expect(state.status).toBe('error');
    if (state.status === 'error') {
      expect(state.message).toBe('Request failed with no detail');
    }
  });

  test('a fulfilled fetch of a degraded payload is loaded-but-unavailable, not an error', () => {
    const state = toSectionState({ status: 'fulfilled', value: {} }, normalizeSemanticServices);
    expect(state.status).toBe('loaded');
    if (state.status === 'loaded') {
      expect(state.value.availability.kind).toBe('partial');
      expect(state.value.total).toBeNull();
    }
  });

  test('a fulfilled fetch of a complete payload is loaded and ready', () => {
    const state = toSectionState(
      { status: 'fulfilled', value: LIVE_SEMANTIC },
      normalizeSemanticServices
    );
    expect(state.status).toBe('loaded');
    if (state.status === 'loaded') {
      expect(state.value.availability).toEqual({ kind: 'ready' });
    }
  });

  test('a non-object success body is loaded-but-unavailable with a stated reason', () => {
    const state = toSectionState({ status: 'fulfilled', value: 'oops' }, normalizeOverview);
    expect(state.status).toBe('loaded');
    if (state.status === 'loaded') {
      expect(state.value.availability.kind).toBe('unavailable');
    }
  });
});

// ─── Partial payloads keep what they have ───────────────────────────────────

describe('partial payloads surface what is present and name what is not', () => {
  test('an overview missing `doctor` still renders approvals and says what is missing', () => {
    const { doctor, ...withoutDoctor } = LIVE_OVERVIEW;
    void doctor;
    const view = normalizeOverview(withoutDoctor);
    expect(view.availability.kind).toBe('partial');
    if (view.availability.kind !== 'ready') {
      expect(view.availability.reason).toContain('doctor');
    }
    expect(view.doctorStatus).toBeNull();
    expect(view.approvals.pending).toBe(0);
    expect(view.latestPrdTitle).toBe('GoViral Prompt-to-PRD');
  });

  test('integrations missing one service keeps the other two and names the gap', () => {
    const { qdrant, ...withoutQdrant } = LIVE_INTEGRATIONS;
    void qdrant;
    const view = normalizeIntegrations(withoutQdrant);
    expect(view.telegram).not.toBeNull();
    expect(view.qdrant).toBeNull();
    if (view.availability.kind !== 'ready') {
      expect(view.availability.reason).toContain('qdrant');
    }
  });

  test('malformed list entries are dropped, not rendered as blank rows', () => {
    const view = normalizeSemanticServices({
      services: [{ name: 'ok.service' }, { description: 'no name' }, null, 'string'],
      aggregates: {},
    });
    expect(view.services).toHaveLength(1);
    expect(view.services[0]?.name).toBe('ok.service');
  });

  test('approval validation errors are surfaced with their item ids', () => {
    const view = normalizeApprovalAnalysis({
      total_pending: 2,
      validation_errors: [{ item_id: 'req-1', errors: ['missing status'], approvable: false }],
      malformed_count: 1,
    });
    expect(view.validationErrors).toHaveLength(1);
    expect(view.validationErrors[0]?.itemId).toBe('req-1');
    expect(view.validationErrors[0]?.errors).toEqual(['missing status']);
    expect(view.malformedCount).toBe(1);
  });

  test('approval classifications become a renderable list', () => {
    const view = normalizeApprovalAnalysis({
      total_pending: 3,
      classifications: { LOW_RISK: 2, RISK_ENGINE_FAILED: 1, bogus: 'not a number' },
    });
    expect(view.classifications).toEqual([
      { label: 'LOW_RISK', count: 2 },
      { label: 'RISK_ENGINE_FAILED', count: 1 },
    ]);
  });
});
