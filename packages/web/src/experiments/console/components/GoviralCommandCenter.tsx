import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';

type ControlAction = 'approve' | 'reject' | 'execute' | 'retry-unit' | 'start-unit' | 'stop-unit';

interface ApprovalItem {
  id: string;
  title: string;
  status: string;
  requested_by: string | null;
  risk: string | null;
  created_at: string | null;
}

interface ApprovalData {
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
}

interface RuntimeData {
  services: SystemdUnit[];
  /**
   * `/api/goviral/runtime` reports its own availability. When systemd cannot be
   * read it still returns HTTP 200 with an empty `services` array, so ignoring
   * these two fields renders a failed probe as a healthy "no services" list.
   */
  available?: boolean;
  error?: string | null;
}

interface AgentRun {
  id: string;
  title: string;
  agent: string;
  status: string;
  activity: string;
  modified_at: string | null;
}

interface AgentsData {
  runs: AgentRun[];
}

interface Incident {
  id: string;
  severity: string;
  title: string;
  detail: string;
  source: string;
}

interface IncidentData {
  incidents: Incident[];
}

interface AuditItem {
  timestamp: string | null;
  actor: string | null;
  action: string;
  target: string;
  status: string;
  detail: string | null;
}

interface ActionsData {
  enabled: boolean;
  role: 'viewer' | 'operator';
  csrf: string;
  audit: AuditItem[];
}

interface ActionResponse {
  ok: boolean;
  error?: string;
  detail?: string;
}

interface PendingAction {
  action: ControlAction;
  target: string;
  label: string;
  phrase: string;
}

interface SearchRow {
  key: string;
  type: 'approval' | 'agent' | 'incident' | 'service';
  title: string;
  detail: string;
  status: string;
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

function formatDate(value: string | null): string {
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

function confirmationFor(action: ControlAction, target: string): string {
  const verbs: Record<ControlAction, string> = {
    approve: 'APPROVE',
    reject: 'REJECT',
    execute: 'EXECUTE',
    'retry-unit': 'RETRY',
    'start-unit': 'START',
    'stop-unit': 'STOP',
  };

  return `${verbs[action]} ${target}`;
}

function tone(status: string): string {
  const normalized = status.toLowerCase();

  if (['success', 'approved', 'executed', 'active', 'pass'].includes(normalized)) {
    return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300';
  }

  if (['failed', 'critical', 'rejected', 'denied', 'error'].includes(normalized)) {
    return 'border-red-500/30 bg-red-500/10 text-red-300';
  }

  return 'border-amber-500/30 bg-amber-500/10 text-amber-200';
}

function Pill({ value }: { value: string }): ReactElement {
  return (
    <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${tone(value)}`}>
      {value || 'unknown'}
    </span>
  );
}

function ActionButton({
  label,
  disabled,
  onClick,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
}): ReactElement {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="rounded-md border border-fuchsia-500/30 bg-fuchsia-500/10 px-2.5 py-1.5 text-xs font-medium text-fuchsia-200 disabled:cursor-not-allowed disabled:opacity-35"
    >
      {label}
    </button>
  );
}

export function GoviralCommandCenter(): ReactElement {
  const [approvals, setApprovals] = useState<ApprovalData | null>(null);
  const [runtime, setRuntime] = useState<RuntimeData | null>(null);
  const [agents, setAgents] = useState<AgentsData | null>(null);
  const [incidents, setIncidents] = useState<IncidentData | null>(null);
  const [actions, setActions] = useState<ActionsData | null>(null);
  const [query, setQuery] = useState<string>('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
  const [confirmation, setConfirmation] = useState<string>('');
  const [busy, setBusy] = useState<boolean>(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    const [approvalsResult, runtimeResult, agentsResult, incidentsResult, actionsResult] =
      await Promise.allSettled([
        fetchJson<ApprovalData>('/api/goviral/approvals'),
        fetchJson<RuntimeData>('/api/goviral/runtime'),
        fetchJson<AgentsData>('/api/goviral/agents'),
        fetchJson<IncidentData>('/api/goviral/incidents'),
        fetchJson<ActionsData>('/api/goviral/actions'),
      ]);

    const failures: string[] = [];

    if (approvalsResult.status === 'fulfilled') {
      setApprovals(approvalsResult.value);
    } else {
      failures.push('approvals');
    }

    if (runtimeResult.status === 'fulfilled') {
      setRuntime(runtimeResult.value);
    } else {
      failures.push('runtime');
    }

    if (agentsResult.status === 'fulfilled') {
      setAgents(agentsResult.value);
    } else {
      failures.push('agents');
    }

    if (incidentsResult.status === 'fulfilled') {
      setIncidents(incidentsResult.value);
    } else {
      failures.push('incidents');
    }

    if (actionsResult.status === 'fulfilled') {
      setActions(actionsResult.value);
    } else {
      failures.push('actions');
    }

    setError(failures.length > 0 ? `Unable to refresh: ${failures.join(', ')}` : null);
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

  const rows = useMemo((): SearchRow[] => {
    const output: SearchRow[] = [];

    for (const item of approvals?.items ?? []) {
      output.push({
        key: `approval-${item.status}-${item.id}`,
        type: 'approval',
        title: item.title,
        detail: `${item.id} · ${item.requested_by ?? 'unknown source'} · risk ${item.risk ?? 'unknown'}`,
        status: item.status,
      });
    }

    for (const run of agents?.runs ?? []) {
      output.push({
        key: `agent-${run.id}`,
        type: 'agent',
        title: run.title,
        detail: `${run.agent} · ${formatDate(run.modified_at)}`,
        status: run.activity || run.status,
      });
    }

    for (const incident of incidents?.incidents ?? []) {
      output.push({
        key: `incident-${incident.id}`,
        type: 'incident',
        title: incident.title,
        detail: `${incident.source} · ${incident.detail}`,
        status: incident.severity,
      });
    }

    for (const unit of runtime?.services ?? []) {
      output.push({
        key: `service-${unit.name}`,
        type: 'service',
        title: unit.name,
        detail: unit.description ?? unit.sub_state,
        status: unit.active_state,
      });
    }

    const normalized = query.trim().toLowerCase();

    return output
      .filter((row): boolean => {
        const statusMatches = statusFilter === 'all' || row.status.toLowerCase() === statusFilter;
        const queryMatches =
          !normalized ||
          `${row.type} ${row.title} ${row.detail} ${row.status}`.toLowerCase().includes(normalized);
        return statusMatches && queryMatches;
      })
      .slice(0, 40);
  }, [agents, approvals, incidents, query, runtime, statusFilter]);

  const openAction = useCallback((action: ControlAction, target: string, label: string): void => {
    setPendingAction({ action, target, label, phrase: confirmationFor(action, target) });
    setConfirmation('');
    setMessage(null);
  }, []);

  const submitAction = useCallback(async (): Promise<void> => {
    if (!pendingAction || !actions?.enabled || confirmation !== pendingAction.phrase) {
      return;
    }

    setBusy(true);
    setError(null);

    try {
      const response = await fetch('/api/goviral/actions', {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          action: pendingAction.action,
          target: pendingAction.target,
          confirmation,
          csrf: actions.csrf,
        }),
      });

      const payload = (await response.json()) as ActionResponse;

      if (!response.ok || !payload.ok) {
        throw new Error(payload.error ?? `Action returned ${response.status}`);
      }

      setMessage(payload.detail ?? `${pendingAction.label} completed`);
      setPendingAction(null);
      setConfirmation('');
      await load();
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : 'Governed action failed');
    } finally {
      setBusy(false);
    }
  }, [actions, confirmation, load, pendingAction]);

  const operatorEnabled = actions?.enabled === true;
  const protectedUnit = (name: string): boolean =>
    [
      'goviral-archon.service',
      'goviral-action-firewall.service',
      'goviral-workspace-guard.service',
      'goviral-brainos-watchtower.service',
      'goviral-watchdog-hourly.service',
      'goviral-watchdog-daily.service',
    ].includes(name);

  return (
    <section className="rounded-xl border border-white/10 bg-white/[0.025]">
      <div className="flex flex-col gap-3 border-b border-white/10 px-5 py-4 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-base font-semibold text-white">Search, Governed Actions & Audit</h2>
            <Pill value={operatorEnabled ? 'operator' : 'viewer'} />
          </div>
          <p className="mt-1 text-xs text-white/45">
            Exact confirmations, strict command allowlists, rate limits and append-only action
            audit.
          </p>
        </div>
        <p className="text-xs text-white/40">Tailnet origin gate · no raw shell execution</p>
      </div>

      <div className="space-y-5 p-5">
        {error ? (
          <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200">
            {error}
          </div>
        ) : null}
        {message ? (
          <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-200">
            {message}
          </div>
        ) : null}

        <div className="grid gap-3 md:grid-cols-[1fr_220px]">
          <input
            value={query}
            onChange={(event): void => {
              setQuery(event.target.value);
            }}
            placeholder="Search approvals, agents, incidents and services…"
            className="rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-sm text-white outline-none placeholder:text-white/30 focus:border-fuchsia-500/40"
          />
          <select
            value={statusFilter}
            onChange={(event): void => {
              setStatusFilter(event.target.value);
            }}
            className="rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-sm text-white outline-none"
          >
            <option value="all">All statuses</option>
            <option value="pending">Pending</option>
            <option value="approved">Approved</option>
            <option value="executed">Executed</option>
            <option value="rejected">Rejected</option>
            <option value="active">Active</option>
            <option value="failed">Failed</option>
            <option value="idle">Idle</option>
            <option value="critical">Critical</option>
          </select>
        </div>

        <div className="grid gap-5 xl:grid-cols-2">
          <div>
            <p className="mb-3 text-xs font-medium uppercase tracking-wide text-white/40">
              Search results · {rows.length}
            </p>
            <div className="max-h-[520px] space-y-2 overflow-y-auto pr-1">
              {rows.map(
                (row): ReactElement => (
                  <div
                    key={row.key}
                    className="rounded-lg border border-white/10 bg-black/10 px-3 py-3"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-white/85">{row.title}</p>
                        <p className="mt-1 truncate text-xs text-white/40">
                          {row.type} · {row.detail}
                        </p>
                      </div>
                      <Pill value={row.status} />
                    </div>
                  </div>
                )
              )}
              {rows.length === 0 ? (
                <div className="rounded-lg border border-dashed border-white/10 p-6 text-center text-sm text-white/40">
                  No matching bounded metadata.
                </div>
              ) : null}
            </div>
          </div>

          <div className="space-y-5">
            <div>
              <p className="mb-3 text-xs font-medium uppercase tracking-wide text-white/40">
                Approval actions
              </p>
              <div className="max-h-[300px] space-y-2 overflow-y-auto pr-1">
                {(approvals?.items ?? [])
                  .filter((item): boolean => ['pending', 'approved'].includes(item.status))
                  .slice(0, 20)
                  .map(
                    (item): ReactElement => (
                      <div
                        key={`${item.status}-${item.id}`}
                        className="rounded-lg border border-white/10 bg-black/10 px-3 py-3"
                      >
                        <p className="truncate text-sm font-medium text-white/85">{item.title}</p>
                        <p className="mt-1 truncate font-mono text-xs text-white/35">{item.id}</p>
                        <div className="mt-3 flex flex-wrap gap-2">
                          {item.status === 'pending' ? (
                            <>
                              <ActionButton
                                label="Approve"
                                disabled={!operatorEnabled}
                                onClick={(): void => {
                                  openAction('approve', item.id, 'Approval');
                                }}
                              />
                              <ActionButton
                                label="Reject"
                                disabled={!operatorEnabled}
                                onClick={(): void => {
                                  openAction('reject', item.id, 'Rejection');
                                }}
                              />
                            </>
                          ) : (
                            <ActionButton
                              label="Execute dry run"
                              disabled={!operatorEnabled}
                              onClick={(): void => {
                                openAction('execute', item.id, 'Governed execution');
                              }}
                            />
                          )}
                        </div>
                      </div>
                    )
                  )}
              </div>
            </div>

            <div>
              <p className="mb-3 text-xs font-medium uppercase tracking-wide text-white/40">
                Service actions
              </p>
              {runtime?.available === false ? (
                <div className="mb-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
                  <span className="font-medium">Runtime data incomplete: </span>
                  {runtime.error ?? 'systemd reported the unit data as unavailable'}. The list below
                  may be missing units — an empty list here is not evidence that none exist.
                </div>
              ) : null}
              <div className="max-h-[300px] space-y-2 overflow-y-auto pr-1">
                {(runtime?.services ?? []).slice(0, 40).map((unit): ReactElement => {
                  const disabled = !operatorEnabled || protectedUnit(unit.name);
                  return (
                    <div
                      key={unit.name}
                      className="rounded-lg border border-white/10 bg-black/10 px-3 py-3"
                    >
                      <div className="flex items-center justify-between gap-3">
                        <p className="truncate font-mono text-xs text-white/80">{unit.name}</p>
                        <Pill value={protectedUnit(unit.name) ? 'protected' : unit.active_state} />
                      </div>
                      <div className="mt-3 flex flex-wrap gap-2">
                        {unit.active_state === 'failed' ? (
                          <ActionButton
                            label="Retry"
                            disabled={disabled}
                            onClick={(): void => {
                              openAction('retry-unit', unit.name, 'Service retry');
                            }}
                          />
                        ) : unit.active_state === 'active' ? (
                          <ActionButton
                            label="Stop"
                            disabled={disabled}
                            onClick={(): void => {
                              openAction('stop-unit', unit.name, 'Service stop');
                            }}
                          />
                        ) : (
                          <ActionButton
                            label="Start"
                            disabled={disabled}
                            onClick={(): void => {
                              openAction('start-unit', unit.name, 'Service start');
                            }}
                          />
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>

        <div className="border-t border-white/10 pt-5">
          <p className="mb-3 text-xs font-medium uppercase tracking-wide text-white/40">
            Recent action audit
          </p>
          <div className="space-y-2">
            {(actions?.audit ?? []).slice(0, 20).map(
              (item, index): ReactElement => (
                <div
                  key={`${item.timestamp ?? 'unknown'}-${index}`}
                  className="flex flex-col gap-2 rounded-lg border border-white/10 bg-black/10 px-3 py-3 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm text-white/80">
                      {item.action} · {item.target}
                    </p>
                    <p className="mt-1 truncate text-xs text-white/35">
                      {item.actor ?? 'unknown actor'} · {formatDate(item.timestamp)} ·{' '}
                      {item.detail ?? '—'}
                    </p>
                  </div>
                  <Pill value={item.status} />
                </div>
              )
            )}
            {(actions?.audit.length ?? 0) === 0 ? (
              <div className="rounded-lg border border-dashed border-white/10 p-5 text-center text-sm text-white/40">
                No governed actions recorded yet.
              </div>
            ) : null}
          </div>
        </div>
      </div>

      {pendingAction ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4">
          <div className="w-full max-w-lg rounded-xl border border-white/15 bg-[#101114] p-5 shadow-2xl">
            <h3 className="text-lg font-semibold text-white">Confirm {pendingAction.label}</h3>
            <p className="mt-2 text-sm text-white/50">
              Type the exact phrase below. This action is audited.
            </p>
            <code className="mt-4 block rounded-lg border border-white/10 bg-black/30 p-3 text-sm text-fuchsia-200">
              {pendingAction.phrase}
            </code>
            <input
              value={confirmation}
              onChange={(event): void => {
                setConfirmation(event.target.value);
              }}
              className="mt-4 w-full rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-sm text-white outline-none focus:border-fuchsia-500/40"
            />
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={(): void => {
                  setPendingAction(null);
                  setConfirmation('');
                }}
                className="rounded-md border border-white/10 px-3 py-2 text-sm text-white/60"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={busy || confirmation !== pendingAction.phrase}
                onClick={(): void => {
                  void submitAction();
                }}
                className="rounded-md border border-fuchsia-500/30 bg-fuchsia-500/15 px-3 py-2 text-sm font-medium text-fuchsia-200 disabled:opacity-35"
              >
                {busy ? 'Running…' : 'Run governed action'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
