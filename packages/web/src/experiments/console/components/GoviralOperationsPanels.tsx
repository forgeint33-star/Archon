import { useCallback, useEffect, useState, type ReactElement, type ReactNode } from 'react';

type Severity = 'critical' | 'high' | 'warning' | 'info';
type Activity = 'active' | 'recent' | 'idle' | 'unknown';

interface Incident {
  id: string;
  severity: Severity;
  title: string;
  detail: string;
  source: string;
  detected_at: string | null;
}

interface IncidentData {
  generated_at: string;
  doctor: {
    status: string;
    modified_at: string | null;
  };
  summary: Record<Severity, number>;
  incidents: Incident[];
  failed_units: {
    name: string;
  }[];
}

interface PlanItem {
  text: string;
  section: string;
  done: boolean;
}

interface PlanDocument {
  id: string;
  name: string;
  title: string;
  kind: string;
  source: string;
  modified_at: string | null;
  total_items: number;
  completed_items: number;
  open_items: number;
  items: PlanItem[];
}

interface GoalsData {
  generated_at: string;
  summary: {
    documents: number;
    total_items: number;
    completed_items: number;
    open_items: number;
    completion_percent: number;
  };
  documents: PlanDocument[];
}

interface AgentEvent {
  type: string;
  summary: string | null;
  timestamp: string | null;
}

interface AgentRun {
  id: string;
  title: string;
  agent: string;
  status: string;
  activity: Activity;
  activity_inferred: boolean;
  modified_at: string | null;
  latest_event: AgentEvent | null;
}

interface AgentsData {
  generated_at: string;
  summary: {
    total: number;
    active: number;
    recent: number;
    idle: number;
    unknown: number;
  };
  runs: AgentRun[];
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

function tone(value: string): string {
  const normalized = value.toLowerCase();

  if (['pass', 'active', 'completed', 'executed', 'info'].includes(normalized)) {
    return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300';
  }

  if (['critical', 'failed', 'fail', 'high'].includes(normalized)) {
    return 'border-red-500/30 bg-red-500/10 text-red-300';
  }

  if (['warning', 'recent', 'running'].includes(normalized)) {
    return 'border-amber-500/30 bg-amber-500/10 text-amber-200';
  }

  return 'border-white/15 bg-white/5 text-white/60';
}

function Pill({ value }: { value: string }): ReactElement {
  return (
    <span
      className={`inline-flex rounded-full border px-2 py-0.5 text-xs font-medium ${tone(value)}`}
    >
      {value}
    </span>
  );
}

function Panel({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: ReactNode;
}): ReactElement {
  return (
    <section className="rounded-xl border border-white/10 bg-white/[0.025]">
      <div className="border-b border-white/10 px-5 py-4">
        <h2 className="text-base font-semibold text-white">{title}</h2>
        <p className="mt-1 text-xs text-white/45">{subtitle}</p>
      </div>
      <div className="p-5">{children}</div>
    </section>
  );
}

function EmptyState({ text }: { text: string }): ReactElement {
  return (
    <div className="rounded-lg border border-dashed border-white/10 px-4 py-6 text-center text-sm text-white/40">
      {text}
    </div>
  );
}

function Progress({ completed, total }: { completed: number; total: number }): ReactElement {
  const percentage = total > 0 ? Math.round((completed / total) * 100) : 0;

  return (
    <div>
      <div className="mb-1 flex justify-between text-xs text-white/40">
        <span>
          {completed}/{total} completed
        </span>
        <span>{percentage}%</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-white/10">
        <div
          className="h-full rounded-full bg-emerald-400/70"
          style={{
            width: `${Math.max(0, Math.min(100, percentage))}%`,
          }}
        />
      </div>
    </div>
  );
}

export function GoviralOperationsPanels(): ReactElement {
  const [incidents, setIncidents] = useState<IncidentData | null>(null);

  const [goals, setGoals] = useState<GoalsData | null>(null);

  const [agents, setAgents] = useState<AgentsData | null>(null);

  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    const results = await Promise.allSettled([
      fetchJson<IncidentData>('/api/goviral/incidents'),
      fetchJson<GoalsData>('/api/goviral/goals'),
      fetchJson<AgentsData>('/api/goviral/agents'),
    ]);

    const failed: string[] = [];

    if (results[0].status === 'fulfilled') {
      setIncidents(results[0].value);
    } else {
      failed.push('incidents');
    }

    if (results[1].status === 'fulfilled') {
      setGoals(results[1].value);
    } else {
      failed.push('goals');
    }

    if (results[2].status === 'fulfilled') {
      setAgents(results[2].value);
    } else {
      failed.push('agents');
    }

    setError(failed.length > 0 ? `Unable to refresh: ${failed.join(', ')}` : null);
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

  return (
    <>
      <div className="border-t border-white/10 pt-5">
        <div className="mb-4">
          <h2 className="text-lg font-semibold text-white">Operational Intelligence</h2>
          <p className="mt-1 text-sm text-white/45">
            Incidents, delivery progress and bounded agent activity metadata.
          </p>
        </div>

        {error ? (
          <div className="mb-4 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
            {error}
          </div>
        ) : null}

        <div className="grid gap-5 xl:grid-cols-2">
          <Panel
            title="Incidents & Alerts"
            subtitle={`Doctor: ${incidents?.doctor.status ?? 'unknown'} · ${incidents?.failed_units.length ?? 0} failed unit(s)`}
          >
            {incidents ? (
              <>
                <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
                  {(['critical', 'high', 'warning', 'info'] as Severity[]).map(
                    (severity): ReactElement => (
                      <div
                        key={severity}
                        className="rounded-lg border border-white/10 bg-black/10 p-3"
                      >
                        <p className="text-xs uppercase tracking-wide text-white/40">{severity}</p>
                        <p className="mt-1 text-xl font-semibold text-white">
                          {incidents.summary[severity]}
                        </p>
                      </div>
                    )
                  )}
                </div>

                <div className="space-y-2">
                  {incidents.incidents.slice(0, 12).map(
                    (incident): ReactElement => (
                      <div
                        key={incident.id}
                        className="rounded-lg border border-white/10 bg-black/10 px-3 py-3"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <p className="text-sm font-medium text-white/85">{incident.title}</p>
                            <p className="mt-1 text-xs text-white/45">{incident.detail}</p>
                            <p className="mt-2 text-xs text-white/30">
                              {incident.source} · {formatDate(incident.detected_at)}
                            </p>
                          </div>
                          <Pill value={incident.severity} />
                        </div>
                      </div>
                    )
                  )}
                </div>
              </>
            ) : (
              <EmptyState text="Loading incident checks…" />
            )}
          </Panel>

          <Panel
            title="Goals & Deliverables"
            subtitle={`${goals?.summary.documents ?? 0} bounded planning document(s)`}
          >
            {goals && goals.documents.length > 0 ? (
              <>
                <div className="mb-4 rounded-lg border border-white/10 bg-black/10 p-4">
                  <Progress
                    completed={goals.summary.completed_items}
                    total={goals.summary.total_items}
                  />
                  <p className="mt-3 text-xs text-white/40">
                    {goals.summary.open_items} open item(s) across {goals.summary.documents}{' '}
                    document(s)
                  </p>
                </div>

                <div className="space-y-3">
                  {goals.documents.slice(0, 8).map(
                    (document): ReactElement => (
                      <div
                        key={document.id}
                        className="rounded-lg border border-white/10 bg-black/10 px-3 py-3"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <p className="truncate text-sm font-medium text-white/85">
                              {document.title}
                            </p>
                            <p className="mt-1 text-xs text-white/40">
                              {document.source} · {document.name} ·{' '}
                              {formatDate(document.modified_at)}
                            </p>
                          </div>
                          <Pill value={document.kind} />
                        </div>

                        <div className="mt-3">
                          <Progress
                            completed={document.completed_items}
                            total={document.total_items}
                          />
                        </div>

                        {document.items.length > 0 ? (
                          <div className="mt-3 space-y-1">
                            {document.items
                              .filter((item): boolean => !item.done)
                              .slice(0, 3)
                              .map(
                                (item, index): ReactElement => (
                                  <p
                                    key={`${document.id}-${index}`}
                                    className="truncate text-xs text-white/45"
                                  >
                                    • {item.text}
                                  </p>
                                )
                              )}
                          </div>
                        ) : null}
                      </div>
                    )
                  )}
                </div>
              </>
            ) : (
              <EmptyState text="No bounded goal or deliverable documents discovered." />
            )}
          </Panel>
        </div>
      </div>

      <Panel
        title="Agents & Recent Runs"
        subtitle="Activity is inferred from bounded Agent Bus metadata; prompts and message bodies are not exposed."
      >
        {agents && agents.runs.length > 0 ? (
          <>
            <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-5">
              {(
                [
                  ['Total', agents.summary.total],
                  ['Active', agents.summary.active],
                  ['Recent', agents.summary.recent],
                  ['Idle', agents.summary.idle],
                  ['Unknown', agents.summary.unknown],
                ] as [string, number][]
              ).map(
                ([label, value]): ReactElement => (
                  <div key={label} className="rounded-lg border border-white/10 bg-black/10 p-3">
                    <p className="text-xs uppercase tracking-wide text-white/40">{label}</p>
                    <p className="mt-1 text-xl font-semibold text-white">{value}</p>
                  </div>
                )
              )}
            </div>

            <div className="grid gap-3 lg:grid-cols-2">
              {agents.runs.map(
                (run): ReactElement => (
                  <div
                    key={run.id}
                    className="rounded-lg border border-white/10 bg-black/10 px-4 py-3"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-white/85">{run.title}</p>
                        <p className="mt-1 text-xs text-white/40">
                          {run.agent} · {formatDate(run.modified_at)}
                        </p>
                      </div>
                      <Pill value={run.activity} />
                    </div>

                    <div className="mt-3 flex flex-wrap gap-2">
                      <Pill value={run.status} />
                      {run.activity_inferred ? (
                        <span className="rounded-full border border-white/10 px-2 py-0.5 text-xs text-white/35">
                          inferred activity
                        </span>
                      ) : null}
                    </div>

                    {run.latest_event ? (
                      <div className="mt-3 rounded-md border border-white/10 bg-black/20 px-3 py-2">
                        <p className="text-xs font-medium text-white/55">{run.latest_event.type}</p>
                        <p className="mt-1 truncate text-xs text-white/40">
                          {run.latest_event.summary ?? 'Event metadata only'}
                        </p>
                      </div>
                    ) : null}
                  </div>
                )
              )}
            </div>
          </>
        ) : (
          <EmptyState text="No bounded Agent Bus run metadata available." />
        )}
      </Panel>
    </>
  );
}
