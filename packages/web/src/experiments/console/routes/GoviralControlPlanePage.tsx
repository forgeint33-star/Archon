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
  launchCanary,
  cancelCanary,
  sendTelegramTest,
  type GoviralOverview,
  type GoviralThread,
  type SnapshotFreshness,
  type ApprovalAnalysisResponse,
  type ApprovalAnalysisItem,
  type SemanticServicesResponse,
  type SemanticService,
  type SemanticState,
  type ModulesResponse,
  type ModuleManifest,
  type ModuleState,
  type IntegrationsResponse,
  type AgentReconciliationResponse,
  type ReconciliationDriftItem,
  type CanaryStatusResponse,
  type AccessModeResponse,
} from '../skills/goviral';
import { useCallback, useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';

type FilterKey = 'failures' | 'drift' | 'pending' | 'malformed' | 'running' | 'needsConfig';

// ─── Helpers ────────────────────────────────────────────────────────────────

function formatDate(value: string | null | undefined): string {
  if (!value) {
    return '\u2014';
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

function formatAge(seconds: number | null | undefined): string {
  if (seconds == null || seconds < 0) {
    return 'unknown';
  }

  if (seconds < 60) {
    return `${Math.round(seconds)}s ago`;
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

function statusTone(status: string): string {
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
    normalized === 'rejected' ||
    normalized === 'error' ||
    normalized === 'stale' ||
    normalized === 'risk_engine_failed' ||
    normalized === 'orphaned'
  ) {
    return 'border-red-500/30 bg-red-500/10 text-red-300';
  }

  if (
    normalized === 'unavailable' ||
    normalized === 'unknown' ||
    normalized === 'idle' ||
    normalized === 'cancelled'
  ) {
    return 'border-white/15 bg-white/5 text-white/60';
  }

  return 'border-amber-500/30 bg-amber-500/10 text-amber-200';
}

function freshnessTone(freshness: SnapshotFreshness): string {
  switch (freshness) {
    case 'fresh':
      return 'text-emerald-400';
    case 'delayed':
      return 'text-amber-400';
    case 'stale':
      return 'text-red-400';
    case 'unavailable':
      return 'text-white/40';
  }
}

function freshnessDot(freshness: SnapshotFreshness): string {
  switch (freshness) {
    case 'fresh':
      return 'bg-emerald-400';
    case 'delayed':
      return 'bg-amber-400';
    case 'stale':
      return 'bg-red-400';
    case 'unavailable':
      return 'bg-white/30';
  }
}

function moduleStateTone(state: ModuleState): string {
  switch (state) {
    case 'identified':
      return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300';
    case 'partially_identified':
      return 'border-amber-500/30 bg-amber-500/10 text-amber-200';
    case 'orphaned':
      return 'border-red-500/30 bg-red-500/10 text-red-300';
    case 'unavailable':
      return 'border-white/15 bg-white/5 text-white/60';
  }
}

function semanticStateTone(state: SemanticState): string {
  switch (state) {
    case 'running':
      return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300';
    case 'idle':
      return 'border-white/15 bg-white/5 text-white/60';
    case 'scheduled':
      return 'border-amber-500/30 bg-amber-500/10 text-amber-200';
    case 'failed':
      return 'border-red-500/30 bg-red-500/10 text-red-300';
    case 'unknown':
      return 'border-white/15 bg-white/5 text-white/60';
  }
}

// ─── Shared UI components ───────────────────────────────────────────────────

function StatusPill({ status }: { status: string }): ReactElement {
  return (
    <span
      className={`inline-flex rounded-full border px-2 py-0.5 text-xs font-medium ${statusTone(status)}`}
    >
      {status || 'unknown'}
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

function Metric({
  label,
  value,
  detail,
  subtitle,
}: {
  label: string;
  value: string | number;
  detail: string;
  subtitle?: string;
}): ReactElement {
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.025] p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-white/45">{label}</p>
      <p className="mt-2 text-2xl font-semibold text-white">{value}</p>
      <p className="mt-1 truncate text-xs text-white/45">{detail}</p>
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
            {busy ? 'Running\u2026' : 'Confirm'}
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
  counts: Record<FilterKey, number>;
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
            {count > 0 ? (
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

// ─── Integration Status Panel ───────────────────────────────────────────────

function IntegrationStatusPanel({
  data,
  onTelegramTest,
}: {
  data: IntegrationsResponse | null;
  onTelegramTest: () => void;
}): ReactElement {
  if (!data) {
    return (
      <Panel title="Integration Status" subtitle="Telegram, ClickUp, Qdrant">
        <EmptyState text="Loading integrations..." />
      </Panel>
    );
  }

  return (
    <Panel title="Integration Status" subtitle="External service connections">
      <div className="grid gap-3 sm:grid-cols-3">
        <ExpandableRow
          details={{
            credentials_present: String(data.telegram.credentials_present),
            notifier_timer: data.telegram.notifier_timer,
            last_delivery: data.telegram.last_delivery,
            last_check: data.telegram.last_check,
          }}
        >
          <div className="flex items-center justify-between gap-2">
            <p className="text-sm font-medium text-white/85">Telegram</p>
            <StatusPill status={data.telegram.state} />
          </div>
          <p className="mt-1 text-xs text-white/40">
            {data.telegram.configured ? 'Configured' : 'Not configured'}
          </p>
          {data.telegram.last_delivery ? (
            <p className="mt-0.5 text-xs text-white/30">
              Last delivery: {formatDate(data.telegram.last_delivery)}
            </p>
          ) : null}
          <div className="mt-2">
            <button
              type="button"
              onClick={(e): void => {
                e.stopPropagation();
                onTelegramTest();
              }}
              disabled={!data.telegram.configured}
              className="rounded-md border border-fuchsia-500/30 bg-fuchsia-500/10 px-2 py-1 text-xs font-medium text-fuchsia-200 disabled:opacity-35"
            >
              Test
            </button>
          </div>
        </ExpandableRow>

        <ExpandableRow
          details={{
            stage: data.clickup.stage,
            writes_enabled: String(data.clickup.writes_enabled),
            last_check: data.clickup.last_check,
          }}
        >
          <div className="flex items-center justify-between gap-2">
            <p className="text-sm font-medium text-white/85">ClickUp</p>
            <StatusPill status={data.clickup.state} />
          </div>
          <p className="mt-1 text-xs text-white/40">
            {data.clickup.configured ? 'Configured' : 'Not configured'}
            {data.clickup.stage ? ` \u00b7 ${data.clickup.stage}` : ''}
          </p>
          {data.clickup.writes_enabled ? (
            <p className="mt-0.5 text-xs text-amber-300/60">Writes enabled</p>
          ) : null}
        </ExpandableRow>

        <ExpandableRow
          details={{
            reachable: String(data.qdrant.reachable),
            collections_count: data.qdrant.collections_count,
            last_check: data.qdrant.last_check,
          }}
        >
          <div className="flex items-center justify-between gap-2">
            <p className="text-sm font-medium text-white/85">Qdrant</p>
            <StatusPill status={data.qdrant.state} />
          </div>
          <p className="mt-1 text-xs text-white/40">
            {data.qdrant.configured ? 'Configured' : 'Not configured'}
            {data.qdrant.reachable ? ' \u00b7 reachable' : ''}
          </p>
          {data.qdrant.collections_count != null ? (
            <p className="mt-0.5 text-xs text-white/30">
              {data.qdrant.collections_count} collection(s)
            </p>
          ) : null}
        </ExpandableRow>
      </div>
    </Panel>
  );
}

// ─── Registry Drift Panel ───────────────────────────────────────────────────

function RegistryDriftPanel({ data }: { data: AgentReconciliationResponse | null }): ReactElement {
  if (!data) {
    return (
      <Panel title="Registry Drift" subtitle="Agent reconciliation analysis">
        <EmptyState text="Loading drift analysis..." />
      </Panel>
    );
  }

  if (data.drift_items.length === 0) {
    return (
      <Panel
        title="Registry Drift"
        subtitle="Agent reconciliation analysis"
        badge={<StatusPill status="pass" />}
      >
        <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 px-4 py-6 text-center text-sm text-emerald-300">
          No drift detected. Registry and definitions are consistent.
        </div>
      </Panel>
    );
  }

  return (
    <Panel
      title="Registry Drift"
      subtitle={`${String(data.summary.total_drift)} drift item(s) detected`}
    >
      <div className="space-y-2">
        {data.drift_items.map(
          (item: ReconciliationDriftItem): ReactElement => (
            <ExpandableRow
              key={`${item.agent}-${item.classification}`}
              details={{
                classification: item.classification,
                issue: item.issue,
                recommendation: item.recommendation,
                ...(item.technical_details
                  ? Object.fromEntries(
                      Object.entries(item.technical_details).map(([k, v]) => [k, String(v)])
                    )
                  : {}),
              }}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-white/85">{item.agent}</p>
                  <p className="mt-1 text-xs text-white/45">{item.recommendation}</p>
                </div>
                <StatusPill status={item.classification} />
              </div>
            </ExpandableRow>
          )
        )}
      </div>

      {data.proposals.length > 0 ? (
        <div className="mt-4 border-t border-white/10 pt-4">
          <p className="mb-2 text-xs font-medium uppercase tracking-wide text-white/40">
            Reconciliation proposals
          </p>
          <div className="space-y-2">
            {data.proposals.map(p => (
              <div
                key={`${p.agent}-${p.action}`}
                className="rounded-lg border border-white/10 bg-black/10 px-3 py-2"
              >
                <p className="text-sm text-white/80">
                  <span className="font-medium">{p.agent}</span> \u2014 {p.action}
                </p>
                <p className="mt-1 text-xs text-white/40">{p.rationale}</p>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </Panel>
  );
}

// ─── Canary Task Panel ──────────────────────────────────────────────────────

function CanaryPanel({
  data,
  onLaunch,
  onCancel,
}: {
  data: CanaryStatusResponse | null;
  onLaunch: () => void;
  onCancel: () => void;
}): ReactElement {
  if (!data) {
    return (
      <Panel title="Canary Task">
        <EmptyState text="Loading canary status..." />
      </Panel>
    );
  }

  const isRunning = data.status === 'running';

  return (
    <Panel title="Canary Task" badge={<StatusPill status={data.status} />}>
      <div className="space-y-3">
        {data.task_id ? (
          <p className="font-mono text-xs text-white/35">Task: {data.task_id}</p>
        ) : null}

        <div className="grid gap-2 text-xs text-white/45">
          {data.started_at ? <p>Started: {formatDate(data.started_at)}</p> : null}
          {data.completed_at ? <p>Completed: {formatDate(data.completed_at)}</p> : null}
          {data.cancelled_at ? <p>Cancelled: {formatDate(data.cancelled_at)}</p> : null}
          {data.result_summary ? <p>Result: {data.result_summary}</p> : null}
        </div>

        <div className="flex gap-2">
          {isRunning ? (
            <button
              type="button"
              onClick={(e): void => {
                e.stopPropagation();
                onCancel();
              }}
              className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-1.5 text-xs font-medium text-red-200"
            >
              Cancel Canary
            </button>
          ) : (
            <button
              type="button"
              onClick={(e): void => {
                e.stopPropagation();
                onLaunch();
              }}
              className="rounded-md border border-fuchsia-500/30 bg-fuchsia-500/10 px-3 py-1.5 text-xs font-medium text-fuchsia-200"
            >
              Launch Canary
            </button>
          )}
        </div>
      </div>
    </Panel>
  );
}

// ─── Access Mode Panel ──────────────────────────────────────────────────────

function AccessModePanel({ data }: { data: AccessModeResponse | null }): ReactElement {
  if (!data) {
    return (
      <Panel title="Access Mode">
        <EmptyState text="Loading access info..." />
      </Panel>
    );
  }

  return (
    <Panel title="Access Mode" badge={<StatusPill status={data.access_mode} />}>
      <div className="space-y-2 text-sm">
        <p className="text-white/60">{data.access_mode_description}</p>
        <div className="grid gap-1 text-xs text-white/45">
          <p>Auth enabled: {data.auth_enabled ? 'Yes' : 'No'}</p>
          <p>Public exposure: {data.public_exposure ? 'Yes' : 'No'}</p>
          <p>RBAC role: {data.rbac_role}</p>
        </div>
      </div>
    </Panel>
  );
}

// ─── Semantic Services Panel ────────────────────────────────────────────────

function SemanticServicesPanel({
  data,
  highlight,
}: {
  data: SemanticServicesResponse | null;
  highlight: Set<FilterKey>;
}): ReactElement {
  if (!data) {
    return (
      <Panel title="Services & Timers" subtitle="Loading semantic state...">
        <EmptyState text="Loading services..." />
      </Panel>
    );
  }

  const agg = data.aggregates;
  const showFailedOnly = highlight.has('failures');
  const showRunningOnly = highlight.has('running');

  // Sort: failed first, then running, then scheduled, then idle, then unknown
  const sortedServices = [...data.services].sort((a, b) => {
    const order: Record<SemanticState, number> = {
      failed: 0,
      running: 1,
      scheduled: 2,
      idle: 3,
      unknown: 4,
    };
    return (order[a.semantic_state] ?? 5) - (order[b.semantic_state] ?? 5);
  });

  const filteredServices = sortedServices.filter((svc: SemanticService): boolean => {
    if (showFailedOnly && svc.semantic_state !== 'failed') return false;
    if (showRunningOnly && svc.semantic_state !== 'running') return false;
    return true;
  });

  // Group by semantic state
  const groups = new Map<SemanticState, SemanticService[]>();
  for (const svc of filteredServices) {
    const existing = groups.get(svc.semantic_state) ?? [];
    existing.push(svc);
    groups.set(svc.semantic_state, existing);
  }

  return (
    <Panel title="Services & Timers" subtitle="Semantic service state groups">
      <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-5">
        <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-3 text-center">
          <p className="text-xl font-semibold text-emerald-300">{agg.running}</p>
          <p className="text-xs text-emerald-300/60">Running</p>
        </div>
        <div className="rounded-lg border border-white/10 bg-black/10 p-3 text-center">
          <p className="text-xl font-semibold text-white/60">{agg.idle}</p>
          <p className="text-xs text-white/35">Idle</p>
        </div>
        <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 p-3 text-center">
          <p className="text-xl font-semibold text-amber-200">{agg.scheduled}</p>
          <p className="text-xs text-amber-200/60">Scheduled</p>
        </div>
        <div className="rounded-lg border border-red-500/20 bg-red-500/5 p-3 text-center">
          <p className="text-xl font-semibold text-red-300">{agg.failed}</p>
          <p className="text-xs text-red-300/60">Failed</p>
        </div>
        <div className="rounded-lg border border-white/10 bg-black/10 p-3 text-center">
          <p className="text-xl font-semibold text-white/60">{agg.total}</p>
          <p className="text-xs text-white/35">Total</p>
        </div>
      </div>

      <div className="space-y-4">
        {Array.from(groups.entries()).map(([state, services]) => (
          <div key={state}>
            <p className="mb-2 text-xs font-medium uppercase tracking-wide text-white/40">
              {state} ({services.length})
            </p>
            <div className="space-y-2">
              {services.map(
                (svc: SemanticService): ReactElement => (
                  <ExpandableRow
                    key={svc.name}
                    details={{
                      active_state: svc.active_state,
                      sub_state: svc.sub_state,
                      unit_file_state: svc.unit_file_state,
                      next_run_at: svc.next_run_at,
                      timer_backed: String(svc.timer_backed),
                    }}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate font-mono text-xs text-white/85">{svc.name}</p>
                        <p className="mt-1 truncate text-xs text-white/40">
                          {svc.description ?? '\u2014'}
                        </p>
                        {svc.timer_backed && svc.next_run_at ? (
                          <p className="mt-0.5 text-xs text-white/30">
                            Next run: {formatDate(svc.next_run_at)}
                          </p>
                        ) : null}
                      </div>
                      <span
                        className={`inline-flex rounded-full border px-2 py-0.5 text-xs font-medium ${semanticStateTone(svc.semantic_state)}`}
                      >
                        {svc.semantic_state}
                      </span>
                    </div>
                  </ExpandableRow>
                )
              )}
            </div>
          </div>
        ))}
      </div>

      {filteredServices.length === 0 ? (
        <EmptyState text="No services match the current filter." />
      ) : null}
    </Panel>
  );
}

// ─── Main Page Component ────────────────────────────────────────────────────

export function GoviralControlPlanePage(): ReactElement {
  const [overview, setOverview] = useState<GoviralOverview | null>(null);
  const [approvalAnalysis, setApprovalAnalysis] = useState<ApprovalAnalysisResponse | null>(null);
  const [semanticServices, setSemanticServices] = useState<SemanticServicesResponse | null>(null);
  const [modules, setModules] = useState<ModulesResponse | null>(null);
  const [integrations, setIntegrations] = useState<IntegrationsResponse | null>(null);
  const [reconciliation, setReconciliation] = useState<AgentReconciliationResponse | null>(null);
  const [canary, setCanary] = useState<CanaryStatusResponse | null>(null);
  const [accessMode, setAccessMode] = useState<AccessModeResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [activeFilters, setActiveFilters] = useState<Set<FilterKey>>(new Set());
  const [confirmAction, setConfirmAction] = useState<{
    title: string;
    description: string;
    action: () => Promise<void>;
  } | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
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
    ] = await Promise.allSettled([
      fetchGoviralOverview(),
      fetchApprovalAnalysis(),
      fetchSemanticServices(),
      fetchModules(),
      fetchIntegrations(),
      fetchAgentReconciliation(),
      fetchCanaryStatus(),
      fetchAccessMode(),
    ]);

    const errors: string[] = [];

    if (overviewResult.status === 'fulfilled') setOverview(overviewResult.value);
    else errors.push('overview');

    if (approvalResult.status === 'fulfilled') setApprovalAnalysis(approvalResult.value);
    else errors.push('approvals');

    if (servicesResult.status === 'fulfilled') setSemanticServices(servicesResult.value);
    else errors.push('services');

    if (modulesResult.status === 'fulfilled') setModules(modulesResult.value);
    else errors.push('modules');

    if (integrationsResult.status === 'fulfilled') setIntegrations(integrationsResult.value);
    else errors.push('integrations');

    if (reconciliationResult.status === 'fulfilled') setReconciliation(reconciliationResult.value);
    else errors.push('reconciliation');

    if (canaryResult.status === 'fulfilled') setCanary(canaryResult.value);
    else errors.push('canary');

    if (accessResult.status === 'fulfilled') setAccessMode(accessResult.value);
    else errors.push('access');

    setError(errors.length > 0 ? `Unable to refresh: ${errors.join(', ')}` : null);
    setLoading(false);
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

  // Canary 5-second refresh when running
  useEffect((): (() => void) => {
    if (canary?.status === 'running') {
      canaryTimerRef.current = window.setInterval((): void => {
        void fetchCanaryStatus()
          .then(setCanary)
          .catch(() => {
            /* ignore */
          });
      }, 5_000);
    } else if (canaryTimerRef.current) {
      window.clearInterval(canaryTimerRef.current);
      canaryTimerRef.current = null;
    }

    return (): void => {
      if (canaryTimerRef.current) {
        window.clearInterval(canaryTimerRef.current);
      }
    };
  }, [canary?.status]);

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
    try {
      await confirmAction.action();
      await load();
    } catch {
      // error handled by caller
    } finally {
      setActionBusy(false);
      setConfirmAction(null);
    }
  }, [confirmAction, load]);

  // Derived values
  const freshness = overview?.brain?.snapshot_freshness;
  const pendingApprovals = approvalAnalysis?.counts.pending ?? overview?.approvals.pending ?? 0;
  const semanticAgg = semanticServices?.aggregates;
  const healthyServices = semanticAgg ? semanticAgg.running : 0;
  const totalServices = semanticAgg ? semanticAgg.total : 0;
  const failedServices = semanticAgg ? semanticAgg.failed : 0;

  const generatedAt = overview?.generated_at ?? approvalAnalysis?.generated_at ?? null;

  // Filter counts
  const filterCounts: Record<FilterKey, number> = {
    failures:
      (semanticAgg?.failed ?? 0) +
      (approvalAnalysis?.items.filter(i => i.risk_classification === 'RISK_ENGINE_FAILED').length ??
        0),
    drift: reconciliation?.summary.total_drift ?? 0,
    pending: pendingApprovals,
    malformed: approvalAnalysis?.counts.malformed ?? 0,
    running: canary?.status === 'running' ? 1 : 0,
    needsConfig: [
      integrations?.telegram.configured === false,
      integrations?.clickup.configured === false,
      integrations?.qdrant.configured === false,
    ].filter(Boolean).length,
  };

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
                    className={`inline-block h-2 w-2 rounded-full ${freshnessDot(freshness.freshness)}`}
                  />
                  <span className={`text-xs ${freshnessTone(freshness.freshness)}`}>
                    {freshness.age_seconds != null
                      ? formatAge(freshness.age_seconds)
                      : freshness.freshness}
                  </span>
                </span>
              ) : null}
            </div>
          </div>
        </header>

        {/* ── Stale data warning ─────────────────────────────────────── */}
        {freshness && (freshness.freshness === 'stale' || freshness.freshness === 'unavailable') ? (
          <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200">
            Brain snapshot is {freshness.freshness}
            {freshness.last_error_summary ? ` \u2014 ${freshness.last_error_summary}` : ''}.
            {freshness.producer_status ? ` Producer: ${freshness.producer_status}.` : ''} Data shown
            may be outdated.
          </div>
        ) : null}

        {error ? (
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
            {error}
          </div>
        ) : null}

        {loading && !overview ? (
          <div className="rounded-xl border border-white/10 p-8 text-center text-sm text-white/50">
            Loading GoViral operational state\u2026
          </div>
        ) : null}

        {/* ── Filter Bar ─────────────────────────────────────────────── */}
        <FilterBar active={activeFilters} onToggle={toggleFilter} counts={filterCounts} />

        {/* ── Metrics Row ────────────────────────────────────────────── */}
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <Metric
            label="Brain Doctor"
            value={overview?.doctor.status ?? 'UNKNOWN'}
            detail="Canonical brain health"
          />
          <Metric
            label="Pending approvals"
            value={pendingApprovals}
            detail={`${approvalAnalysis?.counts.executed ?? overview?.approvals.executed ?? 0} executed`}
          />
          <Metric
            label="Services"
            value={`${String(healthyServices)}/${String(totalServices)}`}
            detail={`${String(failedServices)} failed`}
            subtitle={
              semanticAgg
                ? `${String(semanticAgg.running)} running, ${String(semanticAgg.idle)} idle, ${String(semanticAgg.failed)} failed`
                : undefined
            }
          />
          <Metric
            label="Latest PRD"
            value={overview?.latest_prd?.title ?? '\u2014'}
            detail={`${String(overview?.recent_threads.length ?? 0)} recent agent threads`}
          />
        </div>

        {/* ── Approval Queue + Agent Runs ─────────────────────────────── */}
        <div className="grid gap-5 xl:grid-cols-2">
          {/* Approval Queue */}
          <Panel
            title="Approval Queue"
            subtitle={`Source refreshed ${formatDate(approvalAnalysis?.generated_at)}`}
            badge={
              approvalAnalysis &&
              (approvalAnalysis.duplicate_groups.length > 0 ||
                approvalAnalysis.counts.malformed > 0) ? (
                <span className="flex gap-1.5">
                  {approvalAnalysis.duplicate_groups.length > 0 ? (
                    <span className="rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-200">
                      {approvalAnalysis.duplicate_groups.length} duplicate group(s)
                    </span>
                  ) : null}
                  {approvalAnalysis.counts.malformed > 0 ? (
                    <span className="rounded-full border border-red-500/30 bg-red-500/10 px-2 py-0.5 text-xs font-medium text-red-300">
                      {approvalAnalysis.counts.malformed} malformed
                    </span>
                  ) : null}
                </span>
              ) : undefined
            }
          >
            <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Metric
                label="Pending"
                value={approvalAnalysis?.counts.pending ?? 0}
                detail="Awaiting decision"
              />
              <Metric
                label="Approved"
                value={approvalAnalysis?.counts.approved ?? 0}
                detail="Approved requests"
              />
              <Metric
                label="Rejected"
                value={approvalAnalysis?.counts.rejected ?? 0}
                detail="Rejected requests"
              />
              <Metric
                label="Executed"
                value={approvalAnalysis?.counts.executed ?? 0}
                detail="Governed executions"
              />
            </div>

            {approvalAnalysis && approvalAnalysis.items.length > 0 ? (
              <div className="space-y-2">
                {approvalAnalysis.items
                  .filter((item: ApprovalAnalysisItem): boolean => {
                    if (activeFilters.has('malformed') && !item.malformed) return false;
                    if (activeFilters.has('pending') && item.status !== 'pending') return false;
                    return true;
                  })
                  .map(
                    (item: ApprovalAnalysisItem): ReactElement => (
                      <ExpandableRow
                        key={`${item.status}-${item.id}`}
                        details={{
                          id: item.id,
                          risk_classification: item.risk_classification,
                          malformed: item.malformed ? 'Yes' : undefined,
                          malformed_reason: item.malformed_reason,
                          requested_by: item.requested_by,
                          created_at: item.created_at,
                        }}
                      >
                        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              <p className="truncate text-sm font-medium text-white/85">
                                {item.title}
                              </p>
                              {item.malformed ? (
                                <span
                                  className="flex-shrink-0 text-red-400"
                                  title={item.malformed_reason ?? 'Malformed approval item'}
                                >
                                  &#9888;
                                </span>
                              ) : null}
                            </div>
                            <p className="mt-1 text-xs text-white/40">
                              {item.requested_by ?? 'unknown source'} \u00b7{' '}
                              {formatDate(item.created_at)}
                            </p>
                          </div>
                          <div className="flex items-center gap-1.5">
                            {item.risk_classification ? (
                              <StatusPill status={item.risk_classification} />
                            ) : null}
                            <StatusPill status={item.status} />
                          </div>
                        </div>
                      </ExpandableRow>
                    )
                  )}
              </div>
            ) : (
              <EmptyState text="No bounded approval item metadata available." />
            )}
          </Panel>

          {/* Agent Runs */}
          <Panel
            title="Agent Runs"
            subtitle="Recent governed Agent Bus threads and runtime modules"
          >
            <div className="space-y-2">
              {(overview?.recent_threads ?? []).map(
                (thread: GoviralThread, index: number): ReactElement => {
                  const threadId = String(thread.id ?? `thread-${String(index + 1)}`);

                  return (
                    <ExpandableRow
                      key={threadId}
                      details={{
                        id: thread.id != null ? String(thread.id) : undefined,
                        lane: thread.lane != null ? String(thread.lane) : undefined,
                        lead_agent:
                          thread.lead_agent != null ? String(thread.lead_agent) : undefined,
                        agent_type:
                          thread.agent_type != null ? String(thread.agent_type) : undefined,
                      }}
                    >
                      <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium text-white/85">{threadId}</p>
                          <p className="mt-1 text-xs text-white/40">
                            {thread.lead_agent != null ? String(thread.lead_agent) : 'agent bus'}{' '}
                            \u00b7 {thread.lane != null ? String(thread.lane) : '\u2014'}
                          </p>
                        </div>
                        <StatusPill
                          status={thread.status != null ? String(thread.status) : 'unknown'}
                        />
                      </div>
                    </ExpandableRow>
                  );
                }
              )}

              {(overview?.recent_threads.length ?? 0) === 0 ? (
                <EmptyState text="No recent Agent Bus threads." />
              ) : null}
            </div>

            <div className="mt-5 border-t border-white/10 pt-5">
              <p className="mb-3 text-xs font-medium uppercase tracking-wide text-white/40">
                Runtime modules
              </p>

              <div className="grid gap-2 sm:grid-cols-2">
                {(modules?.modules ?? []).map(
                  (module: ModuleManifest): ReactElement => (
                    <ExpandableRow
                      key={module.id}
                      details={{
                        id: module.id,
                        state: module.state,
                        owner_agent: module.owner_agent,
                        run_id: module.run_id,
                        updated_at: module.updated_at,
                      }}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <p className="truncate text-sm font-medium text-white/85">{module.label}</p>
                        <span
                          className={`inline-flex rounded-full border px-2 py-0.5 text-xs font-medium ${moduleStateTone(module.state)}`}
                        >
                          {module.state.replace(/_/g, ' ')}
                        </span>
                      </div>
                      {module.owner_agent ? (
                        <p className="mt-1 text-xs text-white/45">Owner: {module.owner_agent}</p>
                      ) : null}
                      <p className="mt-1 truncate text-xs text-white/40">
                        {module.run_id ?? 'No run evidence'}
                      </p>
                    </ExpandableRow>
                  )
                )}

                {(modules?.modules.length ?? 0) === 0 ? (
                  <EmptyState text="No runtime modules discovered." />
                ) : null}
              </div>
            </div>

            {/* Registry Drift (inline in Agents section) */}
            {reconciliation && reconciliation.drift_items.length > 0 ? (
              <div className="mt-5 border-t border-white/10 pt-5">
                <RegistryDriftPanel data={reconciliation} />
              </div>
            ) : null}
          </Panel>
        </div>

        {/* ── Semantic Services Panel ────────────────────────────────── */}
        <SemanticServicesPanel data={semanticServices} highlight={activeFilters} />

        {/* ── Integration Status Panel ───────────────────────────────── */}
        <IntegrationStatusPanel
          data={integrations}
          onTelegramTest={(): void => {
            setConfirmAction({
              title: 'Telegram Test',
              description:
                'This will send a test message to the configured Telegram channel to verify connectivity.',
              action: async (): Promise<void> => {
                await sendTelegramTest();
              },
            });
          }}
        />

        {/* ── Canary + Access Mode (small cards) ─────────────────────── */}
        <div className="grid gap-5 xl:grid-cols-2">
          <CanaryPanel
            data={canary}
            onLaunch={(): void => {
              setConfirmAction({
                title: 'Canary Launch',
                description:
                  'This will launch a canary task to validate the current runtime environment.',
                action: async (): Promise<void> => {
                  const result = await launchCanary();
                  if (!result.ok && result.error) {
                    throw new Error(result.error);
                  }
                },
              });
            }}
            onCancel={(): void => {
              setConfirmAction({
                title: 'Canary Cancel',
                description: 'This will cancel the currently running canary task.',
                action: async (): Promise<void> => {
                  const result = await cancelCanary();
                  if (!result.ok && result.error) {
                    throw new Error(result.error);
                  }
                },
              });
            }}
          />
          <AccessModePanel data={accessMode} />
        </div>

        {/* ── Registry Drift standalone (when not inline in agents) ──── */}
        {reconciliation?.drift_items.length === 0 ? (
          <RegistryDriftPanel data={reconciliation} />
        ) : null}

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
