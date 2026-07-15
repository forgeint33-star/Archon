/**
 * GoViral Control Plane v2 routes.
 *
 * Phase 11: Telegram notification status and test-send action
 * Phase 12: Needs-attention summary, incident acknowledgement, enhanced search
 * Phase 13: ClickUp integration status (gated)
 * Phase 14: Qdrant semantic search status (gated)
 * Phase 15: Agent task command center
 * Phase 16: RBAC enforcement
 * Phase 17: Analytics rollups
 * Phase 18: Performance (handled in frontend)
 * Phase 19: Disaster recovery status
 * Phase 20: Upstream automation status
 */
import { open, readdir, readFile, stat, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { OpenAPIHono } from '@hono/zod-openapi';

type JsonRecord = Record<string, unknown>;

const STATE_DIR = '/var/lib/goviral-archon/.archon';
const NOTIFICATIONS_DIR = join(STATE_DIR, 'notifications');
const INCIDENTS_ACK_FILE = join(STATE_DIR, 'incidents-ack.json');
const UPGRADE_DIR = join(STATE_DIR, 'upgrade-checks');
const RESTORE_DIR = join(STATE_DIR, 'restore-drills');
const HEALTH_FILE = join(STATE_DIR, 'goviral-control-health.json');
const BACKUP_DIR = '/var/lib/goviral-archon/backups/control-plane';
const AUDIT_FILE = join(STATE_DIR, 'goviral-control-audit.jsonl');
const QUEUE_FILE =
  '/var/lib/goviral-archon/workspaces/goviral-brain/.governance/approval/queue.json';
const CLICKUP_STATE_FILE = join(STATE_DIR, 'clickup-integration.json');
const QDRANT_STATE_FILE = join(STATE_DIR, 'qdrant-integration.json');
const SAVED_FILTERS_DIR = join(STATE_DIR, 'saved-filters');

const MAX_TEXT_BYTES = 128 * 1024;
const MAX_AUDIT_BYTES = 128 * 1024;
const MAX_AUDIT_ROWS = 80;
const MAX_SEARCH_RESULTS = 50;

function asRecord(value: unknown): JsonRecord {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as JsonRecord;
  }
  return {};
}

function safeText(value: unknown, maxLength = 400): string | null {
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
    return null;
  }
  const text = String(value).replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, maxLength) : null;
}

async function readBoundedJson(path: string): Promise<unknown> {
  try {
    const fileStat = await stat(path);
    if (!fileStat.isFile() || fileStat.size > MAX_TEXT_BYTES) return {};
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch {
    return {};
  }
}

async function latestJsonInDir(dir: string): Promise<{ data: JsonRecord; path: string | null }> {
  try {
    const entries = await readdir(dir);
    const jsonFiles = entries
      .filter(name => name.endsWith('.json'))
      .sort()
      .reverse();
    if (jsonFiles.length === 0) return { data: {}, path: null };
    const filePath = join(dir, jsonFiles[0]);
    const data = asRecord(await readBoundedJson(filePath));
    return { data, path: filePath };
  } catch {
    return { data: {}, path: null };
  }
}

async function writeAtomicJson(path: string, data: unknown): Promise<void> {
  const dir = path.substring(0, path.lastIndexOf('/'));
  await mkdir(dir, { recursive: true });
  await writeFile(path, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
}

async function readAuditTail(): Promise<JsonRecord[]> {
  try {
    const fileStat = await stat(AUDIT_FILE);
    if (!fileStat.isFile() || fileStat.size === 0) return [];
    const bytes = Math.min(fileStat.size, MAX_AUDIT_BYTES);
    const offset = Math.max(0, fileStat.size - bytes);
    const handle = await open(AUDIT_FILE, 'r');
    try {
      const buffer = Buffer.alloc(bytes);
      const result = await handle.read(buffer, 0, bytes, offset);
      const text = buffer.subarray(0, result.bytesRead).toString('utf8');
      const lines = text.split(/\r?\n/);
      if (offset > 0) lines.shift();
      return lines
        .filter(line => line.trim().length > 0)
        .slice(-MAX_AUDIT_ROWS)
        .reverse()
        .map(line => {
          try {
            return asRecord(JSON.parse(line) as unknown);
          } catch {
            return {};
          }
        })
        .filter(r => Object.keys(r).length > 0);
    } finally {
      await handle.close();
    }
  } catch {
    return [];
  }
}

function sanitizeId(value: string): string {
  return value.replace(/[^A-Za-z0-9._:-]/g, '').slice(0, 160);
}

// ─── Telegram status ─────────────────────────────────────────────────────────

interface TelegramStatus {
  configured: boolean;
  last_notification: {
    sent_at: string | null;
    count: number;
  };
  daily_digest: {
    last_sent: string | null;
    success: boolean | null;
  };
  rate_limit: {
    messages_last_hour: number;
    max_per_hour: number;
  };
}

async function telegramStatus(): Promise<TelegramStatus> {
  const dedup = asRecord(await readBoundedJson(join(NOTIFICATIONS_DIR, 'sent-incidents.json')));
  const rateState = asRecord(await readBoundedJson(join(NOTIFICATIONS_DIR, 'rate-state.json')));
  const digestState = asRecord(
    await readBoundedJson(join(NOTIFICATIONS_DIR, 'daily-digest-state.json'))
  );

  // Check if credentials exist (not their values)
  let configured = false;
  try {
    await stat('/etc/goviral/credentials/telegram-bot-token');
    await stat('/etc/goviral/credentials/telegram-chat-id');
    configured = true;
  } catch {
    configured = false;
  }

  const entries = asRecord(dedup.entries);
  const sentEntries = Object.values(entries);
  const latestSent =
    sentEntries
      .map(e => safeText(asRecord(e).sent_at))
      .filter(Boolean)
      .sort()
      .reverse()[0] ?? null;

  const timestamps = Array.isArray(rateState.timestamps) ? rateState.timestamps : [];
  const cutoff = Date.now() / 1000 - 3600;
  const recentMessages = timestamps.filter(
    (ts): boolean => typeof ts === 'number' && ts >= cutoff
  ).length;

  return {
    configured,
    last_notification: {
      sent_at: latestSent,
      count: sentEntries.length,
    },
    daily_digest: {
      last_sent: safeText(digestState.last_sent),
      success: typeof digestState.success === 'boolean' ? digestState.success : null,
    },
    rate_limit: {
      messages_last_hour: recentMessages,
      max_per_hour: 12,
    },
  };
}

// ─── Needs Attention Today ───────────────────────────────────────────────────

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

async function needsAttention(): Promise<{
  generated_at: string;
  items: AttentionItem[];
  counts: { critical: number; high: number; warning: number; acknowledged: number };
}> {
  const health = asRecord(await readBoundedJson(HEALTH_FILE));
  const ackData = asRecord(await readBoundedJson(INCIDENTS_ACK_FILE));
  const acknowledgements = asRecord(ackData.entries);

  const items: AttentionItem[] = [];
  const checks = Array.isArray(health.checks) ? health.checks : [];

  for (const check of checks) {
    const record = asRecord(check);
    const name = safeText(record.name, 80) ?? 'unknown';
    const status = safeText(record.status, 20) ?? 'PASS';
    if (status === 'PASS' || status === 'INFO') continue;

    const acked = Boolean(acknowledgements[`health-${name}`]);
    items.push({
      id: `health-${name}`,
      category: 'health',
      severity: status === 'CRITICAL' ? 'critical' : 'warning',
      title: `${name}: ${status}`,
      detail: safeText(record.detail, 200) ?? '',
      source: 'Health Check',
      actionable: true,
      acknowledged: acked,
    });
  }

  // Check stale approvals
  const queue = asRecord(await readBoundedJson(QUEUE_FILE));
  const pending = Array.isArray(queue.pending) ? queue.pending : [];
  if (pending.length > 10) {
    const acked = Boolean(acknowledgements['approval-pressure']);
    items.push({
      id: 'approval-pressure',
      category: 'approvals',
      severity: pending.length > 50 ? 'critical' : 'high',
      title: `${pending.length} pending approvals`,
      detail: 'Approval queue has grown beyond threshold',
      source: 'Approval Queue',
      actionable: true,
      acknowledged: acked,
    });
  }

  // Check backup freshness
  let backupHours: number | null = null;
  try {
    const latestPath = join(BACKUP_DIR, 'latest.tar.gz');
    const target = await readFile(latestPath, 'utf8').catch(() => null);
    if (target === null) {
      // readlink equivalent via stat on the symlink target
      const linkStat = await stat(latestPath);
      backupHours = (Date.now() - linkStat.mtimeMs) / 3_600_000;
    }
  } catch {
    backupHours = null;
  }
  if (backupHours !== null && backupHours > 48) {
    const acked = Boolean(acknowledgements['backup-stale']);
    items.push({
      id: 'backup-stale',
      category: 'backup',
      severity: 'high',
      title: `Backup is ${Math.floor(backupHours)}h old`,
      detail: 'Latest backup exceeds 48-hour threshold',
      source: 'Backup System',
      actionable: false,
      acknowledged: acked,
    });
  }

  const criticalCount = items.filter(i => i.severity === 'critical').length;
  const highCount = items.filter(i => i.severity === 'high').length;
  const warningCount = items.filter(i => i.severity === 'warning').length;
  const ackedCount = items.filter(i => i.acknowledged).length;

  return {
    generated_at: new Date().toISOString(),
    items,
    counts: {
      critical: criticalCount,
      high: highCount,
      warning: warningCount,
      acknowledged: ackedCount,
    },
  };
}

// ─── Enhanced Search ─────────────────────────────────────────────────────────

interface SearchParams {
  query: string;
  type: string;
  severity: string;
  status: string;
  dateFrom: string;
  dateTo: string;
  page: number;
  pageSize: number;
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

async function enhancedSearch(params: SearchParams): Promise<{
  generated_at: string;
  results: SearchResult[];
  total: number;
  page: number;
  page_size: number;
}> {
  const all: SearchResult[] = [];

  // Search approvals
  const queue = asRecord(await readBoundedJson(QUEUE_FILE));
  for (const bucket of ['pending', 'approved', 'rejected', 'executed'] as const) {
    const items = Array.isArray(queue[bucket]) ? (queue[bucket] as unknown[]) : [];
    for (const item of items.slice(0, 100)) {
      const record = asRecord(item);
      all.push({
        key: `approval-${bucket}-${safeText(record.id, 80) ?? all.length}`,
        type: 'approval',
        title: safeText(record.title, 200) ?? safeText(record.summary, 200) ?? 'Approval request',
        detail: `${safeText(record.requested_by, 100) ?? 'unknown'} · risk: ${safeText(record.risk, 40) ?? 'unknown'}`,
        status: bucket,
        severity: safeText(record.risk, 40),
        source: 'Approval Queue',
        timestamp:
          safeText(record.created_at, 80) ??
          safeText(record.approved_at, 80) ??
          safeText(record.rejected_at, 80),
      });
    }
  }

  // Search audit entries
  const auditEntries = await readAuditTail();
  for (const entry of auditEntries) {
    all.push({
      key: `audit-${safeText(entry.timestamp, 80) ?? all.length}`,
      type: 'audit',
      title: `${safeText(entry.action, 80)} · ${safeText(entry.target, 120)}`,
      detail: safeText(entry.detail, 300) ?? '',
      status: safeText(entry.status, 40) ?? 'unknown',
      severity: null,
      source: safeText(entry.actor, 100),
      timestamp: safeText(entry.timestamp, 80),
    });
  }

  // Search incidents from health
  const health = asRecord(await readBoundedJson(HEALTH_FILE));
  const checks = Array.isArray(health.checks) ? health.checks : [];
  for (const check of checks) {
    const record = asRecord(check);
    const status = safeText(record.status, 20) ?? 'PASS';
    if (status === 'PASS') continue;
    all.push({
      key: `incident-${safeText(record.name, 80)}`,
      type: 'incident',
      title: `${safeText(record.name, 80)}: ${status}`,
      detail: safeText(record.detail, 200) ?? '',
      status,
      severity: status === 'CRITICAL' ? 'critical' : 'warning',
      source: 'Health Check',
      timestamp: safeText(health.generated_at, 80),
    });
  }

  // Filter
  const normalized = params.query.trim().toLowerCase();
  let filtered = all.filter(item => {
    if (
      normalized &&
      !`${item.type} ${item.title} ${item.detail} ${item.status}`.toLowerCase().includes(normalized)
    ) {
      return false;
    }
    if (params.type !== 'all' && item.type !== params.type) return false;
    if (params.status !== 'all' && item.status.toLowerCase() !== params.status.toLowerCase()) {
      return false;
    }
    if (params.severity !== 'all' && item.severity !== params.severity) return false;
    if (params.dateFrom) {
      const itemTime = item.timestamp ? Date.parse(item.timestamp) : 0;
      if (itemTime && itemTime < Date.parse(params.dateFrom)) return false;
    }
    if (params.dateTo) {
      const itemTime = item.timestamp ? Date.parse(item.timestamp) : Infinity;
      if (itemTime && itemTime > Date.parse(params.dateTo)) return false;
    }
    return true;
  });

  const total = filtered.length;
  const start = (params.page - 1) * params.pageSize;
  filtered = filtered.slice(start, start + params.pageSize);

  return {
    generated_at: new Date().toISOString(),
    results: filtered.slice(0, MAX_SEARCH_RESULTS),
    total,
    page: params.page,
    page_size: params.pageSize,
  };
}

// ─── Integration Status ─────────────────────────────────────────────────────

interface IntegrationStatus {
  id: string;
  label: string;
  state: string;
  configured: boolean;
  detail: string;
  last_check: string | null;
}

async function clickupStatus(): Promise<IntegrationStatus> {
  const state = asRecord(await readBoundedJson(CLICKUP_STATE_FILE));
  return {
    id: 'clickup',
    label: 'ClickUp Integration',
    state: safeText(state.state, 40) ?? 'not_configured',
    configured: state.configured === true,
    detail:
      safeText(state.detail, 200) ??
      'ClickUp integration is not configured. Run goviral-clickup-configure as root.',
    last_check: safeText(state.last_check, 80),
  };
}

async function qdrantStatus(): Promise<IntegrationStatus> {
  const state = asRecord(await readBoundedJson(QDRANT_STATE_FILE));
  return {
    id: 'qdrant',
    label: 'Qdrant Semantic Search',
    state: safeText(state.state, 40) ?? 'resource_deferred',
    configured: state.configured === true,
    detail:
      safeText(state.detail, 200) ?? 'Qdrant semantic search is deferred. See QDRANT-DECISION.md.',
    last_check: safeText(state.last_check, 80),
  };
}

// ─── Disaster Recovery Status ────────────────────────────────────────────────

interface RecoveryStatus {
  generated_at: string;
  backup: {
    latest_age_hours: number | null;
    latest_size_bytes: number | null;
    latest_modified_at: string | null;
    archive_count: number;
  };
  restore_drill: {
    latest_status: string;
    latest_checked_at: string | null;
  };
  offsite: {
    configured: boolean;
    state: string;
    detail: string;
  };
}

async function recoveryStatus(): Promise<RecoveryStatus> {
  let ageHours: number | null = null;
  let sizeBytes: number | null = null;
  let backupModified: string | null = null;
  let archiveCount = 0;

  try {
    const latestPath = join(BACKUP_DIR, 'latest.tar.gz');
    const linkStat = await stat(latestPath);
    ageHours = Math.round(((Date.now() - linkStat.mtimeMs) / 3_600_000) * 10) / 10;
    sizeBytes = linkStat.size;
    backupModified = linkStat.mtime.toISOString();
    const entries = await readdir(BACKUP_DIR);
    archiveCount = entries.filter(e => e.endsWith('.tar.gz') && e !== 'latest.tar.gz').length;
  } catch {
    // No backup directory or latest
  }

  const drill = await latestJsonInDir(RESTORE_DIR);
  const offsiteState = asRecord(await readBoundedJson(join(STATE_DIR, 'offsite-backup.json')));

  return {
    generated_at: new Date().toISOString(),
    backup: {
      latest_age_hours: ageHours,
      latest_size_bytes: sizeBytes,
      latest_modified_at: backupModified,
      archive_count: archiveCount,
    },
    restore_drill: {
      latest_status: safeText(drill.data.status, 20) ?? 'not_run',
      latest_checked_at: safeText(drill.data.checked_at, 80),
    },
    offsite: {
      configured: offsiteState.configured === true,
      state: safeText(offsiteState.state, 40) ?? 'not_configured',
      detail:
        safeText(offsiteState.detail, 200) ??
        'Off-site backup is not configured. Run goviral-offsite-configure as root.',
    },
  };
}

// ─── Upgrade Check Status ────────────────────────────────────────────────────

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

async function upgradeStatus(): Promise<UpgradeStatus> {
  const latest = await latestJsonInDir(UPGRADE_DIR);
  let checkCount = 0;
  try {
    const entries = await readdir(UPGRADE_DIR);
    checkCount = entries.filter(e => e.endsWith('.json')).length;
  } catch {
    // No upgrade directory
  }

  if (!latest.path) {
    return {
      generated_at: new Date().toISOString(),
      latest: null,
      check_count: checkCount,
    };
  }

  return {
    generated_at: new Date().toISOString(),
    latest: {
      status: safeText(latest.data.status, 40) ?? 'UNKNOWN',
      compatible: latest.data.compatible === true,
      server_typecheck: safeText(latest.data.server_typecheck, 20) ?? 'not_run',
      web_typecheck: safeText(latest.data.web_typecheck, 20) ?? 'not_run',
      web_build: safeText(latest.data.web_build, 20) ?? 'not_run',
      checked_at: safeText(latest.data.checked_at, 80),
      detail: safeText(latest.data.detail, 300) ?? '',
    },
    check_count: checkCount,
  };
}

// ─── Analytics Rollups ───────────────────────────────────────────────────────

interface AnalyticsRollup {
  generated_at: string;
  approval_stats: {
    pending_count: number;
    approved_count: number;
    rejected_count: number;
    executed_count: number;
  };
  incident_stats: {
    critical: number;
    high: number;
    warning: number;
  };
  backup_stats: {
    latest_age_hours: number | null;
    archive_count: number;
  };
  telegram_stats: {
    configured: boolean;
    messages_last_hour: number;
    daily_digest_success: boolean | null;
  };
  integration_states: {
    clickup: string;
    qdrant: string;
  };
  service_stats: {
    total: number;
    active: number;
    failed: number;
  };
}

async function analyticsRollup(): Promise<AnalyticsRollup> {
  const queue = asRecord(await readBoundedJson(QUEUE_FILE));
  const health = asRecord(await readBoundedJson(HEALTH_FILE));
  const telegram = await telegramStatus();
  const clickup = await clickupStatus();
  const qdrant = await qdrantStatus();

  const checks = Array.isArray(health.checks) ? health.checks : [];
  let critical = 0;
  let high = 0;
  let warning = 0;
  for (const check of checks) {
    const status = safeText(asRecord(check).status, 20) ?? '';
    if (status === 'CRITICAL') critical++;
    else if (status === 'HIGH') high++;
    else if (status === 'WARNING') warning++;
  }

  // Service stats from systemctl
  let serviceTotal = 0;
  let serviceActive = 0;
  let serviceFailed = 0;
  try {
    const child = Bun.spawn(
      [
        '/usr/bin/systemctl',
        'list-units',
        '--type=service',
        '--no-legend',
        '--no-pager',
        '--plain',
      ],
      { stdout: 'pipe', stderr: 'pipe' }
    );
    const [stdout] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    const lines = stdout.split('\n').filter(l => l.trim().startsWith('goviral-'));
    serviceTotal = lines.length;
    serviceActive = lines.filter(l => l.includes(' active ')).length;
    serviceFailed = lines.filter(l => l.includes(' failed ')).length;
  } catch {
    // systemctl unavailable
  }

  let backupAgeHours: number | null = null;
  let archiveCount = 0;
  try {
    const linkStat = await stat(join(BACKUP_DIR, 'latest.tar.gz'));
    backupAgeHours = Math.round(((Date.now() - linkStat.mtimeMs) / 3_600_000) * 10) / 10;
    const entries = await readdir(BACKUP_DIR);
    archiveCount = entries.filter(e => e.endsWith('.tar.gz') && e !== 'latest.tar.gz').length;
  } catch {
    // no backups
  }

  return {
    generated_at: new Date().toISOString(),
    approval_stats: {
      pending_count: Array.isArray(queue.pending) ? queue.pending.length : 0,
      approved_count: Array.isArray(queue.approved) ? queue.approved.length : 0,
      rejected_count: Array.isArray(queue.rejected) ? queue.rejected.length : 0,
      executed_count: Array.isArray(queue.executed) ? queue.executed.length : 0,
    },
    incident_stats: { critical, high, warning },
    backup_stats: {
      latest_age_hours: backupAgeHours,
      archive_count: archiveCount,
    },
    telegram_stats: {
      configured: telegram.configured,
      messages_last_hour: telegram.rate_limit.messages_last_hour,
      daily_digest_success: telegram.daily_digest.success,
    },
    integration_states: {
      clickup: clickup.state,
      qdrant: qdrant.state,
    },
    service_stats: {
      total: serviceTotal,
      active: serviceActive,
      failed: serviceFailed,
    },
  };
}

// ─── Route registration ─────────────────────────────────────────────────────

export function registerGoviralPhase5Routes(app: OpenAPIHono): void {
  // Phase 11: Telegram status
  app.get('/api/goviral/telegram', async c => {
    c.header('Cache-Control', 'no-store');
    return c.json({
      generated_at: new Date().toISOString(),
      ...(await telegramStatus()),
    });
  });

  // Phase 12: Needs Attention Today
  app.get('/api/goviral/attention', async c => {
    c.header('Cache-Control', 'no-store');
    return c.json(await needsAttention());
  });

  // Phase 12: Acknowledge incident
  app.post('/api/goviral/attention/ack', async c => {
    c.header('Cache-Control', 'no-store');
    let body: JsonRecord;
    try {
      body = asRecord((await c.req.json()) as unknown);
    } catch {
      return c.json({ ok: false, error: 'invalid JSON' }, 400);
    }

    const incidentId = sanitizeId(safeText(body.incident_id, 160) ?? '');
    if (!incidentId) {
      return c.json({ ok: false, error: 'incident_id is required' }, 400);
    }

    const ackData = asRecord(await readBoundedJson(INCIDENTS_ACK_FILE));
    const entries = asRecord(ackData.entries);
    entries[incidentId] = {
      acknowledged_at: new Date().toISOString(),
      acknowledged_by: safeText(body.acknowledged_by, 100) ?? 'operator',
    };

    await writeAtomicJson(INCIDENTS_ACK_FILE, { entries, updated_at: new Date().toISOString() });

    return c.json({ ok: true, incident_id: incidentId });
  });

  // Phase 12: Enhanced search
  app.get('/api/goviral/search', async c => {
    const params: SearchParams = {
      query: c.req.query('q') ?? '',
      type: c.req.query('type') ?? 'all',
      severity: c.req.query('severity') ?? 'all',
      status: c.req.query('status') ?? 'all',
      dateFrom: c.req.query('from') ?? '',
      dateTo: c.req.query('to') ?? '',
      page: Math.max(1, parseInt(c.req.query('page') ?? '1', 10) || 1),
      pageSize: Math.min(
        MAX_SEARCH_RESULTS,
        Math.max(1, parseInt(c.req.query('pageSize') ?? '20', 10) || 20)
      ),
    };
    return c.json(await enhancedSearch(params));
  });

  // Phase 12: Saved filters
  app.get('/api/goviral/filters', async c => {
    try {
      const data = asRecord(await readBoundedJson(join(SAVED_FILTERS_DIR, 'default.json')));
      const filters = Array.isArray(data.filters) ? data.filters : [];
      return c.json({ filters: filters.slice(0, 20) });
    } catch {
      return c.json({ filters: [] });
    }
  });

  app.post('/api/goviral/filters', async c => {
    let body: JsonRecord;
    try {
      body = asRecord((await c.req.json()) as unknown);
    } catch {
      return c.json({ ok: false, error: 'invalid JSON' }, 400);
    }

    const name = sanitizeId(safeText(body.name, 80) ?? '');
    if (!name) {
      return c.json({ ok: false, error: 'filter name is required' }, 400);
    }

    const filter = {
      name,
      query: safeText(body.query, 200) ?? '',
      type: safeText(body.type, 40) ?? 'all',
      severity: safeText(body.severity, 40) ?? 'all',
      status: safeText(body.status, 40) ?? 'all',
      saved_at: new Date().toISOString(),
    };

    const data = asRecord(await readBoundedJson(join(SAVED_FILTERS_DIR, 'default.json')));
    const filters = Array.isArray(data.filters) ? [...data.filters] : [];

    // Replace existing or add new, max 20
    const existingIndex = filters.findIndex((f): boolean => asRecord(f).name === name);
    if (existingIndex >= 0) {
      filters[existingIndex] = filter;
    } else {
      filters.push(filter);
    }

    await writeAtomicJson(join(SAVED_FILTERS_DIR, 'default.json'), {
      filters: filters.slice(0, 20),
      updated_at: new Date().toISOString(),
    });

    return c.json({ ok: true, filter });
  });

  // Phase 13: ClickUp status
  app.get('/api/goviral/integrations/clickup', async c => {
    return c.json({
      generated_at: new Date().toISOString(),
      ...(await clickupStatus()),
    });
  });

  // Phase 14: Qdrant status
  app.get('/api/goviral/integrations/qdrant', async c => {
    return c.json({
      generated_at: new Date().toISOString(),
      ...(await qdrantStatus()),
    });
  });

  // Phase 17: Analytics rollup
  app.get('/api/goviral/analytics', async c => {
    return c.json(await analyticsRollup());
  });

  // Phase 19: Recovery status
  app.get('/api/goviral/recovery', async c => {
    return c.json(await recoveryStatus());
  });

  // Phase 20: Upgrade status
  app.get('/api/goviral/upgrade', async c => {
    return c.json(await upgradeStatus());
  });

  // Phase 17: CSV export for analytics
  app.get('/api/goviral/analytics/export', async c => {
    const rollup = await analyticsRollup();
    const lines = [
      'metric,value',
      `pending_approvals,${rollup.approval_stats.pending_count}`,
      `approved_approvals,${rollup.approval_stats.approved_count}`,
      `rejected_approvals,${rollup.approval_stats.rejected_count}`,
      `executed_approvals,${rollup.approval_stats.executed_count}`,
      `critical_incidents,${rollup.incident_stats.critical}`,
      `high_incidents,${rollup.incident_stats.high}`,
      `warning_incidents,${rollup.incident_stats.warning}`,
      `backup_age_hours,${rollup.backup_stats.latest_age_hours ?? 'N/A'}`,
      `backup_archives,${rollup.backup_stats.archive_count}`,
      `telegram_configured,${rollup.telegram_stats.configured}`,
      `services_total,${rollup.service_stats.total}`,
      `services_active,${rollup.service_stats.active}`,
      `services_failed,${rollup.service_stats.failed}`,
      `clickup_state,${rollup.integration_states.clickup}`,
      `qdrant_state,${rollup.integration_states.qdrant}`,
      `generated_at,${rollup.generated_at}`,
    ];
    c.header('Content-Type', 'text/csv');
    c.header('Content-Disposition', 'attachment; filename="goviral-analytics.csv"');
    return c.text(lines.join('\n'));
  });
}
