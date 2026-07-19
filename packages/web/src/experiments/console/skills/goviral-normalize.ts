/**
 * Normalization layer for the GoViral Control Plane endpoints.
 *
 * The `/api/goviral/*` routes are hand-rolled `c.json()` handlers with no Zod
 * schema, and `requestJson<T>` casts the body with `as Promise<T>` and no
 * runtime check — so nothing validates these payloads at any layer. The
 * previous console types described shapes the backend never emitted, and the
 * mismatch surfaced only as `Cannot read properties of undefined` deep inside
 * render.
 *
 * Every function here takes `unknown` and returns a fully-populated view model.
 * Two rules hold throughout:
 *
 *  1. A value that is missing or unreadable becomes `null`, NEVER `0` / `'PASS'`
 *     / `'UNKNOWN'`. Callers render `null` as an explicit absence, so the UI can
 *     never present un-read data as a measurement.
 *  2. Every section carries an `Availability` describing whether the payload was
 *     fully understood, understood in part, or not at all — with the real reason.
 */

// ─── Availability ───────────────────────────────────────────────────────────

export type Availability =
  | { kind: 'ready' }
  /** Some of the payload was usable; `reason` says what was not, and why. */
  | { kind: 'partial'; reason: string }
  /** Nothing usable was present; `reason` says why. */
  | { kind: 'unavailable'; reason: string };

export const READY: Availability = { kind: 'ready' };

export function partial(reason: string): Availability {
  return { kind: 'partial', reason };
}

export function unavailable(reason: string): Availability {
  return { kind: 'unavailable', reason };
}

/**
 * Per-section load state. `loading` and `error` are distinct from an
 * `unavailable` payload: the first two describe the request, the third
 * describes data the server successfully returned but could not populate.
 */
export type SectionState<T> =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'loaded'; value: T };

/**
 * Maps a settled fetch into a section state, preserving the real error text
 * rather than collapsing every failure into a generic message.
 */
export function toSectionState<T>(
  result: PromiseSettledResult<unknown>,
  normalize: (raw: unknown) => T
): SectionState<T> {
  if (result.status === 'fulfilled') {
    return { status: 'loaded', value: normalize(result.value) };
  }

  const reason: unknown = result.reason;
  const message =
    reason instanceof Error && reason.message ? reason.message : 'Request failed with no detail';

  return { status: 'error', message };
}

// ─── Structural primitives ──────────────────────────────────────────────────

export function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

export function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Rejects NaN and Infinity — a non-finite count is not a measurement. */
export function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function asBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Counts how many of the given keys are absent, for partial-availability reasons. */
function missingKeys(record: Record<string, unknown> | null, keys: string[]): string[] {
  if (!record) return keys;
  return keys.filter(key => record[key] === undefined || record[key] === null);
}

// ─── Overview ───────────────────────────────────────────────────────────────

export interface ApprovalCounts {
  pending: number | null;
  approved: number | null;
  rejected: number | null;
  executed: number | null;
}

export type FreshnessLevel = 'fresh' | 'delayed' | 'stale' | 'unavailable';

export interface SnapshotFreshnessView {
  generatedAt: string | null;
  sourceUpdatedAt: string | null;
  ageSeconds: number | null;
  /** `null` when the server did not report a recognized level — not 'unavailable'. */
  level: FreshnessLevel | null;
  producer: string | null;
  producerStatus: string | null;
  lastSuccessAt: string | null;
  lastErrorAt: string | null;
  lastErrorSummary: string | null;
  thresholdSeconds: number | null;
}

export interface OverviewThreadView {
  id: string | null;
  status: string | null;
  lane: string | null;
  leadAgent: string | null;
  agentType: string | null;
  createdAt: string | null;
}

export interface OverviewModuleView {
  id: string | null;
  label: string | null;
  runId: string | null;
  updatedAt: string | null;
  ownerAgent: string | null;
  health: string | null;
  state: string | null;
}

export interface OverviewView {
  availability: Availability;
  generatedAt: string | null;
  brainRoot: string | null;
  /** `null` when the server could not classify doctor health — never 'UNKNOWN'. */
  doctorStatus: string | null;
  doctorSource: string | null;
  doctorModifiedAt: string | null;
  approvals: ApprovalCounts;
  approvalsModifiedAt: string | null;
  brainHealth: string | null;
  brainDriftCount: number | null;
  freshness: SnapshotFreshnessView | null;
  modules: OverviewModuleView[];
  threads: OverviewThreadView[];
  latestPrdTitle: string | null;
  latestPrdRunId: string | null;
  latestPrdModifiedAt: string | null;
}

const FRESHNESS_LEVELS: FreshnessLevel[] = ['fresh', 'delayed', 'stale', 'unavailable'];

function asFreshnessLevel(value: unknown): FreshnessLevel | null {
  const text = asString(value);
  return text !== null && (FRESHNESS_LEVELS as string[]).includes(text)
    ? (text as FreshnessLevel)
    : null;
}

function normalizeFreshness(raw: unknown): SnapshotFreshnessView | null {
  const record = asRecord(raw);
  if (!record) return null;

  return {
    generatedAt: asString(record.generated_at),
    sourceUpdatedAt: asString(record.source_updated_at),
    ageSeconds: asNumber(record.age_seconds),
    level: asFreshnessLevel(record.freshness),
    producer: asString(record.producer),
    producerStatus: asString(record.producer_status),
    lastSuccessAt: asString(record.last_success_at),
    lastErrorAt: asString(record.last_error_at),
    lastErrorSummary: asString(record.last_error_summary),
    thresholdSeconds: asNumber(record.threshold_seconds),
  };
}

/**
 * `/api/goviral/overview`. Note the overview's own `modules[]` use `id`/`label`,
 * whereas `/api/goviral/modules` uses `module_id`/`display_name` — both spellings
 * are accepted here so neither renders blank.
 */
export function normalizeOverview(raw: unknown): OverviewView {
  const root = asRecord(raw);

  if (!root) {
    return {
      availability: unavailable('Overview response was not a JSON object'),
      generatedAt: null,
      brainRoot: null,
      doctorStatus: null,
      doctorSource: null,
      doctorModifiedAt: null,
      approvals: { pending: null, approved: null, rejected: null, executed: null },
      approvalsModifiedAt: null,
      brainHealth: null,
      brainDriftCount: null,
      freshness: null,
      modules: [],
      threads: [],
      latestPrdTitle: null,
      latestPrdRunId: null,
      latestPrdModifiedAt: null,
    };
  }

  const doctor = asRecord(root.doctor);
  const approvals = asRecord(root.approvals);
  const brain = asRecord(root.brain);
  const latestPrd = asRecord(root.latest_prd);

  const absent = missingKeys(root, ['doctor', 'approvals']);
  const availability =
    absent.length > 0 ? partial(`Missing from overview payload: ${absent.join(', ')}`) : READY;

  return {
    availability,
    generatedAt: asString(root.generated_at),
    brainRoot: asString(root.brain_root),
    doctorStatus: asString(doctor?.status),
    doctorSource: asString(doctor?.source),
    doctorModifiedAt: asString(doctor?.modified_at),
    approvals: {
      pending: asNumber(approvals?.pending),
      approved: asNumber(approvals?.approved),
      rejected: asNumber(approvals?.rejected),
      executed: asNumber(approvals?.executed),
    },
    approvalsModifiedAt: asString(approvals?.modified_at),
    brainHealth: asString(brain?.health),
    brainDriftCount: asNumber(brain?.drift_count),
    freshness: normalizeFreshness(brain?.snapshot_freshness),
    modules: asArray(root.modules).map((entry): OverviewModuleView => {
      const module = asRecord(entry);
      return {
        id: asString(module?.id) ?? asString(module?.module_id),
        label: asString(module?.label) ?? asString(module?.display_name),
        runId: asString(module?.run_id) ?? asString(module?.latest_run_id),
        updatedAt: asString(module?.updated_at) ?? asString(module?.latest_run_at),
        ownerAgent: asString(module?.owner_agent),
        health: asString(module?.health),
        state: asString(module?.state),
      };
    }),
    threads: asArray(root.recent_threads).map((entry): OverviewThreadView => {
      const thread = asRecord(entry);
      return {
        id: asString(thread?.id),
        status: asString(thread?.status),
        lane: asString(thread?.lane),
        leadAgent: asString(thread?.lead_agent),
        agentType: asString(thread?.agent_type),
        createdAt: asString(thread?.created_at),
      };
    }),
    latestPrdTitle: asString(latestPrd?.title),
    latestPrdRunId: asString(latestPrd?.run_id),
    latestPrdModifiedAt: asString(latestPrd?.modified_at),
  };
}

// ─── Approval queue analysis ────────────────────────────────────────────────

export interface ApprovalGroupView {
  fingerprint: string | null;
  titlePattern: string | null;
  count: number | null;
  source: string | null;
  riskClassification: string | null;
  oldestCreatedAt: string | null;
  newestCreatedAt: string | null;
}

export interface ApprovalValidationErrorView {
  itemId: string | null;
  errors: string[];
  approvable: boolean | null;
}

export interface ApprovalAnalysisView {
  availability: Availability;
  generatedAt: string | null;
  queueHash: string | null;
  totalPending: number | null;
  malformedCount: number | null;
  duplicateGroupCount: number | null;
  groups: ApprovalGroupView[];
  validationErrors: ApprovalValidationErrorView[];
  classifications: { label: string; count: number }[];
}

/**
 * `/api/goviral/approvals/analysis`. The console previously read `counts.pending`
 * here — a key this endpoint has never emitted, which is the origin of the live
 * `Cannot read properties of undefined (reading 'pending')`.
 */
export function normalizeApprovalAnalysis(raw: unknown): ApprovalAnalysisView {
  const root = asRecord(raw);

  if (!root) {
    return {
      availability: unavailable('Approval analysis response was not a JSON object'),
      generatedAt: null,
      queueHash: null,
      totalPending: null,
      malformedCount: null,
      duplicateGroupCount: null,
      groups: [],
      validationErrors: [],
      classifications: [],
    };
  }

  const absent = missingKeys(root, ['total_pending']);
  const availability =
    absent.length > 0 ? partial('Approval queue counts were not reported by the server') : READY;

  const classifications = asRecord(root.classifications);

  return {
    availability,
    generatedAt: asString(root.generated_at),
    queueHash: asString(root.queue_hash),
    totalPending: asNumber(root.total_pending),
    malformedCount: asNumber(root.malformed_count),
    duplicateGroupCount: asNumber(root.duplicate_group_count),
    groups: asArray(root.groups).map((entry): ApprovalGroupView => {
      const group = asRecord(entry);
      return {
        fingerprint: asString(group?.fingerprint),
        titlePattern: asString(group?.title_pattern),
        count: asNumber(group?.count),
        source: asString(group?.source),
        riskClassification: asString(group?.risk_classification),
        oldestCreatedAt: asString(group?.oldest_created_at),
        newestCreatedAt: asString(group?.newest_created_at),
      };
    }),
    validationErrors: asArray(root.validation_errors).map((entry): ApprovalValidationErrorView => {
      const error = asRecord(entry);
      return {
        itemId: asString(error?.item_id),
        errors: asArray(error?.errors)
          .map(asString)
          .filter((text): text is string => text !== null),
        approvable: asBoolean(error?.approvable),
      };
    }),
    classifications: Object.entries(classifications ?? {})
      .map(([label, value]): { label: string; count: number } | null => {
        const count = asNumber(value);
        return count === null ? null : { label, count };
      })
      .filter((entry): entry is { label: string; count: number } => entry !== null),
  };
}

// ─── Semantic services ──────────────────────────────────────────────────────

export type SemanticStateKey =
  | 'running'
  | 'healthy_idle'
  | 'scheduled'
  | 'disabled'
  | 'degraded'
  | 'failed'
  | 'unknown';

export const SEMANTIC_STATES: SemanticStateKey[] = [
  'running',
  'healthy_idle',
  'scheduled',
  'disabled',
  'degraded',
  'failed',
  'unknown',
];

export function asSemanticState(value: unknown): SemanticStateKey {
  const text = asString(value);
  return text !== null && (SEMANTIC_STATES as string[]).includes(text)
    ? (text as SemanticStateKey)
    : 'unknown';
}

export interface SemanticServiceView {
  name: string;
  description: string | null;
  semanticState: SemanticStateKey;
  unitType: string | null;
  activeNow: boolean | null;
  enabled: boolean | null;
  scheduled: boolean | null;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastResult: string | null;
  health: string | null;
}

export interface SemanticServicesView {
  availability: Availability;
  generatedAt: string | null;
  services: SemanticServiceView[];
  /** Per-state counts; a state the server omitted stays `null`, not `0`. */
  aggregates: Record<SemanticStateKey, number | null>;
  total: number | null;
  healthy: number | null;
  attention: number | null;
  disabled: number | null;
}

/** `/api/goviral/services/semantic`. */
export function normalizeSemanticServices(raw: unknown): SemanticServicesView {
  const root = asRecord(raw);

  const emptyAggregates = (): Record<SemanticStateKey, number | null> => ({
    running: null,
    healthy_idle: null,
    scheduled: null,
    disabled: null,
    degraded: null,
    failed: null,
    unknown: null,
  });

  if (!root) {
    return {
      availability: unavailable('Semantic services response was not a JSON object'),
      generatedAt: null,
      services: [],
      aggregates: emptyAggregates(),
      total: null,
      healthy: null,
      attention: null,
      disabled: null,
    };
  }

  const aggregatesRaw = asRecord(root.aggregates);
  const summary = asRecord(root.summary);

  const aggregates = emptyAggregates();
  for (const state of SEMANTIC_STATES) {
    aggregates[state] = asNumber(aggregatesRaw?.[state]);
  }

  const availability = aggregatesRaw
    ? READY
    : partial('Service state aggregates were not reported by the server');

  return {
    availability,
    generatedAt: asString(root.generated_at),
    aggregates,
    services: asArray(root.services)
      .map((entry): SemanticServiceView | null => {
        const service = asRecord(entry);
        const name = asString(service?.name);
        if (name === null) return null;

        return {
          name,
          description: asString(service?.description),
          semanticState: asSemanticState(service?.semantic_state),
          unitType: asString(service?.unit_type),
          activeNow: asBoolean(service?.active_now),
          enabled: asBoolean(service?.enabled),
          scheduled: asBoolean(service?.scheduled),
          nextRunAt: asString(service?.next_run_at),
          lastRunAt: asString(service?.last_run_at),
          lastResult: asString(service?.last_result),
          health: asString(service?.health),
        };
      })
      .filter((service): service is SemanticServiceView => service !== null),
    total: asNumber(summary?.total),
    healthy: asNumber(summary?.healthy),
    attention: asNumber(summary?.attention),
    disabled: asNumber(summary?.disabled),
  };
}

// ─── Module manifests ───────────────────────────────────────────────────────

export interface ModuleView {
  id: string;
  label: string | null;
  ownerAgent: string | null;
  workflow: string | null;
  runId: string | null;
  runAt: string | null;
  enabled: boolean | null;
  health: string | null;
  state: string | null;
}

export interface ModulesView {
  availability: Availability;
  generatedAt: string | null;
  modules: ModuleView[];
}

/**
 * `/api/goviral/modules`. Emits `module_id`/`display_name`; the overview variant
 * emits `id`/`label`. Both are accepted.
 */
export function normalizeModules(raw: unknown): ModulesView {
  const root = asRecord(raw);

  if (!root) {
    return {
      availability: unavailable('Modules response was not a JSON object'),
      generatedAt: null,
      modules: [],
    };
  }

  return {
    availability: Array.isArray(root.modules)
      ? READY
      : partial('Module manifests were not reported by the server'),
    generatedAt: asString(root.generated_at),
    modules: asArray(root.modules)
      .map((entry): ModuleView | null => {
        const module = asRecord(entry);
        const id = asString(module?.module_id) ?? asString(module?.id);
        if (id === null) return null;

        return {
          id,
          label: asString(module?.display_name) ?? asString(module?.label),
          ownerAgent: asString(module?.owner_agent),
          workflow: asString(module?.workflow),
          runId: asString(module?.latest_run_id) ?? asString(module?.run_id),
          runAt: asString(module?.latest_run_at) ?? asString(module?.updated_at),
          enabled: asBoolean(module?.enabled),
          health: asString(module?.health),
          state: asString(module?.state),
        };
      })
      .filter((module): module is ModuleView => module !== null),
  };
}

// ─── Integrations ───────────────────────────────────────────────────────────

export interface IntegrationView {
  name: string;
  configured: boolean | null;
  /** Derived presentation state; `null` when configuration is unknown. */
  state: string | null;
  reachable: boolean | null;
  lastActivityAt: string | null;
  lastCheckedAt: string | null;
  lastErrorSummary: string | null;
  details: { label: string; value: string }[];
}

export interface IntegrationsView {
  availability: Availability;
  generatedAt: string | null;
  telegram: IntegrationView | null;
  clickup: IntegrationView | null;
  qdrant: IntegrationView | null;
}

/**
 * These endpoints report no `state` string, so it is derived. `configured`
 * unknown yields `null` rather than inventing "not configured", which would
 * assert a fact the payload does not contain.
 */
function deriveIntegrationState(
  configured: boolean | null,
  reachable: boolean | null,
  healthy: boolean | null
): string | null {
  if (configured === null) return null;
  if (!configured) return 'not configured';
  if (healthy === false || reachable === false) return 'degraded';
  if (reachable === true) return 'healthy';
  return 'configured';
}

function detail(label: string, value: unknown): { label: string; value: string } | null {
  if (typeof value === 'boolean') return { label, value: value ? 'yes' : 'no' };
  const text = asString(value);
  if (text !== null) return { label, value: text };
  const count = asNumber(value);
  return count === null ? null : { label, value: String(count) };
}

function collectDetails(
  record: Record<string, unknown> | null,
  keys: [string, string][]
): { label: string; value: string }[] {
  if (!record) return [];
  return keys
    .map(([key, label]) => detail(label, record[key]))
    .filter((entry): entry is { label: string; value: string } => entry !== null);
}

/** `/api/goviral/integrations`. */
export function normalizeIntegrations(raw: unknown): IntegrationsView {
  const root = asRecord(raw);

  if (!root) {
    return {
      availability: unavailable('Integrations response was not a JSON object'),
      generatedAt: null,
      telegram: null,
      clickup: null,
      qdrant: null,
    };
  }

  const telegramRaw = asRecord(root.telegram);
  const clickupRaw = asRecord(root.clickup);
  const qdrantRaw = asRecord(root.qdrant);

  const absent: string[] = [];
  if (!telegramRaw) absent.push('telegram');
  if (!clickupRaw) absent.push('clickup');
  if (!qdrantRaw) absent.push('qdrant');

  const telegram: IntegrationView | null = telegramRaw
    ? {
        name: 'Telegram',
        configured: asBoolean(telegramRaw.configured),
        state: deriveIntegrationState(
          asBoolean(telegramRaw.configured),
          asBoolean(telegramRaw.reachable),
          asBoolean(telegramRaw.enabled)
        ),
        reachable: asBoolean(telegramRaw.reachable),
        lastActivityAt: asString(telegramRaw.last_delivery_at),
        lastCheckedAt: asString(telegramRaw.last_test_at),
        lastErrorSummary: asString(telegramRaw.last_error_summary),
        details: collectDetails(telegramRaw, [
          ['enabled', 'enabled'],
          ['credentials_present', 'credentials present'],
          ['notifier_timer_active', 'notifier timer'],
          ['daily_digest_timer_active', 'daily digest timer'],
          ['platform_adapter_active', 'platform adapter'],
          ['goviral_scripts_active', 'scripts active'],
        ]),
      }
    : null;

  const clickup: IntegrationView | null = clickupRaw
    ? {
        name: 'ClickUp',
        configured: asBoolean(clickupRaw.configured),
        state:
          asString(clickupRaw.stage) ??
          deriveIntegrationState(asBoolean(clickupRaw.configured), null, null),
        reachable: asBoolean(clickupRaw.connectivity_tested),
        lastActivityAt: null,
        lastCheckedAt: asString(clickupRaw.last_connectivity_test_at),
        lastErrorSummary: null,
        details: collectDetails(clickupRaw, [
          ['stage', 'stage'],
          ['writes_enabled', 'writes enabled'],
          ['connectivity_tested', 'connectivity tested'],
          ['governance_tier_count', 'governance tiers'],
        ]),
      }
    : null;

  const qdrant: IntegrationView | null = qdrantRaw
    ? {
        name: 'Qdrant',
        configured: asBoolean(qdrantRaw.configured),
        state: deriveIntegrationState(
          asBoolean(qdrantRaw.configured),
          asBoolean(qdrantRaw.reachable),
          asBoolean(qdrantRaw.healthy)
        ),
        reachable: asBoolean(qdrantRaw.reachable),
        lastActivityAt: null,
        lastCheckedAt: asString(qdrantRaw.last_checked_at),
        lastErrorSummary: null,
        details: collectDetails(qdrantRaw, [
          ['status', 'status'],
          ['healthy', 'healthy'],
          ['reachable', 'reachable'],
          ['collections_count', 'collections'],
        ]),
      }
    : null;

  return {
    availability:
      absent.length === 0 ? READY : partial(`Not reported by the server: ${absent.join(', ')}`),
    generatedAt: asString(root.generated_at),
    telegram,
    clickup,
    qdrant,
  };
}

// ─── Agent reconciliation ───────────────────────────────────────────────────

export interface DriftItemView {
  agent: string;
  classification: string | null;
  evidence: string | null;
  recommendation: string | null;
  safeAction: string | null;
}

export interface DriftProposalView {
  agent: string;
  action: string | null;
  justification: string | null;
  requiresApproval: boolean | null;
}

export interface ReconciliationView {
  availability: Availability;
  generatedAt: string | null;
  registered: string[];
  defined: string[];
  driftCount: number | null;
  resolvedCount: number | null;
  drift: DriftItemView[];
  proposals: DriftProposalView[];
}

function stringList(value: unknown): string[] {
  return asArray(value)
    .map(asString)
    .filter((entry): entry is string => entry !== null);
}

/**
 * `/api/goviral/agents/reconciliation`. Emits `drift` / `reconciliation_proposal`
 * / `drift_count` — not the `drift_items` / `proposals` / `summary.total_drift`
 * the console previously read.
 */
export function normalizeReconciliation(raw: unknown): ReconciliationView {
  const root = asRecord(raw);

  if (!root) {
    return {
      availability: unavailable('Reconciliation response was not a JSON object'),
      generatedAt: null,
      registered: [],
      defined: [],
      driftCount: null,
      resolvedCount: null,
      drift: [],
      proposals: [],
    };
  }

  return {
    availability: Array.isArray(root.drift)
      ? READY
      : partial('Drift analysis was not reported by the server'),
    generatedAt: asString(root.generated_at),
    registered: stringList(root.registered),
    defined: stringList(root.defined),
    driftCount: asNumber(root.drift_count),
    resolvedCount: asNumber(root.resolved_count),
    drift: asArray(root.drift)
      .map((entry): DriftItemView | null => {
        const item = asRecord(entry);
        const agent = asString(item?.agent);
        if (agent === null) return null;

        return {
          agent,
          classification: asString(item?.classification),
          evidence: asString(item?.evidence),
          recommendation: asString(item?.recommendation),
          safeAction: asString(item?.safe_action),
        };
      })
      .filter((item): item is DriftItemView => item !== null),
    proposals: asArray(root.reconciliation_proposal)
      .map((entry): DriftProposalView | null => {
        const proposal = asRecord(entry);
        const agent = asString(proposal?.agent);
        if (agent === null) return null;

        return {
          agent,
          action: asString(proposal?.action),
          justification: asString(proposal?.justification),
          requiresApproval: asBoolean(proposal?.requires_approval),
        };
      })
      .filter((proposal): proposal is DriftProposalView => proposal !== null),
  };
}

// ─── Canary ─────────────────────────────────────────────────────────────────

export interface CanaryView {
  availability: Availability;
  generatedAt: string | null;
  id: string | null;
  /** `null` when the server reported no recognizable status — never 'unknown'. */
  status: string | null;
  startedAt: string | null;
  completedAt: string | null;
  error: string | null;
  isRunning: boolean;
}

/**
 * `/api/goviral/canary/status`. The payload nests everything under `canary`; the
 * console previously read the fields flat, so `status` was `undefined` and the
 * status pill threw on `.toLowerCase()`.
 */
export function normalizeCanary(raw: unknown): CanaryView {
  const root = asRecord(raw);
  const canary = asRecord(root?.canary);

  if (!root || !canary) {
    return {
      availability: unavailable('Canary status was not reported by the server'),
      generatedAt: asString(root?.generated_at),
      id: null,
      status: null,
      startedAt: null,
      completedAt: null,
      error: null,
      isRunning: false,
    };
  }

  const status = asString(canary.status);

  return {
    availability: READY,
    generatedAt: asString(root.generated_at),
    id: asString(canary.id),
    status,
    startedAt: asString(canary.started_at),
    completedAt: asString(canary.completed_at),
    error: asString(canary.error),
    isRunning: status === 'running',
  };
}

// ─── Access mode ────────────────────────────────────────────────────────────

export interface AccessView {
  availability: Availability;
  generatedAt: string | null;
  accessMode: string | null;
  bindAddress: string | null;
  port: number | null;
  authEnabled: boolean | null;
  publicExposure: boolean | null;
  rbacActive: boolean | null;
  rbacRole: string | null;
  rbacEnforcement: string | null;
  designDocument: string | null;
}

/** `/api/goviral/access`. */
export function normalizeAccess(raw: unknown): AccessView {
  const root = asRecord(raw);

  if (!root) {
    return {
      availability: unavailable('Access mode response was not a JSON object'),
      generatedAt: null,
      accessMode: null,
      bindAddress: null,
      port: null,
      authEnabled: null,
      publicExposure: null,
      rbacActive: null,
      rbacRole: null,
      rbacEnforcement: null,
      designDocument: null,
    };
  }

  const rbac = asRecord(root.rbac);

  return {
    availability:
      asString(root.access_mode) === null
        ? partial('Access mode was not reported by the server')
        : READY,
    generatedAt: asString(root.generated_at),
    accessMode: asString(root.access_mode),
    bindAddress: asString(root.bind_address),
    port: asNumber(root.port),
    authEnabled: asBoolean(root.auth_enabled),
    publicExposure: asBoolean(root.public_exposure),
    rbacActive: asBoolean(rbac?.active),
    rbacRole: asString(rbac?.current_role),
    rbacEnforcement: asString(rbac?.enforcement),
    designDocument: asString(root.design_document),
  };
}

// ─── Runtime (systemd) ──────────────────────────────────────────────────────

export interface RuntimeUnitView {
  name: string;
  description: string | null;
  activeState: string | null;
  subState: string | null;
  unitFileState: string | null;
  nextTrigger: string | null;
}

export interface RuntimeView {
  availability: Availability;
  generatedAt: string | null;
  services: RuntimeUnitView[];
  timers: RuntimeUnitView[];
  /** Counts stay `null` when the probe failed, so "cannot read" never reads as 0. */
  servicesTotal: number | null;
  servicesActive: number | null;
  timersTotal: number | null;
  timersActive: number | null;
  failedUnits: number | null;
}

function normalizeUnits(raw: unknown): RuntimeUnitView[] {
  return asArray(raw)
    .map((entry): RuntimeUnitView | null => {
      const unit = asRecord(entry);
      const name = asString(unit?.name);
      if (name === null) return null;

      return {
        name,
        description: asString(unit?.description),
        activeState: asString(unit?.active_state),
        subState: asString(unit?.sub_state),
        unitFileState: asString(unit?.unit_file_state),
        nextTrigger: asString(unit?.next_trigger),
      };
    })
    .filter((unit): unit is RuntimeUnitView => unit !== null);
}

/**
 * `/api/goviral/runtime` — the one endpoint with a real availability contract
 * (`available` + `error`). When it reports `available: false` the returned units
 * are genuinely incomplete, so the counts for the half that failed are reported
 * as `null` rather than as a measured zero, and the server's own `error` string
 * is preserved as the reason.
 */
export function normalizeRuntime(raw: unknown): RuntimeView {
  const root = asRecord(raw);

  if (!root) {
    return {
      availability: unavailable('Runtime response was not a JSON object'),
      generatedAt: null,
      services: [],
      timers: [],
      servicesTotal: null,
      servicesActive: null,
      timersTotal: null,
      timersActive: null,
      failedUnits: null,
    };
  }

  const summary = asRecord(root.summary);
  const available = asBoolean(root.available);
  const error = asString(root.error);

  const services = normalizeUnits(root.services);
  const timers = normalizeUnits(root.timers);

  // `available: false` is a single flag over two independent probes (services and
  // timers), so one half can still be fully populated. Report what is genuinely
  // present as partial rather than discarding it or claiming it is complete.
  let availability: Availability;
  if (available === false) {
    const reason = error ?? 'systemd reported the unit data as unavailable';
    availability = services.length > 0 || timers.length > 0 ? partial(reason) : unavailable(reason);
  } else if (available === null) {
    availability = partial('Server did not report runtime availability');
  } else {
    availability = READY;
  }

  const degraded = available === false;
  const servicesMissing = degraded && services.length === 0;
  const timersMissing = degraded && timers.length === 0;

  return {
    availability,
    generatedAt: asString(root.generated_at),
    services,
    timers,
    servicesTotal: servicesMissing ? null : asNumber(summary?.services_total),
    servicesActive: servicesMissing ? null : asNumber(summary?.services_active),
    timersTotal: timersMissing ? null : asNumber(summary?.timers_total),
    timersActive: timersMissing ? null : asNumber(summary?.timers_active),
    failedUnits: degraded ? null : asNumber(summary?.failed_units),
  };
}

// ─── Presentation helpers ───────────────────────────────────────────────────

/** The single place absence becomes a glyph, so no call site invents a `0`. */
export const ABSENT = '—';

export function renderCount(value: number | null): string {
  return value === null ? ABSENT : String(value);
}

export function renderText(value: string | null): string {
  return value ?? ABSENT;
}

/** Renders `a/b` only when both are known; any unknown half yields `—`. */
export function renderRatio(numerator: number | null, denominator: number | null): string {
  return numerator === null || denominator === null
    ? ABSENT
    : `${String(numerator)}/${String(denominator)}`;
}
