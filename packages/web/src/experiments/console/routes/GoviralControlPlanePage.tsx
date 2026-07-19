import { GoviralCommandCenter } from '../components/GoviralCommandCenter';
import { GoviralControlPlaneV2 } from '../components/GoviralControlPlaneV2';
import { GoviralOperationsPanels } from '../components/GoviralOperationsPanels';
import {
  fetchGoviralOverview,
  fetchApprovalAnalysis,
  fetchSemanticServices,
  fetchModules,
  fetchIntegrations,
  fetchAgentReconciliation,
  fetchCanaryStatus,
  fetchAccessMode,
  fetchRuntime,
  launchCanary,
  cancelCanary,
  sendTelegramTest,
} from '../skills/goviral';
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
  SEMANTIC_STATES,
  type Availability,
  type SectionState,
  type OverviewView,
  type ApprovalAnalysisView,
  type SemanticServicesView,
  type SemanticServiceView,
  type SemanticStateKey,
  type ModulesView,
  type ModuleView,
  type IntegrationsView,
  type IntegrationView,
  type ReconciliationView,
  type CanaryView,
  type AccessView,
  type RuntimeView,
  type SnapshotFreshnessView,
} from '../skills/goviral-normalize';
import { useCallback, useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';

type FilterKey = 'failures' | 'drift' | 'pending' | 'malformed' | 'running' | 'needsConfig';

// ─── Helpers ────────────────────────────────────────────────────────────────

function formatDate(value: string | null | undefined): string {
  if (!value) {
    return ABSENT;
  }

  const parsed = new Date(value);

  if (Number.isNaN(parsed.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(parsed);
}

function formatAge(seconds: number | null): string {
  if (seconds === null || seconds < 0) {
    return ABSENT;
  }

  if (seconds < 60) {
    return `${String(Math.round(seconds))}s ago`;
  }

  if (seconds < 3600) {
    const m = Math.floor(seconds / 60);
    const s = Math.round(seconds % 60);
    return s > 0 ? `${String(m)}m ${String(s)}s ago` : `${String(m)}m ago`;
  }

  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return m > 0 ? `${String(h)}h ${String(m)}m ago` : `${String(h)}h ago`;
}

const NEUTRAL_TONE = 'border-white/15 bg-white/5 text-white/60';

/** `status` is nullable by design — an unknown status must not be styled as a measured one. */
function statusTone(status: string | null): string {
  if (status === null) {
    return NEUTRAL_TONE;
  }

  const normalized = status.toLowerCase();

  if (
    normalized === 'pass' ||
    normalized === 'active' ||
    normalized === 'running' ||
    normalized === 'approved' ||
    normalized === 'executed' ||
    normalized === 'fresh' ||
    normalized === 'identified' ||
    normalized === 'completed' ||
    normalized === 'healthy'
  ) {
    return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300';
  }

  if (
    normalized === 'failed' ||
    normalized === 'fail' ||
    normalized === 'rejected' ||
    normalized === 'error' ||
    normalized === 'stale' ||
    normalized === 'degraded' ||
    normalized === 'orphaned'
  ) {
    return 'border-red-500/30 bg-red-500/10 text-red-300';
  }

  if (
    normalized === 'unavailable' ||
    normalized === 'unknown' ||
    normalized === 'none' ||
    normalized === 'idle' ||
    normalized === 'disabled' ||
    normalized === 'not configured' ||
    normalized === 'cancelled'
  ) {
    return NEUTRAL_TONE;
  }

  return 'border-amber-500/30 bg-amber-500/10 text-amber-200';
}

function freshnessTone(level: SnapshotFreshnessView['level']): string {
  switch (level) {
    case 'fresh':
      return 'text-emerald-400';
    case 'delayed':
      return 'text-amber-400';
    case 'stale':
      return 'text-red-400';
    case 'unavailable':
      return 'text-white/40';
    case null:
      return 'text-white/40';
  }
}

function freshnessDot(level: SnapshotFreshnessView['level']): string {
  switch (level) {
    case 'fresh':
      return 'bg-emerald-400';
    case 'delayed':
      return 'bg-amber-400';
    case 'stale':
      return 'bg-red-400';
    case 'unavailable':
      return 'bg-white/30';
    case null:
      return 'bg-white/30';
  }
}

function semanticStateTone(state: SemanticStateKey): string {
  switch (state) {
    case 'running':
      return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300';
    case 'healthy_idle':
      return 'border-emerald-500/20 bg-emerald-500/5 text-emerald-300/80';
    case 'scheduled':
      return 'border-amber-500/30 bg-amber-500/10 text-amber-200';
    case 'degraded':
      return 'border-amber-500/30 bg-amber-500/10 text-amber-200';
    case 'failed':
      return 'border-red-500/30 bg-red-500/10 text-red-300';
    case 'disabled':
      return NEUTRAL_TONE;
    case 'unknown':
      return NEUTRAL_TONE;
  }
}

function labelState(state: string): string {
  return state.replace(/_/g, ' ');
}

// ─── Shared UI components ───────────────────────────────────────────────────

function StatusPill({ status }: { status: string | null }): ReactElement {
  return (
    <span
      className={`inline-flex rounded-full border px-2 py-0.5 text-xs font-medium ${statusTone(status)}`}
    >
      {status === null ? ABSENT : labelState(status)}
    </span>
  );
}

function Panel({
  title,
  subtitle,
  badge,
  children,
}: {
  title: string;
  subtitle?: string;
  badge?: ReactNode;
  children: ReactNode;
}): ReactElement {
  return (
    <section className="rounded-xl border border-white/10 bg-white/[0.025]">
      <div className="border-b border-white/10 px-5 py-4">
        <div className="flex items-center gap-2">
          <h2 className="text-base font-semibold text-white">{title}</h2>
          {badge}
        </div>
        {subtitle ? <p className="mt-1 text-xs text-white/50">{subtitle}</p> : null}
      </div>
      <div className="p-5">{children}</div>
    </section>
  );
}

/**
 * Renders the real reason a section is degraded. `ready` renders nothing — the
 * absence of a banner is itself the signal that the data is complete.
 */
function AvailabilityNote({ availability }: { availability: Availability }): ReactElement | null {
  if (availability.kind === 'ready') {
    return null;
  }

  const isUnavailable = availability.kind === 'unavailable';

  return (
    <div
      className={`mb-3 rounded-lg border px-3 py-2 text-xs ${
        isUnavailable
          ? 'border-red-500/30 bg-red-500/10 text-red-200'
          : 'border-amber-500/30 bg-amber-500/10 text-amber-200'
      }`}
    >
      <span className="font-medium">
        {isUnavailable ? 'Data unavailable' : 'Partial data'}
        {': '}
      </span>
      {availability.reason}
    </div>
  );
}

/**
 * Wraps a section so loading, request error, and a degraded-but-returned payload
 * are three visibly different things rather than all collapsing to empty state.
 */
function Section<T extends { availability: Availability }>({
  title,
  subtitle,
  badge,
  state,
  children,
}: {
  title: string;
  subtitle?: string;
  badge?: ReactNode;
  state: SectionState<T>;
  children: (value: T) => ReactNode;
}): ReactElement {
  if (state.status === 'loading') {
    return (
      <Panel title={title} subtitle={subtitle}>
        <div className="rounded-lg border border-dashed border-white/10 px-4 py-6 text-center text-sm text-white/40">
          Loading…
        </div>
      </Panel>
    );
  }

  if (state.status === 'error') {
    return (
      <Panel title={title} subtitle={subtitle}>
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-4 text-sm text-red-200">
          <p className="font-medium">Could not load this section.</p>
          <p className="mt-1 text-xs text-red-200/80">{state.message}</p>
        </div>
      </Panel>
    );
  }

  return (
    <Panel title={title} subtitle={subtitle} badge={badge}>
      <AvailabilityNote availability={state.value.availability} />
      {children(state.value)}
    </Panel>
  );
}

function Metric({
  label,
  value,
  detail,
  subtitle,
}: {
  label: string;
  value: string;
  detail?: string;
  subtitle?: string;
}): ReactElement {
  const isAbsent = value === ABSENT;

  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.025] p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-white/45">{label}</p>
      <p className={`mt-2 text-2xl font-semibold ${isAbsent ? 'text-white/30' : 'text-white'}`}>
        {value}
      </p>
      {detail ? <p className="mt-1 truncate text-xs text-white/45">{detail}</p> : null}
      {subtitle ? <p className="mt-0.5 truncate text-xs text-white/35">{subtitle}</p> : null}
    </div>
  );
}

function EmptyState({ text }: { text: string }): ReactElement {
  return (
    <div className="rounded-lg border border-dashed border-white/10 px-4 py-6 text-center text-sm text-white/40">
      {text}
    </div>
  );
}

// ─── Expandable Row ─────────────────────────────────────────────────────────

function ExpandableRow({
  children,
  details,
}: {
  children: ReactNode;
  details: Record<string, string | number | boolean | null | undefined>;
}): ReactElement {
  const [expanded, setExpanded] = useState(false);

  const filteredDetails = Object.entries(details).filter(
    ([, v]) => v !== null && v !== undefined && v !== ''
  );

  return (
    <div
      className="cursor-pointer rounded-lg border border-white/10 bg-black/10"
      onClick={(): void => {
        setExpanded(prev => !prev);
      }}
      role="button"
      tabIndex={0}
      onKeyDown={(e): void => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          setExpanded(prev => !prev);
        }
      }}
    >
      <div className="px-3 py-3">{children}</div>
      {expanded && filteredDetails.length > 0 ? (
        <div className="border-t border-white/5 px-3 py-2">
          <div className="grid gap-1">
            {filteredDetails.map(([key, val]) => (
              <div key={key} className="flex justify-between gap-4 text-xs">
                <span className="text-white/30">{key}</span>
                <span className="truncate text-white/50">{String(val)}</span>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

// ─── Confirmation Dialog ────────────────────────────────────────────────────

function ConfirmDialog({
  title,
  description,
  onConfirm,
  onCancel,
  busy,
}: {
  title: string;
  description: string;
  onConfirm: () => void;
  onCancel: () => void;
  busy: boolean;
}): ReactElement {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4">
      <div className="w-full max-w-md rounded-xl border border-white/15 bg-[#101114] p-5 shadow-2xl">
        <h3 className="text-lg font-semibold text-white">Confirm {title}</h3>
        <p className="mt-2 text-sm text-white/50">{description}</p>
        <p className="mt-3 rounded-lg border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-xs text-amber-200">
          This is a governed write action.
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={onCancel}
            className="rounded-md border border-white/10 px-3 py-2 text-sm text-white/60"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={onConfirm}
            className="rounded-md border border-fuchsia-500/30 bg-fuchsia-500/15 px-3 py-2 text-sm font-medium text-fuchsia-200 disabled:opacity-35"
          >
            {busy ? 'Running…' : 'Confirm'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Filter Bar ─────────────────────────────────────────────────────────────

const FILTER_LABELS: Record<FilterKey, string> = {
  failures: 'Failures',
  drift: 'Drift',
  pending: 'Pending',
  malformed: 'Malformed',
  running: 'Running',
  needsConfig: 'Needs Config',
};

function FilterBar({
  active,
  onToggle,
  counts,
}: {
  active: Set<FilterKey>;
  onToggle: (key: FilterKey) => void;
  /** A `null` count is unknown, and renders no badge rather than a zero. */
  counts: Record<FilterKey, number | null>;
}): ReactElement {
  return (
    <div className="flex flex-wrap gap-2">
      {(Object.keys(FILTER_LABELS) as FilterKey[]).map(key => {
        const isActive = active.has(key);
        const count = counts[key];
        return (
          <button
            key={key}
            type="button"
            onClick={(): void => {
              onToggle(key);
            }}
            className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
              isActive
                ? 'border-fuchsia-500/40 bg-fuchsia-500/15 text-fuchsia-200'
                : 'border-white/10 bg-white/5 text-white/50 hover:bg-white/10'
            }`}
          >
            {FILTER_LABELS[key]}
            {count !== null && count > 0 ? (
              <span className="ml-1.5 rounded-full bg-white/10 px-1.5 py-0.5 text-[10px]">
                {count}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

// ─── Integration Status ─────────────────────────────────────────────────────

function IntegrationCard({
  integration,
  action,
}: {
  integration: IntegrationView;
  action?: ReactNode;
}): ReactElement {
  return (
    <ExpandableRow details={Object.fromEntries(integration.details.map(d => [d.label, d.value]))}>
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-medium text-white/85">{integration.name}</p>
        <StatusPill status={integration.state} />
      </div>
      <p className="mt-1 text-xs text-white/40">
        {integration.configured === null
          ? 'Configuration state not reported'
          : integration.configured
            ? 'Configured'
            : 'Not configured'}
      </p>
      {integration.lastActivityAt ? (
        <p className="mt-0.5 text-xs text-white/30">
          Last activity: {formatDate(integration.lastActivityAt)}
        </p>
      ) : null}
      {integration.lastCheckedAt ? (
        <p className="mt-0.5 text-xs text-white/30">
          Last checked: {formatDate(integration.lastCheckedAt)}
        </p>
      ) : null}
      {integration.lastErrorSummary ? (
        <p className="mt-0.5 text-xs text-red-300/70">{integration.lastErrorSummary}</p>
      ) : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </ExpandableRow>
  );
}

// ─── Registry Drift ─────────────────────────────────────────────────────────

function DriftBody({ data }: { data: ReconciliationView }): ReactElement {
  if (data.drift.length === 0) {
    return (
      <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 px-4 py-6 text-center text-sm text-emerald-300">
        No drift detected. Registry and definitions are consistent.
      </div>
    );
  }

  return (
    <>
      <div className="space-y-2">
        {data.drift.map(item => (
          <ExpandableRow
            key={`${item.agent}-${item.classification ?? 'unclassified'}`}
            details={{
              classification: item.classification,
              evidence: item.evidence,
              recommendation: item.recommendation,
              safe_action: item.safeAction,
            }}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-medium text-white/85">{item.agent}</p>
                <p className="mt-1 text-xs text-white/45">{renderText(item.recommendation)}</p>
              </div>
              <StatusPill status={item.classification} />
            </div>
          </ExpandableRow>
        ))}
      </div>

      {data.proposals.length > 0 ? (
        <div className="mt-4 border-t border-white/10 pt-4">
          <p className="mb-2 text-xs font-medium uppercase tracking-wide text-white/40">
            Reconciliation proposals
          </p>
          <div className="space-y-2">
            {data.proposals.map(p => (
              <div
                key={`${p.agent}-${p.action ?? 'noop'}`}
                className="rounded-lg border border-white/10 bg-black/10 px-3 py-2"
              >
                <p className="text-sm text-white/80">
                  <span className="font-medium">{p.agent}</span>
                  {' — '}
                  {renderText(p.action)}
                </p>
                <p className="mt-1 text-xs text-white/40">{renderText(p.justification)}</p>
                {p.requiresApproval === true ? (
                  <p className="mt-1 text-xs text-amber-300/70">Requires approval</p>
                ) : null}
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </>
  );
}

// ─── Semantic Services ──────────────────────────────────────────────────────

function SemanticServicesBody({
  data,
  highlight,
}: {
  data: SemanticServicesView;
  highlight: Set<FilterKey>;
}): ReactElement {
  const showFailedOnly = highlight.has('failures');
  const showRunningOnly = highlight.has('running');

  const order: Record<SemanticStateKey, number> = {
    failed: 0,
    degraded: 1,
    running: 2,
    scheduled: 3,
    healthy_idle: 4,
    disabled: 5,
    unknown: 6,
  };

  const sorted = [...data.services].sort((a, b) => order[a.semanticState] - order[b.semanticState]);

  const filtered = sorted.filter((svc): boolean => {
    if (showFailedOnly && svc.semanticState !== 'failed') return false;
    if (showRunningOnly && svc.semanticState !== 'running') return false;
    return true;
  });

  const groups = new Map<SemanticStateKey, SemanticServiceView[]>();
  for (const svc of filtered) {
    const existing = groups.get(svc.semanticState) ?? [];
    existing.push(svc);
    groups.set(svc.semanticState, existing);
  }

  return (
    <>
      <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Metric label="Total" value={renderCount(data.total)} />
        <Metric label="Healthy" value={renderCount(data.healthy)} />
        <Metric label="Attention" value={renderCount(data.attention)} />
        <Metric label="Disabled" value={renderCount(data.disabled)} />
      </div>

      <div className="mb-4 flex flex-wrap gap-2">
        {SEMANTIC_STATES.map(state => (
          <span
            key={state}
            className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium ${semanticStateTone(state)}`}
          >
            {labelState(state)}
            <span className="font-semibold">{renderCount(data.aggregates[state])}</span>
          </span>
        ))}
      </div>

      <div className="space-y-4">
        {Array.from(groups.entries()).map(([state, services]) => (
          <div key={state}>
            <p className="mb-2 text-xs font-medium uppercase tracking-wide text-white/40">
              {labelState(state)} ({services.length})
            </p>
            <div className="space-y-2">
              {services.map(svc => (
                <ExpandableRow
                  key={svc.name}
                  details={{
                    unit_type: svc.unitType,
                    health: svc.health,
                    active_now: svc.activeNow,
                    enabled: svc.enabled,
                    scheduled: svc.scheduled,
                    next_run_at: svc.nextRunAt,
                    last_run_at: svc.lastRunAt,
                    last_result: svc.lastResult,
                  }}
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate font-mono text-xs text-white/85">{svc.name}</p>
                      <p className="mt-1 truncate text-xs text-white/40">
                        {renderText(svc.description)}
                      </p>
                      {svc.nextRunAt ? (
                        <p className="mt-0.5 text-xs text-white/30">
                          Next run: {formatDate(svc.nextRunAt)}
                        </p>
                      ) : null}
                    </div>
                    <span
                      className={`inline-flex flex-shrink-0 rounded-full border px-2 py-0.5 text-xs font-medium ${semanticStateTone(svc.semanticState)}`}
                    >
                      {labelState(svc.semanticState)}
                    </span>
                  </div>
                </ExpandableRow>
              ))}
            </div>
          </div>
        ))}
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          text={
            data.services.length === 0
              ? 'No services were reported.'
              : 'No services match the current filter.'
          }
        />
      ) : null}
    </>
  );
}

// ─── Runtime (systemd availability truth) ───────────────────────────────────

function RuntimeBody({ data }: { data: RuntimeView }): ReactElement {
  return (
    <>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
        <Metric label="Services" value={renderCount(data.servicesTotal)} />
        <Metric label="Services active" value={renderCount(data.servicesActive)} />
        <Metric label="Timers" value={renderCount(data.timersTotal)} />
        <Metric label="Timers active" value={renderCount(data.timersActive)} />
        <Metric label="Failed units" value={renderCount(data.failedUnits)} />
      </div>

      {data.timers.length > 0 ? (
        <div className="mt-4">
          <p className="mb-2 text-xs font-medium uppercase tracking-wide text-white/40">
            Timers ({data.timers.length})
          </p>
          <div className="grid gap-2 sm:grid-cols-2">
            {data.timers.slice(0, 20).map(unit => (
              <ExpandableRow
                key={unit.name}
                details={{
                  active_state: unit.activeState,
                  sub_state: unit.subState,
                  unit_file_state: unit.unitFileState,
                  next_trigger: unit.nextTrigger,
                }}
              >
                <div className="flex items-center justify-between gap-2">
                  <p className="truncate font-mono text-xs text-white/80">{unit.name}</p>
                  <StatusPill status={unit.activeState} />
                </div>
              </ExpandableRow>
            ))}
          </div>
        </div>
      ) : null}
    </>
  );
}

// ─── Main Page Component ────────────────────────────────────────────────────

export function GoviralControlPlanePage(): ReactElement {
  const [overview, setOverview] = useState<SectionState<OverviewView>>({ status: 'loading' });
  const [approvals, setApprovals] = useState<SectionState<ApprovalAnalysisView>>({
    status: 'loading',
  });
  const [services, setServices] = useState<SectionState<SemanticServicesView>>({
    status: 'loading',
  });
  const [modules, setModules] = useState<SectionState<ModulesView>>({ status: 'loading' });
  const [integrations, setIntegrations] = useState<SectionState<IntegrationsView>>({
    status: 'loading',
  });
  const [reconciliation, setReconciliation] = useState<SectionState<ReconciliationView>>({
    status: 'loading',
  });
  const [canary, setCanary] = useState<SectionState<CanaryView>>({ status: 'loading' });
  const [access, setAccess] = useState<SectionState<AccessView>>({ status: 'loading' });
  const [runtime, setRuntime] = useState<SectionState<RuntimeView>>({ status: 'loading' });

  const [activeFilters, setActiveFilters] = useState<Set<FilterKey>>(new Set());
  const [confirmAction, setConfirmAction] = useState<{
    title: string;
    description: string;
    action: () => Promise<void>;
  } | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const canaryTimerRef = useRef<number | null>(null);

  const load = useCallback(async (): Promise<void> => {
    const [
      overviewResult,
      approvalResult,
      servicesResult,
      modulesResult,
      integrationsResult,
      reconciliationResult,
      canaryResult,
      accessResult,
      runtimeResult,
    ] = await Promise.allSettled([
      fetchGoviralOverview(),
      fetchApprovalAnalysis(),
      fetchSemanticServices(),
      fetchModules(),
      fetchIntegrations(),
      fetchAgentReconciliation(),
      fetchCanaryStatus(),
      fetchAccessMode(),
      fetchRuntime(),
    ]);

    setOverview(toSectionState(overviewResult, normalizeOverview));
    setApprovals(toSectionState(approvalResult, normalizeApprovalAnalysis));
    setServices(toSectionState(servicesResult, normalizeSemanticServices));
    setModules(toSectionState(modulesResult, normalizeModules));
    setIntegrations(toSectionState(integrationsResult, normalizeIntegrations));
    setReconciliation(toSectionState(reconciliationResult, normalizeReconciliation));
    setCanary(toSectionState(canaryResult, normalizeCanary));
    setAccess(toSectionState(accessResult, normalizeAccess));
    setRuntime(toSectionState(runtimeResult, normalizeRuntime));
  }, []);

  // Main 30-second refresh
  useEffect((): (() => void) => {
    void load();

    const timer = window.setInterval((): void => {
      void load();
    }, 30_000);

    return (): void => {
      window.clearInterval(timer);
    };
  }, [load]);

  const canaryRunning = canary.status === 'loaded' && canary.value.isRunning;

  // Canary 5-second refresh while a canary is actually running
  useEffect((): (() => void) => {
    if (canaryRunning) {
      canaryTimerRef.current = window.setInterval((): void => {
        void fetchCanaryStatus()
          .then((raw): void => {
            setCanary({ status: 'loaded', value: normalizeCanary(raw) });
          })
          .catch((): void => {
            // The 30s full refresh reports any persistent failure; a single
            // missed fast poll must not clear the panel.
          });
      }, 5_000);
    } else if (canaryTimerRef.current) {
      window.clearInterval(canaryTimerRef.current);
      canaryTimerRef.current = null;
    }

    return (): void => {
      if (canaryTimerRef.current) {
        window.clearInterval(canaryTimerRef.current);
        canaryTimerRef.current = null;
      }
    };
  }, [canaryRunning]);

  const toggleFilter = useCallback((key: FilterKey): void => {
    setActiveFilters(prev => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }, []);

  const handleConfirmAction = useCallback(async (): Promise<void> => {
    if (!confirmAction) return;
    setActionBusy(true);
    setActionError(null);
    try {
      await confirmAction.action();
      await load();
    } catch (e) {
      const err = e as Error;
      setActionError(err.message || 'The action failed with no detail.');
    } finally {
      setActionBusy(false);
      setConfirmAction(null);
    }
  }, [confirmAction, load]);

  // ─── Derived, null-preserving ─────────────────────────────────────────────

  const overviewValue = overview.status === 'loaded' ? overview.value : null;
  const approvalsValue = approvals.status === 'loaded' ? approvals.value : null;
  const servicesValue = services.status === 'loaded' ? services.value : null;
  const integrationsValue = integrations.status === 'loaded' ? integrations.value : null;
  const reconciliationValue = reconciliation.status === 'loaded' ? reconciliation.value : null;
  const canaryValue = canary.status === 'loaded' ? canary.value : null;

  const freshness = overviewValue?.freshness ?? null;

  // Prefer the analysis endpoint's live pending count; fall back to the overview's
  // snapshot only when the analysis genuinely reported one. Neither present stays null.
  const pendingApprovals = approvalsValue?.totalPending ?? overviewValue?.approvals.pending ?? null;

  const generatedAt = overviewValue?.generatedAt ?? approvalsValue?.generatedAt ?? null;

  const failuresCount =
    servicesValue === null
      ? null
      : (servicesValue.aggregates.failed ?? 0) + (servicesValue.aggregates.degraded ?? 0);

  const needsConfigCount =
    integrationsValue === null
      ? null
      : [
          integrationsValue.telegram?.configured,
          integrationsValue.clickup?.configured,
          integrationsValue.qdrant?.configured,
        ].filter(configured => configured === false).length;

  const filterCounts: Record<FilterKey, number | null> = {
    failures: failuresCount,
    drift: reconciliationValue?.driftCount ?? null,
    pending: pendingApprovals,
    malformed: approvalsValue?.malformedCount ?? null,
    running: canaryValue === null ? null : canaryValue.isRunning ? 1 : 0,
    needsConfig: needsConfigCount,
  };

  const anyError = [
    overview,
    approvals,
    services,
    modules,
    integrations,
    reconciliation,
    canary,
    access,
    runtime,
  ].filter(state => state.status === 'error').length;

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-[1600px] flex-col gap-5 p-5 lg:p-7">
        {/* ── Header ─────────────────────────────────────────────────── */}
        <header className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-2xl font-semibold text-white">GoViral Control Plane</h1>
              <span className="rounded-full border border-fuchsia-500/30 bg-fuchsia-500/10 px-2 py-0.5 text-xs font-medium text-fuchsia-200">
                v3.1
              </span>
            </div>
            <p className="mt-2 max-w-3xl text-sm text-white/50">
              Governed operational view with Brain snapshot integration, agent registry, drift
              detection, notifications, search, analytics, and disaster recovery.
            </p>
          </div>

          <div className="text-left text-xs text-white/40 lg:text-right">
            <p>Auto-refresh: 30 seconds</p>
            <div className="flex items-center gap-2 lg:justify-end">
              <p>Updated: {formatDate(generatedAt)}</p>
              {freshness ? (
                <span className="flex items-center gap-1.5">
                  <span
                    className={`inline-block h-2 w-2 rounded-full ${freshnessDot(freshness.level)}`}
                  />
                  <span className={`text-xs ${freshnessTone(freshness.level)}`}>
                    {freshness.ageSeconds !== null
                      ? formatAge(freshness.ageSeconds)
                      : renderText(freshness.level)}
                  </span>
                </span>
              ) : null}
            </div>
            {freshness?.sourceUpdatedAt ? (
              <p className="mt-0.5 text-white/30">
                Source updated: {formatDate(freshness.sourceUpdatedAt)}
              </p>
            ) : null}
            {freshness?.producer ? (
              <p className="mt-0.5 text-white/30">
                Producer: {freshness.producer}
                {freshness.producerStatus ? ` (${freshness.producerStatus})` : ''}
              </p>
            ) : null}
          </div>
        </header>

        {/* ── Snapshot staleness ─────────────────────────────────────── */}
        {freshness && (freshness.level === 'stale' || freshness.level === 'unavailable') ? (
          <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200">
            Brain snapshot is {freshness.level}
            {freshness.lastErrorSummary ? ` — ${freshness.lastErrorSummary}` : ''}.
            {freshness.producerStatus ? ` Producer: ${freshness.producerStatus}.` : ''} Data shown
            may be outdated.
          </div>
        ) : null}

        {anyError > 0 ? (
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
            {anyError} section(s) failed to load. Each affected panel shows its own error below.
          </div>
        ) : null}

        {actionError ? (
          <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200">
            Action failed: {actionError}
          </div>
        ) : null}

        {/* ── Filter Bar ─────────────────────────────────────────────── */}
        <FilterBar active={activeFilters} onToggle={toggleFilter} counts={filterCounts} />

        {/* ── Metrics Row ────────────────────────────────────────────── */}
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <Metric
            label="Brain Doctor"
            value={
              overview.status === 'loaded'
                ? renderText(overviewValue?.doctorStatus ?? null)
                : ABSENT
            }
            detail={
              overview.status === 'loading'
                ? 'Loading…'
                : overview.status === 'error'
                  ? 'Could not load'
                  : (overviewValue?.doctorSource ?? 'Canonical brain health')
            }
            subtitle={
              overviewValue?.doctorModifiedAt
                ? `Checked ${formatDate(overviewValue.doctorModifiedAt)}`
                : undefined
            }
          />
          <Metric
            label="Pending approvals"
            value={renderCount(pendingApprovals)}
            detail={
              approvalsValue?.queueHash
                ? `Queue ${approvalsValue.queueHash.slice(0, 8)}`
                : 'Awaiting decision'
            }
            subtitle={
              approvalsValue?.duplicateGroupCount !== null &&
              approvalsValue?.duplicateGroupCount !== undefined
                ? `${String(approvalsValue.duplicateGroupCount)} duplicate group(s)`
                : undefined
            }
          />
          <Metric
            label="Services"
            value={renderRatio(servicesValue?.healthy ?? null, servicesValue?.total ?? null)}
            detail={`${renderCount(servicesValue?.attention ?? null)} needing attention`}
            subtitle={
              servicesValue
                ? `${renderCount(servicesValue.aggregates.scheduled)} scheduled, ${renderCount(
                    servicesValue.aggregates.disabled
                  )} disabled`
                : undefined
            }
          />
          <Metric
            label="Latest PRD"
            value={renderText(overviewValue?.latestPrdTitle ?? null)}
            detail={
              overviewValue
                ? `${String(overviewValue.threads.length)} recent agent threads`
                : 'Recent agent threads'
            }
            subtitle={
              overviewValue?.latestPrdModifiedAt
                ? formatDate(overviewValue.latestPrdModifiedAt)
                : undefined
            }
          />
        </div>

        {/* ── Approval Queue + Agent Runs ─────────────────────────────── */}
        <div className="grid gap-5 xl:grid-cols-2">
          <Section
            title="Approval Queue"
            subtitle={
              approvalsValue?.generatedAt
                ? `Source refreshed ${formatDate(approvalsValue.generatedAt)}`
                : 'Governed approval queue analysis'
            }
            state={approvals}
          >
            {(data): ReactNode => (
              <>
                <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
                  <Metric label="Pending" value={renderCount(data.totalPending)} />
                  <Metric label="Malformed" value={renderCount(data.malformedCount)} />
                  <Metric label="Duplicate groups" value={renderCount(data.duplicateGroupCount)} />
                </div>

                {data.classifications.length > 0 ? (
                  <div className="mb-4 flex flex-wrap gap-2">
                    {data.classifications.map(c => (
                      <span
                        key={c.label}
                        className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium ${statusTone(c.label)}`}
                      >
                        {labelState(c.label)}
                        <span className="font-semibold">{c.count}</span>
                      </span>
                    ))}
                  </div>
                ) : null}

                {data.groups.length > 0 ? (
                  <div className="space-y-2">
                    {data.groups
                      .filter((group): boolean => {
                        if (
                          activeFilters.has('pending') &&
                          group.riskClassification === null &&
                          group.count === null
                        ) {
                          return false;
                        }
                        return true;
                      })
                      .map(group => (
                        <ExpandableRow
                          key={group.fingerprint ?? group.titlePattern ?? 'group'}
                          details={{
                            fingerprint: group.fingerprint,
                            count: group.count,
                            source: group.source,
                            risk_classification: group.riskClassification,
                            oldest_created_at: group.oldestCreatedAt,
                            newest_created_at: group.newestCreatedAt,
                          }}
                        >
                          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                            <div className="min-w-0">
                              <p className="truncate text-sm font-medium text-white/85">
                                {renderText(group.titlePattern)}
                              </p>
                              <p className="mt-1 text-xs text-white/40">
                                {renderText(group.source)}
                                {' · '}
                                {formatDate(group.newestCreatedAt)}
                              </p>
                            </div>
                            <div className="flex items-center gap-1.5">
                              <StatusPill status={group.riskClassification} />
                              <span className="rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-xs text-white/60">
                                ×{renderCount(group.count)}
                              </span>
                            </div>
                          </div>
                        </ExpandableRow>
                      ))}
                  </div>
                ) : (
                  <EmptyState
                    text={
                      data.totalPending === 0
                        ? 'The approval queue is empty.'
                        : 'No grouped approval metadata was returned.'
                    }
                  />
                )}

                {data.validationErrors.length > 0 ? (
                  <div className="mt-4 border-t border-white/10 pt-4">
                    <p className="mb-2 text-xs font-medium uppercase tracking-wide text-white/40">
                      Validation errors
                    </p>
                    <div className="space-y-2">
                      {data.validationErrors.map(err => (
                        <div
                          key={err.itemId ?? 'unknown'}
                          className="rounded-lg border border-red-500/20 bg-red-500/5 px-3 py-2 text-xs text-red-200"
                        >
                          <p className="font-medium">{renderText(err.itemId)}</p>
                          <p className="mt-1 text-red-200/70">{err.errors.join(', ')}</p>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}
              </>
            )}
          </Section>

          {/* Agent Runs + modules */}
          <Section
            title="Agent Runs"
            subtitle="Recent governed Agent Bus threads and runtime modules"
            state={overview}
          >
            {(data): ReactNode => (
              <>
                <div className="space-y-2">
                  {data.threads.map((thread, index) => (
                    <ExpandableRow
                      key={thread.id ?? `thread-${String(index)}`}
                      details={{
                        id: thread.id,
                        lane: thread.lane,
                        lead_agent: thread.leadAgent,
                        agent_type: thread.agentType,
                        created_at: thread.createdAt,
                      }}
                    >
                      <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium text-white/85">
                            {renderText(thread.id)}
                          </p>
                          <p className="mt-1 text-xs text-white/40">
                            {renderText(thread.leadAgent)}
                            {' · '}
                            {renderText(thread.lane)}
                          </p>
                        </div>
                        <StatusPill status={thread.status} />
                      </div>
                    </ExpandableRow>
                  ))}

                  {data.threads.length === 0 ? (
                    <EmptyState text="No recent Agent Bus threads." />
                  ) : null}
                </div>

                <div className="mt-5 border-t border-white/10 pt-5">
                  <p className="mb-3 text-xs font-medium uppercase tracking-wide text-white/40">
                    Runtime modules
                  </p>
                  <ModulesGrid state={modules} />
                </div>
              </>
            )}
          </Section>
        </div>

        {/* ── Semantic Services ──────────────────────────────────────── */}
        <Section
          title="Services & Timers"
          subtitle="Semantic service state groups"
          state={services}
        >
          {(data): ReactNode => <SemanticServicesBody data={data} highlight={activeFilters} />}
        </Section>

        {/* ── Runtime availability (systemd) ─────────────────────────── */}
        <Section
          title="Runtime Units"
          subtitle="Direct systemd view — reports its own availability"
          state={runtime}
        >
          {(data): ReactNode => <RuntimeBody data={data} />}
        </Section>

        {/* ── Integrations ───────────────────────────────────────────── */}
        <Section
          title="Integration Status"
          subtitle="External service connections"
          state={integrations}
        >
          {(data): ReactNode => (
            <div className="grid gap-3 sm:grid-cols-3">
              {data.telegram ? (
                <IntegrationCard
                  integration={data.telegram}
                  action={
                    <button
                      type="button"
                      onClick={(e): void => {
                        e.stopPropagation();
                        setConfirmAction({
                          title: 'Telegram Test',
                          description:
                            'This will send a test message to the configured Telegram channel to verify connectivity.',
                          action: async (): Promise<void> => {
                            const result = await sendTelegramTest();
                            if (result.ok === false) {
                              throw new Error(result.error ?? 'Telegram test failed.');
                            }
                          },
                        });
                      }}
                      disabled={data.telegram.configured !== true}
                      className="rounded-md border border-fuchsia-500/30 bg-fuchsia-500/10 px-2 py-1 text-xs font-medium text-fuchsia-200 disabled:opacity-35"
                    >
                      Test
                    </button>
                  }
                />
              ) : null}
              {data.clickup ? <IntegrationCard integration={data.clickup} /> : null}
              {data.qdrant ? <IntegrationCard integration={data.qdrant} /> : null}
            </div>
          )}
        </Section>

        {/* ── Canary + Access Mode ───────────────────────────────────── */}
        <div className="grid gap-5 xl:grid-cols-2">
          <Section
            title="Canary Task"
            state={canary}
            badge={canaryValue ? <StatusPill status={canaryValue.status} /> : undefined}
          >
            {(data): ReactNode => (
              <div className="space-y-3">
                {data.id ? (
                  <p className="font-mono text-xs text-white/35">Task: {data.id}</p>
                ) : null}

                <div className="grid gap-2 text-xs text-white/45">
                  {data.startedAt ? <p>Started: {formatDate(data.startedAt)}</p> : null}
                  {data.completedAt ? <p>Completed: {formatDate(data.completedAt)}</p> : null}
                  {data.error ? <p className="text-red-300/80">Error: {data.error}</p> : null}
                  {data.status === 'none' ? <p>No canary has been run.</p> : null}
                </div>

                <div className="flex gap-2">
                  {data.isRunning ? (
                    <button
                      type="button"
                      onClick={(): void => {
                        setConfirmAction({
                          title: 'Canary Cancel',
                          description: 'This will cancel the currently running canary task.',
                          action: async (): Promise<void> => {
                            const result = await cancelCanary();
                            if (result.ok === false) {
                              throw new Error(result.error ?? 'Canary cancel failed.');
                            }
                          },
                        });
                      }}
                      className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-1.5 text-xs font-medium text-red-200"
                    >
                      Cancel Canary
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={(): void => {
                        setConfirmAction({
                          title: 'Canary Launch',
                          description:
                            'This will launch a canary task to validate the current runtime environment.',
                          action: async (): Promise<void> => {
                            const result = await launchCanary();
                            if (result.ok === false) {
                              throw new Error(result.error ?? 'Canary launch failed.');
                            }
                          },
                        });
                      }}
                      className="rounded-md border border-fuchsia-500/30 bg-fuchsia-500/10 px-3 py-1.5 text-xs font-medium text-fuchsia-200"
                    >
                      Launch Canary
                    </button>
                  )}
                </div>
              </div>
            )}
          </Section>

          <Section
            title="Access Mode"
            state={access}
            badge={
              access.status === 'loaded' ? (
                <StatusPill status={access.value.accessMode} />
              ) : undefined
            }
          >
            {(data): ReactNode => (
              <div className="space-y-2 text-sm">
                <div className="grid gap-1 text-xs text-white/45">
                  <p>
                    Bind: {renderText(data.bindAddress)}
                    {data.port !== null ? `:${String(data.port)}` : ''}
                  </p>
                  <p>
                    Auth enabled:{' '}
                    {data.authEnabled === null ? ABSENT : data.authEnabled ? 'Yes' : 'No'}
                  </p>
                  <p>
                    Public exposure:{' '}
                    {data.publicExposure === null ? ABSENT : data.publicExposure ? 'Yes' : 'No'}
                  </p>
                  <p>RBAC role: {renderText(data.rbacRole)}</p>
                  <p>RBAC enforcement: {renderText(data.rbacEnforcement)}</p>
                </div>
                {data.designDocument ? (
                  <p className="text-xs text-white/30">{data.designDocument}</p>
                ) : null}
              </div>
            )}
          </Section>
        </div>

        {/* ── Registry Drift ─────────────────────────────────────────── */}
        <Section
          title="Registry Drift"
          subtitle="Agent reconciliation analysis"
          state={reconciliation}
          badge={
            reconciliationValue ? (
              <StatusPill
                status={
                  reconciliationValue.driftCount === null
                    ? null
                    : reconciliationValue.driftCount === 0
                      ? 'pass'
                      : `${String(reconciliationValue.driftCount)} drift`
                }
              />
            ) : undefined
          }
        >
          {(data): ReactNode => <DriftBody data={data} />}
        </Section>

        {/* ── Legacy panels ──────────────────────────────────────────── */}
        <GoviralOperationsPanels />
        <GoviralCommandCenter />
        <GoviralControlPlaneV2 />
      </div>

      {/* ── Confirmation Dialog ───────────────────────────────────────── */}
      {confirmAction ? (
        <ConfirmDialog
          title={confirmAction.title}
          description={confirmAction.description}
          onConfirm={(): void => {
            void handleConfirmAction();
          }}
          onCancel={(): void => {
            setConfirmAction(null);
          }}
          busy={actionBusy}
        />
      ) : null}
    </div>
  );
}

// ─── Modules grid (its own section state) ───────────────────────────────────

function ModulesGrid({ state }: { state: SectionState<ModulesView> }): ReactElement {
  if (state.status === 'loading') {
    return <EmptyState text="Loading modules…" />;
  }

  if (state.status === 'error') {
    return (
      <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-200">
        Could not load modules: {state.message}
      </div>
    );
  }

  const { value } = state;

  return (
    <>
      <AvailabilityNote availability={value.availability} />
      <div className="grid gap-2 sm:grid-cols-2">
        {value.modules.map(
          (module: ModuleView): ReactElement => (
            <ExpandableRow
              key={module.id}
              details={{
                id: module.id,
                state: module.state,
                health: module.health,
                owner_agent: module.ownerAgent,
                workflow: module.workflow,
                run_id: module.runId,
                run_at: module.runAt,
                enabled: module.enabled,
              }}
            >
              <div className="flex items-center justify-between gap-2">
                <p className="truncate text-sm font-medium text-white/85">
                  {renderText(module.label ?? module.id)}
                </p>
                <StatusPill status={module.state} />
              </div>
              {module.ownerAgent ? (
                <p className="mt-1 text-xs text-white/45">Owner: {module.ownerAgent}</p>
              ) : null}
              <p className="mt-1 truncate text-xs text-white/40">
                {module.runId === null ? 'No run evidence' : module.runId}
              </p>
              {module.runAt ? (
                <p className="mt-0.5 truncate text-xs text-white/30">{formatDate(module.runAt)}</p>
              ) : null}
            </ExpandableRow>
          )
        )}

        {value.modules.length === 0 ? <EmptyState text="No runtime modules discovered." /> : null}
      </div>
    </>
  );
}
