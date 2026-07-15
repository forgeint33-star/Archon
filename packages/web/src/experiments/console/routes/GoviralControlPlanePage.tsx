import { GoviralCommandCenter } from '../components/GoviralCommandCenter';
import { GoviralOperationsPanels } from '../components/GoviralOperationsPanels';
import { useCallback, useEffect, useState, type ReactElement, type ReactNode } from 'react';

interface OverviewData {
  generated_at: string;
  doctor: {
    status: string;
  };
  approvals: {
    pending: number;
    approved?: number;
    rejected?: number;
    executed?: number;
  };
  modules: RuntimeModule[];
  recent_threads: RecentThread[];
  latest_prd: {
    title?: string | null;
  } | null;
}

interface RuntimeModule {
  name?: string;
  status?: string;
  latest_run?: string | null;
  modified_at?: string | null;
  phase_count?: number | null;
  failed_count?: number | null;
  real_execution?: boolean | null;
}

interface RecentThread {
  id?: string;
  thread_id?: string;
  title?: string;
  subject?: string;
  status?: string;
  agent?: string;
  updated_at?: string;
  modified_at?: string;
}

interface ApprovalItem {
  id: string;
  title: string;
  status: string;
  requested_by: string | null;
  risk: string | null;
  created_at: string | null;
}

interface ApprovalData {
  generated_at: string;
  source_modified_at: string | null;
  counts: {
    pending: number;
    approved: number;
    rejected: number;
    executed: number;
  };
  items: ApprovalItem[];
}

interface SystemdUnit {
  name: string;
  description: string | null;
  active_state: string;
  sub_state: string;
  unit_file_state: string | null;
  next_trigger: string | null;
}

interface RuntimeData {
  generated_at: string;
  available: boolean;
  services: SystemdUnit[];
  timers: SystemdUnit[];
  summary: {
    services_total: number;
    services_active: number;
    timers_total: number;
    timers_active: number;
    failed_units: number;
  };
  error: string | null;
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(`${url} returned ${response.status}`);
  }

  return (await response.json()) as T;
}

function formatDate(value: string | null | undefined): string {
  if (!value) {
    return '—';
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

function statusTone(status: string): string {
  const normalized = status.toLowerCase();

  if (
    normalized === 'pass' ||
    normalized === 'active' ||
    normalized === 'running' ||
    normalized === 'approved' ||
    normalized === 'executed'
  ) {
    return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300';
  }

  if (normalized === 'failed' || normalized === 'rejected' || normalized === 'error') {
    return 'border-red-500/30 bg-red-500/10 text-red-300';
  }

  return 'border-amber-500/30 bg-amber-500/10 text-amber-200';
}

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
  children,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
}): ReactElement {
  return (
    <section className="rounded-xl border border-white/10 bg-white/[0.025]">
      <div className="border-b border-white/10 px-5 py-4">
        <h2 className="text-base font-semibold text-white">{title}</h2>
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
}: {
  label: string;
  value: string | number;
  detail: string;
}): ReactElement {
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.025] p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-white/45">{label}</p>
      <p className="mt-2 text-2xl font-semibold text-white">{value}</p>
      <p className="mt-1 truncate text-xs text-white/45">{detail}</p>
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

export function GoviralControlPlanePage(): ReactElement {
  const [overview, setOverview] = useState<OverviewData | null>(null);
  const [approvals, setApprovals] = useState<ApprovalData | null>(null);
  const [runtime, setRuntime] = useState<RuntimeData | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    const [overviewResult, approvalsResult, runtimeResult] = await Promise.allSettled([
      fetchJson<OverviewData>('/api/goviral/overview'),
      fetchJson<ApprovalData>('/api/goviral/approvals'),
      fetchJson<RuntimeData>('/api/goviral/runtime'),
    ]);

    const errors: string[] = [];

    if (overviewResult.status === 'fulfilled') {
      setOverview(overviewResult.value);
    } else {
      errors.push('overview');
    }

    if (approvalsResult.status === 'fulfilled') {
      setApprovals(approvalsResult.value);
    } else {
      errors.push('approvals');
    }

    if (runtimeResult.status === 'fulfilled') {
      setRuntime(runtimeResult.value);
    } else {
      errors.push('runtime');
    }

    setError(errors.length > 0 ? `Unable to refresh: ${errors.join(', ')}` : null);
    setLoading(false);
  }, []);

  useEffect((): (() => void) => {
    void load();

    const timer = window.setInterval((): void => {
      void load();
    }, 30_000);

    return (): void => {
      window.clearInterval(timer);
    };
  }, [load]);

  const pendingApprovals = approvals?.counts.pending ?? overview?.approvals.pending ?? 0;

  const activeServices = runtime?.summary.services_active ?? 0;
  const totalServices = runtime?.summary.services_total ?? 0;
  const failedUnits = runtime?.summary.failed_units ?? 0;

  const generatedAt =
    overview?.generated_at ?? approvals?.generated_at ?? runtime?.generated_at ?? null;

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-[1600px] flex-col gap-5 p-5 lg:p-7">
        <header className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-2xl font-semibold text-white">GoViral Control Plane</h1>
              <span className="rounded-full border border-sky-500/30 bg-sky-500/10 px-2 py-0.5 text-xs font-medium text-sky-200">
                Read-only
              </span>
            </div>
            <p className="mt-2 max-w-3xl text-sm text-white/50">
              Governed operational view of BrainOS, approvals, agents, services and timers. No
              execution actions are exposed.
            </p>
          </div>

          <div className="text-left text-xs text-white/40 lg:text-right">
            <p>Auto-refresh: 30 seconds</p>
            <p>Updated: {formatDate(generatedAt)}</p>
          </div>
        </header>

        {error ? (
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
            {error}
          </div>
        ) : null}

        {loading && !overview ? (
          <div className="rounded-xl border border-white/10 p-8 text-center text-sm text-white/50">
            Loading GoViral operational state…
          </div>
        ) : null}

        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <Metric
            label="Brain Doctor"
            value={overview?.doctor.status ?? 'UNKNOWN'}
            detail="Canonical brain health"
          />
          <Metric
            label="Pending approvals"
            value={pendingApprovals}
            detail={`${approvals?.counts.executed ?? overview?.approvals.executed ?? 0} executed`}
          />
          <Metric
            label="Active services"
            value={`${activeServices}/${totalServices}`}
            detail={`${failedUnits} failed units`}
          />
          <Metric
            label="Latest PRD"
            value={overview?.latest_prd?.title ?? '—'}
            detail={`${overview?.recent_threads.length ?? 0} recent agent threads`}
          />
        </div>

        <div className="grid gap-5 xl:grid-cols-2">
          <Panel
            title="Approval Queue"
            subtitle={`Source refreshed ${formatDate(approvals?.source_modified_at)}`}
          >
            <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Metric
                label="Pending"
                value={approvals?.counts.pending ?? 0}
                detail="Awaiting decision"
              />
              <Metric
                label="Approved"
                value={approvals?.counts.approved ?? 0}
                detail="Approved requests"
              />
              <Metric
                label="Rejected"
                value={approvals?.counts.rejected ?? 0}
                detail="Rejected requests"
              />
              <Metric
                label="Executed"
                value={approvals?.counts.executed ?? 0}
                detail="Governed executions"
              />
            </div>

            {approvals && approvals.items.length > 0 ? (
              <div className="space-y-2">
                {approvals.items.map(
                  (item): ReactElement => (
                    <div
                      key={`${item.status}-${item.id}`}
                      className="flex flex-col gap-2 rounded-lg border border-white/10 bg-black/10 px-3 py-3 sm:flex-row sm:items-center sm:justify-between"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-white/85">{item.title}</p>
                        <p className="mt-1 text-xs text-white/40">
                          {item.requested_by ?? 'unknown source'} · {formatDate(item.created_at)}
                          {item.risk ? ` · risk: ${item.risk}` : ''}
                        </p>
                      </div>
                      <StatusPill status={item.status} />
                    </div>
                  )
                )}
              </div>
            ) : (
              <EmptyState text="No bounded approval item metadata available." />
            )}
          </Panel>

          <Panel
            title="Agent Runs"
            subtitle="Recent governed Agent Bus threads and runtime modules"
          >
            <div className="space-y-2">
              {(overview?.recent_threads ?? []).map((thread, index): ReactElement => {
                const threadId = thread.thread_id ?? thread.id ?? `thread-${index + 1}`;

                return (
                  <div
                    key={threadId}
                    className="flex items-center justify-between gap-3 rounded-lg border border-white/10 bg-black/10 px-3 py-3"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-white/85">
                        {thread.title ?? thread.subject ?? threadId}
                      </p>
                      <p className="mt-1 text-xs text-white/40">
                        {thread.agent ?? 'agent bus'} ·{' '}
                        {formatDate(thread.updated_at ?? thread.modified_at)}
                      </p>
                    </div>
                    <StatusPill status={thread.status ?? 'unknown'} />
                  </div>
                );
              })}

              {(overview?.recent_threads.length ?? 0) === 0 ? (
                <EmptyState text="No recent Agent Bus threads." />
              ) : null}
            </div>

            <div className="mt-5 border-t border-white/10 pt-5">
              <p className="mb-3 text-xs font-medium uppercase tracking-wide text-white/40">
                Runtime modules
              </p>

              <div className="grid gap-2 sm:grid-cols-2">
                {(overview?.modules ?? []).map(
                  (module, index): ReactElement => (
                    <div
                      key={module.name ?? `module-${index + 1}`}
                      className="rounded-lg border border-white/10 bg-black/10 px-3 py-3"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <p className="truncate text-sm font-medium text-white/85">
                          {module.name ?? 'Unnamed module'}
                        </p>
                        <StatusPill status={module.status ?? 'unknown'} />
                      </div>
                      <p className="mt-2 truncate text-xs text-white/40">
                        {module.latest_run ?? 'No latest-run pointer'}
                      </p>
                    </div>
                  )
                )}
              </div>
            </div>
          </Panel>
        </div>

        <Panel
          title="Services & Timers"
          subtitle={
            runtime?.available
              ? 'Read-only systemd state'
              : (runtime?.error ?? 'Runtime state unavailable')
          }
        >
          <div className="grid gap-5 xl:grid-cols-2">
            <div>
              <p className="mb-3 text-xs font-medium uppercase tracking-wide text-white/40">
                GoViral services
              </p>

              <div className="space-y-2">
                {(runtime?.services ?? []).map(
                  (unit): ReactElement => (
                    <div
                      key={unit.name}
                      className="flex items-center justify-between gap-3 rounded-lg border border-white/10 bg-black/10 px-3 py-3"
                    >
                      <div className="min-w-0">
                        <p className="truncate font-mono text-xs text-white/85">{unit.name}</p>
                        <p className="mt-1 truncate text-xs text-white/40">
                          {unit.description ?? unit.unit_file_state ?? '—'}
                        </p>
                      </div>
                      <StatusPill status={unit.active_state} />
                    </div>
                  )
                )}

                {(runtime?.services.length ?? 0) === 0 ? (
                  <EmptyState text="No GoViral services discovered." />
                ) : null}
              </div>
            </div>

            <div>
              <p className="mb-3 text-xs font-medium uppercase tracking-wide text-white/40">
                GoViral timers
              </p>

              <div className="space-y-2">
                {(runtime?.timers ?? []).map(
                  (unit): ReactElement => (
                    <div
                      key={unit.name}
                      className="flex items-center justify-between gap-3 rounded-lg border border-white/10 bg-black/10 px-3 py-3"
                    >
                      <div className="min-w-0">
                        <p className="truncate font-mono text-xs text-white/85">{unit.name}</p>
                        <p className="mt-1 truncate text-xs text-white/40">
                          Next: {unit.next_trigger ?? '—'}
                        </p>
                      </div>
                      <StatusPill status={unit.active_state} />
                    </div>
                  )
                )}

                {(runtime?.timers.length ?? 0) === 0 ? (
                  <EmptyState text="No GoViral timers discovered." />
                ) : null}
              </div>
            </div>
          </div>
        </Panel>
        <GoviralOperationsPanels />
        <GoviralCommandCenter />
      </div>
    </div>
  );
}
