import { useCallback, useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';

// ─── Shared types ────────────────────────────────────────────────────────────

interface TelegramStatus {
  generated_at: string;
  configured: boolean;
  last_notification: { sent_at: string | null; count: number };
  daily_digest: { last_sent: string | null; success: boolean | null };
  rate_limit: { messages_last_hour: number; max_per_hour: number };
}

interface AttentionItem {
  id: string;
  category: string;
  severity: string;
  title: string;
  detail: string;
  source: string;
  actionable: boolean;
  acknowledged: boolean;
}

interface AttentionData {
  generated_at: string;
  items: AttentionItem[];
  counts: { critical: number; high: number; warning: number; acknowledged: number };
}

interface SearchResult {
  key: string;
  type: string;
  title: string;
  detail: string;
  status: string;
  severity: string | null;
  source: string | null;
  timestamp: string | null;
}

interface SearchResponse {
  results: SearchResult[];
  total: number;
  page: number;
  page_size: number;
}

interface IntegrationStatus {
  generated_at: string;
  id: string;
  label: string;
  state: string;
  configured: boolean;
  detail: string;
  last_check: string | null;
}

interface AnalyticsRollup {
  generated_at: string;
  approval_stats: {
    pending_count: number;
    approved_count: number;
    rejected_count: number;
    executed_count: number;
  };
  incident_stats: { critical: number; high: number; warning: number };
  backup_stats: { latest_age_hours: number | null; archive_count: number };
  telegram_stats: {
    configured: boolean;
    messages_last_hour: number;
    daily_digest_success: boolean | null;
  };
  integration_states: { clickup: string; qdrant: string };
  service_stats: { total: number; active: number; failed: number };
}

interface RecoveryStatus {
  generated_at: string;
  backup: {
    latest_age_hours: number | null;
    latest_size_bytes: number | null;
    latest_modified_at: string | null;
    archive_count: number;
  };
  restore_drill: { latest_status: string; latest_checked_at: string | null };
  offsite: { configured: boolean; state: string; detail: string };
}

interface UpgradeStatus {
  generated_at: string;
  latest: {
    status: string;
    compatible: boolean;
    server_typecheck: string;
    web_typecheck: string;
    web_build: string;
    checked_at: string | null;
    detail: string;
  } | null;
  check_count: number;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function fetchJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { headers: { Accept: 'application/json' }, signal });
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return (await response.json()) as T;
}

function formatDate(value: string | null | undefined): string {
  if (!value) return '—';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(
    parsed
  );
}

function tone(status: string): string {
  const n = status.toLowerCase();
  if (['pass', 'active', 'completed', 'executed', 'info', 'configured', 'success'].includes(n))
    return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300';
  if (['critical', 'failed', 'fail', 'high', 'error'].includes(n))
    return 'border-red-500/30 bg-red-500/10 text-red-300';
  if (['warning', 'recent', 'running', 'pending'].includes(n))
    return 'border-amber-500/30 bg-amber-500/10 text-amber-200';
  return 'border-white/15 bg-white/5 text-white/60';
}

function Pill({ value }: { value: string }): ReactElement {
  return (
    <span
      className={`inline-flex rounded-full border px-2 py-0.5 text-xs font-medium ${tone(value)}`}
    >
      {value || 'unknown'}
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
        {subtitle ? <p className="mt-1 text-xs text-white/45">{subtitle}</p> : null}
      </div>
      <div className="p-5">{children}</div>
    </section>
  );
}

function MetricCard({
  label,
  value,
  detail,
}: {
  label: string;
  value: string | number;
  detail: string;
}): ReactElement {
  return (
    <div className="rounded-lg border border-white/10 bg-black/10 p-3">
      <p className="text-xs font-medium uppercase tracking-wide text-white/40">{label}</p>
      <p className="mt-1 text-xl font-semibold text-white">{value}</p>
      <p className="mt-1 truncate text-xs text-white/35">{detail}</p>
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

// ─── Telegram Panel ──────────────────────────────────────────────────────────

function TelegramPanel({ data }: { data: TelegramStatus | null }): ReactElement {
  if (!data) return <EmptyState text="Loading Telegram status..." />;

  return (
    <Panel title="Telegram Notifications" subtitle="Incident alerts and daily operations digest">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard
          label="Status"
          value={data.configured ? 'Configured' : 'Not configured'}
          detail={data.configured ? 'Credentials present' : 'Run goviral-telegram-configure'}
        />
        <MetricCard
          label="Last alert"
          value={data.last_notification.sent_at ? formatDate(data.last_notification.sent_at) : '—'}
          detail={`${data.last_notification.count} total sent`}
        />
        <MetricCard
          label="Daily digest"
          value={
            data.daily_digest.success === null ? '—' : data.daily_digest.success ? 'OK' : 'Failed'
          }
          detail={
            data.daily_digest.last_sent
              ? `Last: ${formatDate(data.daily_digest.last_sent)}`
              : 'Not sent yet'
          }
        />
        <MetricCard
          label="Rate limit"
          value={`${data.rate_limit.messages_last_hour}/${data.rate_limit.max_per_hour}`}
          detail="Messages this hour"
        />
      </div>
    </Panel>
  );
}

// ─── Needs Attention Panel ───────────────────────────────────────────────────

function AttentionPanel({
  data,
  onAck,
}: {
  data: AttentionData | null;
  onAck: (id: string) => void;
}): ReactElement {
  if (!data) return <EmptyState text="Loading attention items..." />;

  const unacked = data.items.filter(i => !i.acknowledged);

  return (
    <Panel
      title="Needs Attention Today"
      subtitle={`${data.counts.critical} critical · ${data.counts.high} high · ${data.counts.warning} warning · ${data.counts.acknowledged} acknowledged`}
    >
      {unacked.length === 0 ? (
        <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 px-4 py-6 text-center text-sm text-emerald-300">
          All clear — no unacknowledged attention items.
        </div>
      ) : (
        <div className="space-y-2">
          {unacked.map(item => (
            <div
              key={item.id}
              className="flex flex-col gap-2 rounded-lg border border-white/10 bg-black/10 px-3 py-3 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="min-w-0">
                <p className="text-sm font-medium text-white/85">{item.title}</p>
                <p className="mt-1 text-xs text-white/40">
                  {item.source} · {item.detail}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Pill value={item.severity} />
                <button
                  type="button"
                  onClick={(): void => {
                    onAck(item.id);
                  }}
                  className="rounded-md border border-white/15 bg-white/5 px-2 py-1 text-xs text-white/60 hover:bg-white/10"
                  aria-label={`Acknowledge ${item.title}`}
                >
                  Ack
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}

// ─── Enhanced Search Panel ───────────────────────────────────────────────────

function SearchPanel(): ReactElement {
  const [query, setQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState('all');
  const [severityFilter, setSeverityFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const doSearch = useCallback(
    async (q: string, type: string, severity: string, status: string, p: number) => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      setLoading(true);
      try {
        const params = new URLSearchParams({
          q,
          type,
          severity,
          status,
          page: String(p),
          pageSize: '20',
        });
        const data = await fetchJson<SearchResponse>(
          `/api/goviral/search?${params}`,
          controller.signal
        );
        setResults(data.results);
        setTotal(data.total);
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return;
      } finally {
        setLoading(false);
      }
    },
    []
  );

  useEffect((): (() => void) => {
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout((): void => {
      void doSearch(query, typeFilter, severityFilter, statusFilter, page);
    }, 300);
    return (): void => {
      clearTimeout(debounceRef.current);
    };
  }, [query, typeFilter, severityFilter, statusFilter, page, doSearch]);

  const totalPages = Math.max(1, Math.ceil(total / 20));

  return (
    <Panel
      title="Enhanced Search"
      subtitle="Search approvals, incidents, audit entries, and services with filters"
    >
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <input
            value={query}
            onChange={(e): void => {
              setQuery(e.target.value);
              setPage(1);
            }}
            placeholder="Search..."
            className="rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-sm text-white outline-none placeholder:text-white/30 focus:border-fuchsia-500/40"
            aria-label="Search query"
          />
          <select
            value={typeFilter}
            onChange={(e): void => {
              setTypeFilter(e.target.value);
              setPage(1);
            }}
            className="rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-sm text-white outline-none"
            aria-label="Filter by type"
          >
            <option value="all">All types</option>
            <option value="approval">Approvals</option>
            <option value="incident">Incidents</option>
            <option value="audit">Audit</option>
          </select>
          <select
            value={severityFilter}
            onChange={(e): void => {
              setSeverityFilter(e.target.value);
              setPage(1);
            }}
            className="rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-sm text-white outline-none"
            aria-label="Filter by severity"
          >
            <option value="all">All severities</option>
            <option value="critical">Critical</option>
            <option value="high">High</option>
            <option value="warning">Warning</option>
          </select>
          <select
            value={statusFilter}
            onChange={(e): void => {
              setStatusFilter(e.target.value);
              setPage(1);
            }}
            className="rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-sm text-white outline-none"
            aria-label="Filter by status"
          >
            <option value="all">All statuses</option>
            <option value="pending">Pending</option>
            <option value="approved">Approved</option>
            <option value="executed">Executed</option>
            <option value="rejected">Rejected</option>
            <option value="CRITICAL">Critical</option>
          </select>
        </div>

        <div className="flex items-center justify-between text-xs text-white/40">
          <span>
            {total} result(s) · Page {page}/{totalPages}
            {loading ? ' · Loading...' : ''}
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={page <= 1}
              onClick={(): void => {
                setPage(p => Math.max(1, p - 1));
              }}
              className="rounded border border-white/10 px-2 py-1 text-white/50 disabled:opacity-30"
            >
              Prev
            </button>
            <button
              type="button"
              disabled={page >= totalPages}
              onClick={(): void => {
                setPage(p => p + 1);
              }}
              className="rounded border border-white/10 px-2 py-1 text-white/50 disabled:opacity-30"
            >
              Next
            </button>
          </div>
        </div>

        <div className="max-h-[400px] space-y-2 overflow-y-auto">
          {results.map(result => (
            <div
              key={result.key}
              className="rounded-lg border border-white/10 bg-black/10 px-3 py-3"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-white/85">{result.title}</p>
                  <p className="mt-1 truncate text-xs text-white/40">
                    {result.type} · {result.detail}
                  </p>
                  {result.timestamp ? (
                    <p className="mt-1 text-xs text-white/30">{formatDate(result.timestamp)}</p>
                  ) : null}
                </div>
                <Pill value={result.status} />
              </div>
            </div>
          ))}
          {results.length === 0 && !loading ? <EmptyState text="No matching results." /> : null}
        </div>
      </div>
    </Panel>
  );
}

// ─── Integrations Panel ──────────────────────────────────────────────────────

function IntegrationsPanel({
  clickup,
  qdrant,
}: {
  clickup: IntegrationStatus | null;
  qdrant: IntegrationStatus | null;
}): ReactElement {
  const integrations = [clickup, qdrant].filter(Boolean) as IntegrationStatus[];

  return (
    <Panel title="Integrations" subtitle="External service connection status">
      {integrations.length > 0 ? (
        <div className="grid gap-3 sm:grid-cols-2">
          {integrations.map(integration => (
            <div
              key={integration.id}
              className="rounded-lg border border-white/10 bg-black/10 px-4 py-3"
            >
              <div className="flex items-center justify-between gap-3">
                <p className="text-sm font-medium text-white/85">{integration.label}</p>
                <Pill value={integration.state.replace(/_/g, ' ')} />
              </div>
              <p className="mt-2 text-xs text-white/40">{integration.detail}</p>
              {integration.last_check ? (
                <p className="mt-1 text-xs text-white/30">
                  Last check: {formatDate(integration.last_check)}
                </p>
              ) : null}
            </div>
          ))}
        </div>
      ) : (
        <EmptyState text="Loading integration status..." />
      )}
    </Panel>
  );
}

// ─── Analytics Panel ─────────────────────────────────────────────────────────

function AnalyticsPanel({ data }: { data: AnalyticsRollup | null }): ReactElement {
  if (!data) return <EmptyState text="Loading analytics..." />;

  return (
    <Panel title="Operational Analytics" subtitle="Bounded rollups and metric summary">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard
          label="Pending approvals"
          value={data.approval_stats.pending_count}
          detail={`${data.approval_stats.executed_count} executed`}
        />
        <MetricCard
          label="Incidents"
          value={data.incident_stats.critical + data.incident_stats.high}
          detail={`${data.incident_stats.critical} critical · ${data.incident_stats.warning} warnings`}
        />
        <MetricCard
          label="Backup"
          value={
            data.backup_stats.latest_age_hours !== null
              ? `${data.backup_stats.latest_age_hours}h`
              : '—'
          }
          detail={`${data.backup_stats.archive_count} archives`}
        />
        <MetricCard
          label="Services"
          value={`${data.service_stats.active}/${data.service_stats.total}`}
          detail={`${data.service_stats.failed} failed`}
        />
      </div>
      <div className="mt-4 flex justify-end">
        <a
          href="/api/goviral/analytics/export"
          download="goviral-analytics.csv"
          className="rounded-md border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-white/60 hover:bg-white/10"
        >
          Export CSV
        </a>
      </div>
    </Panel>
  );
}

// ─── Recovery Panel ──────────────────────────────────────────────────────────

function RecoveryPanel({ data }: { data: RecoveryStatus | null }): ReactElement {
  if (!data) return <EmptyState text="Loading recovery status..." />;

  return (
    <Panel title="Disaster Recovery" subtitle="Backup, restore drill, and off-site status">
      <div className="grid gap-3 sm:grid-cols-3">
        <MetricCard
          label="Latest backup"
          value={
            data.backup.latest_age_hours !== null ? `${data.backup.latest_age_hours}h ago` : 'None'
          }
          detail={
            data.backup.archive_count > 0 ? `${data.backup.archive_count} archives` : 'No archives'
          }
        />
        <MetricCard
          label="Restore drill"
          value={data.restore_drill.latest_status}
          detail={
            data.restore_drill.latest_checked_at
              ? `Last: ${formatDate(data.restore_drill.latest_checked_at)}`
              : 'Not run yet'
          }
        />
        <MetricCard
          label="Off-site backup"
          value={data.offsite.configured ? data.offsite.state.replace(/_/g, ' ') : 'Not configured'}
          detail={data.offsite.detail}
        />
      </div>
    </Panel>
  );
}

// ─── Upgrade Panel ───────────────────────────────────────────────────────────

function UpgradePanel({ data }: { data: UpgradeStatus | null }): ReactElement {
  if (!data) return <EmptyState text="Loading upgrade status..." />;

  return (
    <Panel title="Upstream Compatibility" subtitle={`${data.check_count} check(s) recorded`}>
      {data.latest ? (
        <div className="space-y-3">
          <div className="flex items-center gap-3">
            <Pill value={data.latest.status} />
            <span className="text-sm text-white/60">
              {data.latest.compatible ? 'Compatible' : 'Incompatible or unchecked'}
            </span>
          </div>
          <div className="grid gap-2 sm:grid-cols-3">
            <MetricCard label="Server typecheck" value={data.latest.server_typecheck} detail="" />
            <MetricCard label="Web typecheck" value={data.latest.web_typecheck} detail="" />
            <MetricCard label="Web build" value={data.latest.web_build} detail="" />
          </div>
          {data.latest.detail ? (
            <p className="text-xs text-white/40">{data.latest.detail}</p>
          ) : null}
          <p className="text-xs text-white/30">Checked: {formatDate(data.latest.checked_at)}</p>
        </div>
      ) : (
        <EmptyState text="No upstream compatibility checks have been run yet." />
      )}
    </Panel>
  );
}

// ─── Agent Task Panel (Phase 15) ─────────────────────────────────────────────

interface AgentTask {
  id: string;
  title: string;
  goal: string | null;
  workflow: string | null;
  status: string;
  created_at: string;
  updated_at: string;
  created_by: string;
  correlation_id: string;
  result: string | null;
}

interface TasksData {
  tasks: AgentTask[];
  total: number;
}

function AgentTaskPanel({
  data,
  onRefresh,
}: {
  data: TasksData | null;
  onRefresh: () => void;
}): ReactElement {
  const [title, setTitle] = useState('');
  const [workflow, setWorkflow] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [confirmText, setConfirmText] = useState('');
  const [message, setMessage] = useState<string | null>(null);

  const createTask = useCallback(async (): Promise<void> => {
    if (!title.trim() || title.length < 3) return;
    setBusy(true);
    try {
      const response = await fetch('/api/goviral/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: title.trim(),
          workflow: workflow.trim() || undefined,
        }),
      });
      const result = asRecord((await response.json()) as unknown);
      if (result.ok) {
        setTitle('');
        setWorkflow('');
        setMessage('Task created');
        onRefresh();
      } else {
        setMessage(safeString(result.error) ?? 'Failed to create task');
      }
    } catch {
      setMessage('Network error');
    } finally {
      setBusy(false);
    }
  }, [title, workflow, onRefresh]);

  const confirmTask = useCallback(
    async (taskId: string): Promise<void> => {
      if (confirmText !== `CONFIRM ${taskId}`) return;
      setBusy(true);
      try {
        const response = await fetch(`/api/goviral/tasks/${taskId}/confirm`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ confirmation: confirmText }),
        });
        const result = asRecord((await response.json()) as unknown);
        setMessage(result.ok ? 'Task confirmed' : (safeString(result.error) ?? 'Failed'));
        setConfirmingId(null);
        setConfirmText('');
        onRefresh();
      } catch {
        setMessage('Network error');
      } finally {
        setBusy(false);
      }
    },
    [confirmText, onRefresh]
  );

  const cancelTask = useCallback(
    async (taskId: string): Promise<void> => {
      setBusy(true);
      try {
        await fetch(`/api/goviral/tasks/${taskId}/cancel`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        });
        onRefresh();
      } catch {
        // silent
      } finally {
        setBusy(false);
      }
    },
    [onRefresh]
  );

  return (
    <Panel
      title="Agent Task Command Center"
      subtitle="Create, confirm, and track governed agent tasks"
    >
      {message ? (
        <div className="mb-3 rounded-lg border border-emerald-500/20 bg-emerald-500/5 px-3 py-2 text-xs text-emerald-300">
          {message}
        </div>
      ) : null}

      <div className="mb-4 grid gap-2 sm:grid-cols-[1fr_200px_auto]">
        <input
          value={title}
          onChange={(e): void => {
            setTitle(e.target.value);
          }}
          placeholder="Task description (3-200 chars)..."
          maxLength={200}
          className="rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-sm text-white outline-none placeholder:text-white/30 focus:border-fuchsia-500/40"
          aria-label="Task title"
        />
        <input
          value={workflow}
          onChange={(e): void => {
            setWorkflow(e.target.value);
          }}
          placeholder="Workflow name (optional)"
          maxLength={120}
          className="rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-sm text-white outline-none placeholder:text-white/30"
          aria-label="Workflow name"
        />
        <button
          type="button"
          disabled={busy || title.trim().length < 3}
          onClick={(): void => {
            void createTask();
          }}
          className="rounded-md border border-fuchsia-500/30 bg-fuchsia-500/10 px-3 py-2 text-sm font-medium text-fuchsia-200 disabled:opacity-35"
        >
          Create
        </button>
      </div>

      <div className="max-h-[400px] space-y-2 overflow-y-auto">
        {(data?.tasks ?? []).slice(0, 20).map(
          (task): ReactElement => (
            <div key={task.id} className="rounded-lg border border-white/10 bg-black/10 px-3 py-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-white/85">{task.title}</p>
                  <p className="mt-1 text-xs text-white/40">
                    {task.workflow ? `workflow: ${task.workflow} · ` : ''}
                    {task.created_by} · {formatDate(task.created_at)}
                  </p>
                  {task.result ? (
                    <p className="mt-1 truncate text-xs text-white/30">{task.result}</p>
                  ) : null}
                </div>
                <Pill value={task.status} />
              </div>
              {task.status === 'pending' ? (
                <div className="mt-2 flex gap-2">
                  {confirmingId === task.id ? (
                    <div className="flex items-center gap-2">
                      <input
                        value={confirmText}
                        onChange={(e): void => {
                          setConfirmText(e.target.value);
                        }}
                        placeholder={`CONFIRM ${task.id}`}
                        className="rounded border border-white/10 bg-black/20 px-2 py-1 text-xs text-white outline-none"
                        aria-label="Confirmation phrase"
                      />
                      <button
                        type="button"
                        disabled={busy || confirmText !== `CONFIRM ${task.id}`}
                        onClick={(): void => {
                          void confirmTask(task.id);
                        }}
                        className="rounded border border-fuchsia-500/30 bg-fuchsia-500/10 px-2 py-1 text-xs text-fuchsia-200 disabled:opacity-35"
                      >
                        Run
                      </button>
                    </div>
                  ) : (
                    <>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={(): void => {
                          setConfirmingId(task.id);
                          setConfirmText('');
                        }}
                        className="rounded border border-fuchsia-500/30 bg-fuchsia-500/10 px-2 py-1 text-xs text-fuchsia-200 disabled:opacity-35"
                      >
                        Confirm & Execute
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={(): void => {
                          void cancelTask(task.id);
                        }}
                        className="rounded border border-white/15 bg-white/5 px-2 py-1 text-xs text-white/50 disabled:opacity-35"
                      >
                        Cancel
                      </button>
                    </>
                  )}
                </div>
              ) : null}
            </div>
          )
        )}
        {data && (data.tasks?.length ?? 0) === 0 ? (
          <EmptyState text="No agent tasks created yet." />
        ) : null}
      </div>
    </Panel>
  );
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function safeString(value: unknown): string | null {
  if (typeof value === 'string') return value;
  return null;
}

// ─── Main Component ──────────────────────────────────────────────────────────

export function GoviralControlPlaneV2(): ReactElement {
  const [telegram, setTelegram] = useState<TelegramStatus | null>(null);
  const [attention, setAttention] = useState<AttentionData | null>(null);
  const [clickup, setClickup] = useState<IntegrationStatus | null>(null);
  const [qdrant, setQdrant] = useState<IntegrationStatus | null>(null);
  const [analytics, setAnalytics] = useState<AnalyticsRollup | null>(null);
  const [recovery, setRecovery] = useState<RecoveryStatus | null>(null);
  const [upgrade, setUpgrade] = useState<UpgradeStatus | null>(null);
  const [tasks, setTasks] = useState<TasksData | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const results = await Promise.allSettled([
      fetchJson<TelegramStatus>('/api/goviral/telegram'),
      fetchJson<AttentionData>('/api/goviral/attention'),
      fetchJson<IntegrationStatus>('/api/goviral/integrations/clickup'),
      fetchJson<IntegrationStatus>('/api/goviral/integrations/qdrant'),
      fetchJson<AnalyticsRollup>('/api/goviral/analytics'),
      fetchJson<RecoveryStatus>('/api/goviral/recovery'),
      fetchJson<UpgradeStatus>('/api/goviral/upgrade'),
      fetchJson<TasksData>('/api/goviral/tasks'),
    ]);

    const failures: string[] = [];
    if (results[0].status === 'fulfilled') setTelegram(results[0].value);
    else failures.push('telegram');
    if (results[1].status === 'fulfilled') setAttention(results[1].value);
    else failures.push('attention');
    if (results[2].status === 'fulfilled') setClickup(results[2].value);
    else failures.push('clickup');
    if (results[3].status === 'fulfilled') setQdrant(results[3].value);
    else failures.push('qdrant');
    if (results[4].status === 'fulfilled') setAnalytics(results[4].value);
    else failures.push('analytics');
    if (results[5].status === 'fulfilled') setRecovery(results[5].value);
    else failures.push('recovery');
    if (results[6].status === 'fulfilled') setUpgrade(results[6].value);
    else failures.push('upgrade');
    if (results[7].status === 'fulfilled') setTasks(results[7].value);
    else failures.push('tasks');

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

  const handleAck = useCallback(
    async (incidentId: string) => {
      try {
        await fetch('/api/goviral/attention/ack', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ incident_id: incidentId, acknowledged_by: 'operator' }),
        });
        await load();
      } catch {
        // Silently fail
      }
    },
    [load]
  );

  return (
    <div className="space-y-5">
      <div className="border-t border-white/10 pt-5">
        <div className="mb-4 flex items-center gap-2">
          <h2 className="text-lg font-semibold text-white">Control Plane v2</h2>
          <Pill value="v2" />
        </div>

        {error ? (
          <div className="mb-4 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
            {error}
          </div>
        ) : null}

        <div className="space-y-5">
          <AttentionPanel data={attention} onAck={handleAck} />
          <TelegramPanel data={telegram} />
          <SearchPanel />
          <AgentTaskPanel data={tasks} onRefresh={load} />

          <div className="grid gap-5 xl:grid-cols-2">
            <IntegrationsPanel clickup={clickup} qdrant={qdrant} />
            <AnalyticsPanel data={analytics} />
          </div>

          <div className="grid gap-5 xl:grid-cols-2">
            <RecoveryPanel data={recovery} />
            <UpgradePanel data={upgrade} />
          </div>
        </div>
      </div>
    </div>
  );
}
