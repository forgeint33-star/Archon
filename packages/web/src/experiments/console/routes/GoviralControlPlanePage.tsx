import { Activity, Bot, CheckCircle2, FileText, RefreshCw, ShieldCheck } from 'lucide-react';
import { useCallback, useEffect, useState, type ReactElement } from 'react';
import { fetchGoviralOverview, type GoviralOverview } from '../skills/goviral';

function formatTime(value: string | null): string {
  if (value === null) return '—';

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function statusClass(status: string): string {
  const normalized = status.toUpperCase();

  if (normalized === 'PASS' || normalized === 'OK') {
    return 'border-success/30 bg-success/10 text-success';
  }

  if (normalized === 'FAIL' || normalized === 'ERROR') {
    return 'border-error/30 bg-error/10 text-error';
  }

  return 'border-border bg-surface text-text-secondary';
}

export function GoviralControlPlanePage(): ReactElement {
  const [overview, setOverview] = useState<GoviralOverview | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    setRefreshing(true);

    try {
      setOverview(await fetchGoviralOverview());
      setError(null);
    } catch (value) {
      setError(value instanceof Error ? value : new Error('Failed to load GoViral overview'));
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load();

    const timer = window.setInterval(() => {
      void load();
    }, 30_000);

    return (): void => {
      window.clearInterval(timer);
    };
  }, [load]);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto bg-surface">
      <header className="flex items-center justify-between border-b border-border px-8 py-5">
        <div>
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-5 w-5 text-accent-bright" />
            <h1 className="text-lg font-semibold text-text-primary">GoViral Control Plane</h1>
          </div>
          <p className="mt-1 text-sm text-text-tertiary">
            Read-only BrainOS, governance and agent runtime status
          </p>
        </div>

        <button
          type="button"
          onClick={() => {
            void load();
          }}
          disabled={refreshing}
          className="flex items-center gap-2 rounded-lg border border-border bg-surface-elevated px-3 py-2 text-sm text-text-secondary transition-colors hover:bg-surface-hover hover:text-text-primary disabled:opacity-50"
        >
          <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </header>

      <div className="space-y-6 p-8">
        {error !== null ? (
          <div className="rounded-xl border border-error/40 bg-error/10 p-4 text-sm text-error">
            {error.message}
          </div>
        ) : null}

        {overview === null ? (
          <div className="rounded-xl border border-border bg-surface-elevated p-8 text-center text-sm text-text-tertiary">
            Loading GoViral runtime…
          </div>
        ) : (
          <>
            <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
              <div className="rounded-xl border border-border bg-surface-elevated p-5">
                <div className="flex items-center justify-between">
                  <span className="text-sm text-text-tertiary">Brain Doctor</span>
                  <CheckCircle2 className="h-4 w-4 text-success" />
                </div>
                <div
                  className={`mt-4 inline-flex rounded-full border px-3 py-1 text-sm font-semibold ${statusClass(
                    overview.doctor.status
                  )}`}
                >
                  {overview.doctor.status}
                </div>
                <div className="mt-3 text-xs text-text-tertiary">
                  {formatTime(overview.doctor.modified_at)}
                </div>
              </div>

              <div className="rounded-xl border border-border bg-surface-elevated p-5">
                <div className="flex items-center justify-between">
                  <span className="text-sm text-text-tertiary">Pending approvals</span>
                  <ShieldCheck className="h-4 w-4 text-accent-bright" />
                </div>
                <div className="mt-3 text-3xl font-semibold text-text-primary">
                  {overview.approvals.pending}
                </div>
                <div className="mt-2 text-xs text-text-tertiary">
                  {overview.approvals.executed} executed · {overview.approvals.rejected} rejected
                </div>
              </div>

              <div className="rounded-xl border border-border bg-surface-elevated p-5">
                <div className="flex items-center justify-between">
                  <span className="text-sm text-text-tertiary">Recent agent threads</span>
                  <Bot className="h-4 w-4 text-accent-bright" />
                </div>
                <div className="mt-3 text-3xl font-semibold text-text-primary">
                  {overview.recent_threads.length}
                </div>
                <div className="mt-2 text-xs text-text-tertiary">Latest bounded agent-bus view</div>
              </div>

              <div className="rounded-xl border border-border bg-surface-elevated p-5">
                <div className="flex items-center justify-between">
                  <span className="text-sm text-text-tertiary">Latest PRD</span>
                  <FileText className="h-4 w-4 text-accent-bright" />
                </div>
                <div className="mt-3 line-clamp-2 text-sm font-semibold text-text-primary">
                  {overview.latest_prd?.title ?? 'No PRD found'}
                </div>
                <div className="mt-2 text-xs text-text-tertiary">
                  {formatTime(overview.latest_prd?.modified_at ?? null)}
                </div>
              </div>
            </section>

            <section>
              <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-text-secondary">
                <Activity className="h-4 w-4" />
                Runtime modules
              </h2>

              <div className="grid gap-4 lg:grid-cols-2">
                {overview.modules.map(module => (
                  <article
                    key={module.id}
                    className="rounded-xl border border-border bg-surface-elevated p-5"
                  >
                    <div className="flex items-start justify-between gap-4">
                      <div>
                        <h3 className="font-semibold text-text-primary">{module.label}</h3>
                        <p className="mt-1 font-mono text-xs text-text-tertiary">
                          {module.run_id ?? 'No current run'}
                        </p>
                      </div>
                      <span className="text-xs text-text-tertiary">
                        {formatTime(module.updated_at)}
                      </span>
                    </div>

                    <div className="mt-4 grid gap-2 sm:grid-cols-2">
                      {Object.entries(module.summary).length === 0 ? (
                        <span className="text-xs text-text-tertiary">No release summary</span>
                      ) : (
                        Object.entries(module.summary).map(([key, value]) => (
                          <div
                            key={key}
                            className="rounded-lg border border-border bg-surface px-3 py-2"
                          >
                            <div className="text-[10px] uppercase tracking-wide text-text-tertiary">
                              {key.replaceAll('_', ' ')}
                            </div>
                            <div className="mt-1 text-sm font-medium text-text-primary">
                              {String(value)}
                            </div>
                          </div>
                        ))
                      )}
                    </div>
                  </article>
                ))}
              </div>
            </section>

            <section>
              <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-text-secondary">
                <Bot className="h-4 w-4" />
                Agent bus
              </h2>

              <div className="overflow-hidden rounded-xl border border-border bg-surface-elevated">
                {overview.recent_threads.length === 0 ? (
                  <div className="p-5 text-sm text-text-tertiary">No agent threads found.</div>
                ) : (
                  overview.recent_threads.map((thread, index) => (
                    <div
                      key={String(thread.id ?? index)}
                      className="grid gap-2 border-b border-border px-5 py-4 last:border-b-0 md:grid-cols-[1.6fr_1fr_1fr_1fr]"
                    >
                      <div>
                        <div className="font-mono text-sm text-text-primary">
                          {String(thread.id ?? 'unknown')}
                        </div>
                        <div className="mt-1 text-xs text-text-tertiary">
                          {String(thread.agent_type ?? 'agent')}
                        </div>
                      </div>
                      <div className="text-sm text-text-secondary">
                        {String(thread.status ?? 'unknown')}
                      </div>
                      <div className="text-sm text-text-secondary">
                        {String(thread.lead_agent ?? '—')}
                      </div>
                      <div className="text-xs text-text-tertiary">
                        {String(thread.created_at ?? '—')}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </section>

            <footer className="text-xs text-text-tertiary">
              Generated {formatTime(overview.generated_at)} · {overview.brain_root}
            </footer>
          </>
        )}
      </div>
    </div>
  );
}
