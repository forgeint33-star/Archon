/**
 * GoViral Control Plane v3 — Phase 8
 *
 * Operations Analytics, Health, and Safe Actions
 *
 * Bounded, incremental, non-recursive analytics collection.
 * Safe allowlisted operations with RBAC, CSRF, rate limiting, audit trail.
 * No raw prompts, secrets, memory contents, or private payloads.
 */

import { readdir, readFile, stat, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { OpenAPIHono } from '@hono/zod-openapi';
import {
  getBrainSnapshot,
  getSnapshotCacheStatus,
  refreshBrainSnapshot,
  type BrainSnapshot,
} from './goviral-brain-snapshot';
import { readUpgradeStatus, type UpgradeStatusResponse } from './goviral-phase7-upgrade';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type JsonRecord = Record<string, unknown>;

type GoviralRole = 'viewer' | 'operator' | 'admin';

type SafeActionTarget =
  | 'refresh_brain_snapshot'
  | 'run_health_check'
  | 'run_analytics_rollup'
  | 'run_backup'
  | 'run_restore_drill'
  | 'run_upstream_check'
  | 'test_telegram'
  | 'clear_safe_caches';

interface ActionResult {
  ok: boolean;
  action: SafeActionTarget;
  correlation_id: string;
  started_at: string;
  completed_at: string;
  detail: string;
  error: string | null;
}

interface SecurityServiceState {
  name: string;
  installed: boolean;
  enabled: boolean;
  active: boolean;
  healthy: boolean;
  last_check: string | null;
  detail: string;
}

interface QdrantObservedState {
  service_detected: boolean;
  container_detected: boolean;
  api_reachable: boolean;
  collections: number | null;
  provenance: string;
  control_plane_enabled: boolean;
}

export interface AnalyticsSnapshot {
  generated_at: string;
  schema_version: number;
  agents: {
    registered: number;
    enabled: number;
    disabled: number;
    active_runs: number;
    runs_today: number;
    completed_today: number;
    failed_today: number;
    cancelled_today: number;
  };
  workflows: {
    duration_avg_ms: number | null;
    overlap_skipped_total: number;
    overlap_skipped_rate: string;
  };
  approvals: {
    pending: number;
    approved: number;
    rejected: number;
    executed: number;
  };
  incidents: {
    critical: number;
    high: number;
    warning: number;
    by_status: JsonRecord;
  };
  backup: {
    age_hours: number | null;
    archive_count: number;
    restore_drill_status: string;
  };
  upstream: {
    status: string;
    compatible: boolean;
    production_modified: boolean;
    checked_at: string | null;
  };
  telegram: {
    framework_installed: boolean;
    credentials_configured: boolean;
    delivery_status: string | null;
  };
  clickup: {
    current_mode: string;
    writes_enabled: boolean;
  };
  qdrant: QdrantObservedState;
  security: SecurityServiceState[];
  brain: {
    health: string | null;
    source_freshness: string | null;
    partial_failures: string[];
    schema_version: number | null;
  };
  retention: {
    max_snapshots: number;
    retention_days: number;
  };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STATE_DIR = process.env.GOVIRAL_STATE_DIR ?? '/var/lib/goviral-archon/.archon';
const ANALYTICS_DIR = join(STATE_DIR, 'analytics');
const BACKUP_DIR = '/var/lib/goviral-archon/backups/control-plane';
const RESTORE_DIR = join(STATE_DIR, 'restore-drills');
const HEALTH_FILE = join(STATE_DIR, 'goviral-control-health.json');
const QUEUE_FILE =
  '/var/lib/goviral-archon/workspaces/goviral-brain/.governance/approval/queue.json';
const AUDIT_FILE = join(STATE_DIR, 'analytics-audit.jsonl');
const OVERLAP_LOG = join(STATE_DIR, 'overlap-events.jsonl');

const MAX_TEXT_BYTES = 128 * 1024;
const MAX_SNAPSHOTS = 720; // ~30 days at hourly rollups
const RETENTION_DAYS = 30;
const MAX_CSV_ROWS = 5000;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 6;

const SAFE_ACTIONS: SafeActionTarget[] = [
  'refresh_brain_snapshot',
  'run_health_check',
  'run_analytics_rollup',
  'run_backup',
  'run_restore_drill',
  'run_upstream_check',
  'test_telegram',
  'clear_safe_caches',
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function asRecord(value: unknown): JsonRecord {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as JsonRecord;
  }
  return {};
}

function safeStr(value: unknown, maxLength = 400): string | null {
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

function generateCorrelationId(): string {
  return `gva-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// ---------------------------------------------------------------------------
// RBAC (same as phase5 for consistency)
// ---------------------------------------------------------------------------

function resolveGoviralRole(headers: Headers): GoviralRole {
  const archonUser = safeStr(headers.get('x-archon-user'), 160);
  const tailscaleUser = safeStr(headers.get('tailscale-user-login'), 160);
  if (archonUser || tailscaleUser) return 'admin';
  if (process.env.GOVIRAL_ACTIONS_ENABLED === '1') return 'operator';
  return 'viewer';
}

function requireRole(role: GoviralRole, minimum: GoviralRole): boolean {
  const rank: Record<GoviralRole, number> = { viewer: 0, operator: 1, admin: 2 };
  return rank[role] >= rank[minimum];
}

function roleGate(
  headers: Headers,
  minimum: GoviralRole
): { allowed: true; role: GoviralRole; identity: string } | { allowed: false; role: GoviralRole } {
  const role = resolveGoviralRole(headers);
  if (!requireRole(role, minimum)) return { allowed: false, role };
  const identity =
    safeStr(headers.get('tailscale-user-login'), 160) ??
    safeStr(headers.get('x-archon-user'), 160) ??
    'tailnet-client';
  return { allowed: true, role, identity };
}

// ---------------------------------------------------------------------------
// CSRF Token (simple per-session token)
// ---------------------------------------------------------------------------

let csrfToken: string | null = null;

function getOrCreateCsrfToken(): string {
  if (!csrfToken) {
    csrfToken = `csrf-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  }
  return csrfToken;
}

function validateCsrf(headers: Headers): boolean {
  if (!csrfToken) return false;
  const provided = headers.get('x-goviral-csrf');
  return provided === csrfToken;
}

// ---------------------------------------------------------------------------
// Rate limiter
// ---------------------------------------------------------------------------

const actionTimestamps: number[] = [];

function checkRateLimit(): boolean {
  const now = Date.now();
  // Remove expired entries
  while (actionTimestamps.length > 0 && actionTimestamps[0] < now - RATE_LIMIT_WINDOW_MS) {
    actionTimestamps.shift();
  }
  return actionTimestamps.length < RATE_LIMIT_MAX;
}

function recordAction(): void {
  actionTimestamps.push(Date.now());
}

// ---------------------------------------------------------------------------
// Audit trail
// ---------------------------------------------------------------------------

async function appendAudit(record: JsonRecord): Promise<void> {
  try {
    const dir = AUDIT_FILE.substring(0, AUDIT_FILE.lastIndexOf('/'));
    await mkdir(dir, { recursive: true });
    const line = JSON.stringify({ timestamp: new Date().toISOString(), ...record }) + '\n';
    await writeFile(AUDIT_FILE, line, { flag: 'a', mode: 0o600 });
  } catch {
    // Audit write failure is non-fatal
  }
}

// ---------------------------------------------------------------------------
// Origin check (loopback + tailscale only)
// ---------------------------------------------------------------------------

function validateOrigin(headers: Headers): boolean {
  const origin = headers.get('origin') ?? '';
  const host = headers.get('host') ?? '';

  // Allow: no origin (non-browser), localhost, 127.0.0.1, tailscale IPs
  if (!origin) return true;

  const allowed = [
    'http://127.0.0.1',
    'https://127.0.0.1',
    'http://localhost',
    'https://localhost',
  ];

  for (const prefix of allowed) {
    if (origin.startsWith(prefix)) return true;
  }

  // Tailscale domains
  if (origin.includes('.ts.net') || origin.includes('tailscale')) return true;

  // Same-origin
  if (host && origin.includes(host)) return true;

  return false;
}

// ---------------------------------------------------------------------------
// Security service observation
// ---------------------------------------------------------------------------

async function observeSecurityServices(): Promise<SecurityServiceState[]> {
  const services = [
    { name: 'crowdsec', unit: 'crowdsec', healthCmd: null as string[] | null },
    {
      name: 'crowdsec-firewall-bouncer',
      unit: 'crowdsec-firewall-bouncer-nftables',
      healthCmd: null,
    },
    { name: 'cloudflared', unit: 'cloudflared', healthCmd: null },
    { name: 'monarx', unit: 'monarx', healthCmd: null },
    { name: 'fail2ban', unit: 'fail2ban', healthCmd: null },
    {
      name: 'tailscale',
      unit: 'tailscaled',
      healthCmd: ['/usr/bin/tailscale', 'status', '--json'],
    },
    { name: 'ssh', unit: 'ssh', healthCmd: null },
  ];

  const results: SecurityServiceState[] = [];

  for (const svc of services) {
    let installed = false;
    let enabled = false;
    let active = false;
    let healthy = false;
    let lastCheck: string | null = null;
    let detail = 'not_detected';

    try {
      const child = Bun.spawn(
        [
          '/usr/bin/systemctl',
          'show',
          `${svc.unit}.service`,
          '--property=ActiveState,UnitFileState,LoadState',
        ],
        { stdout: 'pipe', stderr: 'pipe' }
      );
      const [stdout, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        child.exited,
      ]);

      if (exitCode === 0) {
        const props: Record<string, string> = {};
        for (const line of stdout.split('\n')) {
          const [key, ...rest] = line.split('=');
          if (key && rest.length > 0) props[key.trim()] = rest.join('=').trim();
        }

        installed = props.LoadState !== 'not-found';
        enabled = props.UnitFileState === 'enabled';
        active = props.ActiveState === 'active';
        healthy = active;
        detail = active ? 'active' : installed ? 'inactive' : 'not_installed';
      }
    } catch {
      // systemctl unavailable
    }

    // Special health check for crowdsec LAPI
    if (svc.name === 'crowdsec' && active) {
      try {
        const child = Bun.spawn(['/usr/bin/cscli', 'lapi', 'status', '-o', 'raw'], {
          stdout: 'pipe',
          stderr: 'pipe',
        });
        const [, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited]);
        healthy = exitCode === 0;
        detail = healthy ? 'active_lapi_healthy' : 'active_lapi_unhealthy';
      } catch {
        // cscli not available
      }
    }

    // Special health check for tailscale
    if (svc.name === 'tailscale' && active && svc.healthCmd) {
      try {
        const child = Bun.spawn(svc.healthCmd, { stdout: 'pipe', stderr: 'pipe' });
        const [stdout, exitCode] = await Promise.all([
          new Response(child.stdout).text(),
          child.exited,
        ]);
        if (exitCode === 0) {
          const status = asRecord(JSON.parse(stdout) as unknown);
          healthy = typeof status.Self === 'object' && status.Self !== null;
          detail = healthy ? 'active_connected' : 'active_disconnected';
        }
      } catch {
        // tailscale not available
      }
    }

    lastCheck = new Date().toISOString();
    results.push({
      name: svc.name,
      installed,
      enabled,
      active,
      healthy,
      last_check: lastCheck,
      detail,
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Qdrant observation (dynamic, no changes)
// ---------------------------------------------------------------------------

async function observeQdrant(): Promise<QdrantObservedState> {
  let serviceDetected = false;
  let containerDetected = false;
  let apiReachable = false;
  let collections: number | null = null;
  let provenance = 'not_detected';

  // Check systemd service
  try {
    const child = Bun.spawn(
      ['/usr/bin/systemctl', 'show', 'qdrant.service', '--property=ActiveState,LoadState'],
      { stdout: 'pipe', stderr: 'pipe' }
    );
    const [stdout, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    if (exitCode === 0) {
      serviceDetected = stdout.includes('ActiveState=active');
      if (serviceDetected) provenance = 'systemd_service';
    }
  } catch {
    // systemctl unavailable
  }

  // Check docker/podman container
  if (!serviceDetected) {
    for (const runtime of ['docker', 'podman']) {
      try {
        const child = Bun.spawn(
          [`/usr/bin/${runtime}`, 'ps', '--filter', 'name=qdrant', '--format', '{{.Names}}'],
          { stdout: 'pipe', stderr: 'pipe' }
        );
        const [stdout, exitCode] = await Promise.all([
          new Response(child.stdout).text(),
          child.exited,
        ]);
        if (exitCode === 0 && stdout.trim().length > 0) {
          containerDetected = true;
          provenance = `${runtime}_container`;
          break;
        }
      } catch {
        // runtime not available
      }
    }
  }

  // Check API endpoint
  if (serviceDetected || containerDetected) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => {
        controller.abort();
      }, 3000);
      const response = await fetch('http://127.0.0.1:6333/collections', {
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (response.ok) {
        apiReachable = true;
        const body = asRecord(await response.json());
        const result = asRecord(body.result);
        if (Array.isArray(result.collections)) {
          collections = result.collections.length;
        }
      }
    } catch {
      // API not reachable
    }
  }

  // Check Control Plane integration state
  const integrationState = asRecord(
    await readBoundedJson(join(STATE_DIR, 'qdrant-integration.json'))
  );
  const controlPlaneEnabled = integrationState.enabled === true;

  return {
    service_detected: serviceDetected,
    container_detected: containerDetected,
    api_reachable: apiReachable,
    collections,
    provenance,
    control_plane_enabled: controlPlaneEnabled,
  };
}

// ---------------------------------------------------------------------------
// Overlap metrics
// ---------------------------------------------------------------------------

async function readOverlapMetrics(): Promise<{
  total: number;
  rate: string;
  recent: JsonRecord[];
}> {
  let total = 0;
  const recent: JsonRecord[] = [];

  try {
    const fileStat = await stat(OVERLAP_LOG);
    if (!fileStat.isFile() || fileStat.size === 0) {
      return { total: 0, rate: '0/day', recent: [] };
    }

    const content = await readFile(OVERLAP_LOG, 'utf8');
    const lines = content.split('\n').filter(l => l.trim());
    total = lines.length;

    // Recent entries
    const recentLines = lines.slice(-20).reverse();
    for (const line of recentLines) {
      try {
        const record = asRecord(JSON.parse(line) as unknown);
        recent.push({
          workflow: safeStr(record.workflow, 80),
          timestamp: safeStr(record.timestamp, 80),
          skipped: true,
        });
      } catch {
        // Skip malformed lines
      }
    }

    // Calculate rate
    const dayMs = 86_400_000;
    const cutoff = new Date(Date.now() - dayMs).toISOString();
    const todayCount = lines.filter(l => {
      try {
        const r = asRecord(JSON.parse(l) as unknown);
        return typeof r.timestamp === 'string' && r.timestamp > cutoff;
      } catch {
        return false;
      }
    }).length;

    return {
      total,
      rate: `${todayCount}/day`,
      recent,
    };
  } catch {
    return { total: 0, rate: '0/day', recent: [] };
  }
}

// ---------------------------------------------------------------------------
// Analytics snapshot builder
// ---------------------------------------------------------------------------

export async function buildAnalyticsSnapshot(): Promise<AnalyticsSnapshot> {
  const brainSnapshot = await getBrainSnapshot().catch((): BrainSnapshot | null => null);
  const upgradeStatus = await readUpgradeStatus().catch((): UpgradeStatusResponse | null => null);
  const overlapMetrics = await readOverlapMetrics();

  // Agents
  const agentsData = brainSnapshot?.agents.data;
  const registered = agentsData?.items.length ?? 0;
  const enabled = agentsData?.enabled_count ?? 0;
  const disabled = registered - enabled;

  // Runs from systemd (active goviral workflow runs)
  let activeRuns = 0;
  const runsToday = 0;
  const completedToday = 0;
  const failedToday = 0;
  const cancelledToday = 0;

  try {
    const child = Bun.spawn(
      [
        '/usr/bin/systemctl',
        'list-units',
        '--type=service',
        '--state=running',
        '--no-legend',
        '--no-pager',
        '--plain',
      ],
      { stdout: 'pipe', stderr: 'pipe' }
    );
    const [stdout] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    activeRuns = stdout.split('\n').filter(l => l.trim().startsWith('goviral-')).length;
  } catch {
    // systemctl unavailable
  }

  // Approvals
  const queue = asRecord(await readBoundedJson(QUEUE_FILE));
  const pending = Array.isArray(queue.pending) ? queue.pending.length : 0;
  const approved = Array.isArray(queue.approved) ? queue.approved.length : 0;
  const rejected = Array.isArray(queue.rejected) ? queue.rejected.length : 0;
  const executed = Array.isArray(queue.executed) ? queue.executed.length : 0;

  // Incidents
  const health = asRecord(await readBoundedJson(HEALTH_FILE));
  const checks = Array.isArray(health.checks) ? health.checks : [];
  let critical = 0;
  let high = 0;
  let warning = 0;
  const byStatus: JsonRecord = {};
  for (const check of checks) {
    const status = safeStr(asRecord(check).status, 20) ?? '';
    if (status === 'CRITICAL') critical++;
    else if (status === 'HIGH') high++;
    else if (status === 'WARNING') warning++;
    byStatus[status] = ((byStatus[status] as number) || 0) + 1;
  }

  // Backup
  let backupAgeHours: number | null = null;
  let archiveCount = 0;
  try {
    const linkStat = await stat(join(BACKUP_DIR, 'latest.tar.gz'));
    backupAgeHours = Math.round(((Date.now() - linkStat.mtimeMs) / 3_600_000) * 10) / 10;
    const entries = await readdir(BACKUP_DIR);
    archiveCount = entries.filter(e => e.endsWith('.tar.gz') && e !== 'latest.tar.gz').length;
  } catch {
    // no backup
  }

  // Restore drill
  let restoreDrillStatus = 'not_run';
  try {
    const entries = await readdir(RESTORE_DIR);
    const jsonFiles = entries
      .filter(e => e.endsWith('.json'))
      .sort()
      .reverse();
    if (jsonFiles.length > 0) {
      const data = asRecord(await readBoundedJson(join(RESTORE_DIR, jsonFiles[0])));
      restoreDrillStatus = safeStr(data.status, 20) ?? 'not_run';
    }
  } catch {
    // no restore drills
  }

  // Upstream
  const upstreamStatus = upgradeStatus?.latest?.status ?? 'not_checked';
  const upstreamCompatible = upgradeStatus?.latest?.compatible ?? false;
  const upstreamCheckedAt = upgradeStatus?.latest?.checked_at ?? null;

  // Telegram (from Brain snapshot)
  const telegramData = brainSnapshot?.telegram.data;

  // ClickUp
  const clickupData = brainSnapshot?.clickup.data;

  // Qdrant (dynamic observation)
  const qdrant = await observeQdrant();

  // Security services
  const security = await observeSecurityServices();

  // Brain source health
  const brainPartialFailures: string[] = [];
  if (brainSnapshot) {
    const sections = [
      { name: 'agents', s: brainSnapshot.agents },
      { name: 'skills', s: brainSnapshot.skills },
      { name: 'tools', s: brainSnapshot.tools },
      { name: 'clients', s: brainSnapshot.clients },
      { name: 'projects', s: brainSnapshot.projects },
      { name: 'memory', s: brainSnapshot.memory },
      { name: 'brain_os', s: brainSnapshot.brain_os },
      { name: 'councils', s: brainSnapshot.councils },
      { name: 'telegram', s: brainSnapshot.telegram },
      { name: 'clickup', s: brainSnapshot.clickup },
    ];
    for (const { name, s } of sections) {
      if (s.status === 'error' || s.status === 'unavailable') {
        brainPartialFailures.push(name);
      }
    }
  }

  return {
    generated_at: new Date().toISOString(),
    schema_version: 1,
    agents: {
      registered,
      enabled,
      disabled,
      active_runs: activeRuns,
      runs_today: runsToday,
      completed_today: completedToday,
      failed_today: failedToday,
      cancelled_today: cancelledToday,
    },
    workflows: {
      duration_avg_ms: null, // Would need run-log analysis
      overlap_skipped_total: overlapMetrics.total,
      overlap_skipped_rate: overlapMetrics.rate,
    },
    approvals: { pending, approved, rejected, executed },
    incidents: { critical, high, warning, by_status: byStatus },
    backup: {
      age_hours: backupAgeHours,
      archive_count: archiveCount,
      restore_drill_status: restoreDrillStatus,
    },
    upstream: {
      status: upstreamStatus,
      compatible: upstreamCompatible,
      production_modified: false,
      checked_at: upstreamCheckedAt,
    },
    telegram: {
      framework_installed: telegramData?.framework_installed ?? false,
      credentials_configured: telegramData?.credentials_configured ?? false,
      delivery_status: telegramData?.last_successful_delivery ?? null,
    },
    clickup: {
      current_mode: clickupData?.state ?? 'not_configured',
      writes_enabled: false,
    },
    qdrant,
    security,
    brain: {
      health: brainSnapshot?.health ?? null,
      source_freshness: brainSnapshot?.generated_at ?? null,
      partial_failures: brainPartialFailures,
      schema_version: brainSnapshot?.schema_version ?? null,
    },
    retention: {
      max_snapshots: MAX_SNAPSHOTS,
      retention_days: RETENTION_DAYS,
    },
  };
}

// ---------------------------------------------------------------------------
// CSV export
// ---------------------------------------------------------------------------

export function analyticsToCSV(snapshot: AnalyticsSnapshot): string {
  const lines: string[] = ['metric,value'];

  // Agents
  lines.push(`agents_registered,${snapshot.agents.registered}`);
  lines.push(`agents_enabled,${snapshot.agents.enabled}`);
  lines.push(`agents_disabled,${snapshot.agents.disabled}`);
  lines.push(`agents_active_runs,${snapshot.agents.active_runs}`);
  lines.push(`agents_runs_today,${snapshot.agents.runs_today}`);
  lines.push(`agents_completed_today,${snapshot.agents.completed_today}`);
  lines.push(`agents_failed_today,${snapshot.agents.failed_today}`);
  lines.push(`agents_cancelled_today,${snapshot.agents.cancelled_today}`);

  // Workflows
  lines.push(`workflows_duration_avg_ms,${snapshot.workflows.duration_avg_ms ?? 'N/A'}`);
  lines.push(`workflows_overlap_skipped_total,${snapshot.workflows.overlap_skipped_total}`);
  lines.push(`workflows_overlap_skipped_rate,${snapshot.workflows.overlap_skipped_rate}`);

  // Approvals
  lines.push(`approvals_pending,${snapshot.approvals.pending}`);
  lines.push(`approvals_approved,${snapshot.approvals.approved}`);
  lines.push(`approvals_rejected,${snapshot.approvals.rejected}`);
  lines.push(`approvals_executed,${snapshot.approvals.executed}`);

  // Incidents
  lines.push(`incidents_critical,${snapshot.incidents.critical}`);
  lines.push(`incidents_high,${snapshot.incidents.high}`);
  lines.push(`incidents_warning,${snapshot.incidents.warning}`);

  // Backup
  lines.push(`backup_age_hours,${snapshot.backup.age_hours ?? 'N/A'}`);
  lines.push(`backup_archive_count,${snapshot.backup.archive_count}`);
  lines.push(`backup_restore_drill,${snapshot.backup.restore_drill_status}`);

  // Upstream
  lines.push(`upstream_status,${snapshot.upstream.status}`);
  lines.push(`upstream_compatible,${snapshot.upstream.compatible}`);
  lines.push(`upstream_production_modified,${snapshot.upstream.production_modified}`);

  // Telegram
  lines.push(`telegram_framework_installed,${snapshot.telegram.framework_installed}`);
  lines.push(`telegram_credentials_configured,${snapshot.telegram.credentials_configured}`);
  lines.push(`telegram_delivery_status,${snapshot.telegram.delivery_status ?? 'N/A'}`);

  // ClickUp
  lines.push(`clickup_current_mode,${snapshot.clickup.current_mode}`);
  lines.push(`clickup_writes_enabled,${snapshot.clickup.writes_enabled}`);

  // Qdrant
  lines.push(`qdrant_service_detected,${snapshot.qdrant.service_detected}`);
  lines.push(`qdrant_api_reachable,${snapshot.qdrant.api_reachable}`);
  lines.push(`qdrant_collections,${snapshot.qdrant.collections ?? 'N/A'}`);
  lines.push(`qdrant_control_plane_enabled,${snapshot.qdrant.control_plane_enabled}`);

  // Security
  for (const svc of snapshot.security) {
    lines.push(`security_${svc.name}_active,${svc.active}`);
    lines.push(`security_${svc.name}_healthy,${svc.healthy}`);
  }

  // Brain
  lines.push(`brain_health,${snapshot.brain.health ?? 'unavailable'}`);
  lines.push(`brain_partial_failures,${snapshot.brain.partial_failures.length}`);

  lines.push(`generated_at,${snapshot.generated_at}`);

  return lines.slice(0, MAX_CSV_ROWS).join('\n');
}

// ---------------------------------------------------------------------------
// Safe action executor
// ---------------------------------------------------------------------------

async function executeSafeAction(
  action: SafeActionTarget,
  identity: string
): Promise<ActionResult> {
  const correlationId = generateCorrelationId();
  const startedAt = new Date().toISOString();
  let detail = '';
  let error: string | null = null;
  let ok = false;

  try {
    switch (action) {
      case 'refresh_brain_snapshot': {
        const snapshot = await refreshBrainSnapshot();
        detail = `Snapshot refreshed: health=${snapshot.health}, ${snapshot.agents.data.items.length} agents, ${snapshot.drift.length} drift items`;
        ok = true;
        break;
      }

      case 'run_health_check': {
        const child = Bun.spawn(['/usr/local/bin/goviral-control-healthcheck'], {
          stdout: 'pipe',
          stderr: 'pipe',
          cwd: '/opt/goviral-archon-src',
          env: { ...process.env, HOME: '/var/lib/goviral-archon' },
        });
        const [stdout, exitCode] = await Promise.all([
          new Response(child.stdout).text(),
          child.exited,
        ]);
        ok = exitCode === 0;
        detail = ok ? 'Health check completed' : `Health check failed (exit ${exitCode})`;
        if (stdout.trim()) detail += `: ${stdout.trim().slice(0, 200)}`;
        break;
      }

      case 'run_analytics_rollup': {
        const child = Bun.spawn(['/usr/local/bin/goviral-analytics-rollup'], {
          stdout: 'pipe',
          stderr: 'pipe',
          env: { ...process.env, HOME: '/var/lib/goviral-archon' },
        });
        const [, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited]);
        ok = exitCode === 0;
        detail = ok ? 'Analytics rollup completed' : `Analytics rollup failed (exit ${exitCode})`;
        break;
      }

      case 'run_backup': {
        const child = Bun.spawn(['sudo', '/usr/local/bin/goviral-archon-backup'], {
          stdout: 'pipe',
          stderr: 'pipe',
          env: { ...process.env, HOME: '/var/lib/goviral-archon' },
        });
        const [, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited]);
        ok = exitCode === 0;
        detail = ok ? 'Backup completed' : `Backup failed (exit ${exitCode})`;
        break;
      }

      case 'run_restore_drill': {
        const child = Bun.spawn(['sudo', '/usr/local/bin/goviral-archon-restore-drill'], {
          stdout: 'pipe',
          stderr: 'pipe',
          env: { ...process.env, HOME: '/var/lib/goviral-archon' },
        });
        const [, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited]);
        ok = exitCode === 0;
        detail = ok ? 'Restore drill completed' : `Restore drill failed (exit ${exitCode})`;
        break;
      }

      case 'run_upstream_check': {
        const child = Bun.spawn(['sudo', '/usr/local/bin/goviral-archon-upgrade-check'], {
          stdout: 'pipe',
          stderr: 'pipe',
          env: { ...process.env, HOME: '/var/lib/goviral-archon' },
        });
        const [stdout, exitCode] = await Promise.all([
          new Response(child.stdout).text(),
          child.exited,
        ]);
        ok = exitCode === 0;
        const statusLine = stdout.split('\n').find(l => l.startsWith('upgrade_check_status='));
        detail =
          statusLine ??
          (ok ? 'Upgrade check completed' : `Upgrade check failed (exit ${exitCode})`);
        break;
      }

      case 'test_telegram': {
        // Uses the existing governed telegram test action
        const child = Bun.spawn(
          ['sudo', '/usr/local/bin/goviral-control-action', 'test-telegram'],
          {
            stdout: 'pipe',
            stderr: 'pipe',
            env: { ...process.env, HOME: '/var/lib/goviral-archon' },
          }
        );
        const [stdout, exitCode] = await Promise.all([
          new Response(child.stdout).text(),
          child.exited,
        ]);
        ok = exitCode === 0;
        detail = ok
          ? 'Telegram test sent'
          : `Telegram test failed (exit ${exitCode}): ${stdout.trim().slice(0, 200)}`;
        break;
      }

      case 'clear_safe_caches': {
        // Only clears analytics snapshots older than retention period
        let cleared = 0;
        try {
          const entries = await readdir(ANALYTICS_DIR);
          const cutoff = new Date(Date.now() - RETENTION_DAYS * 86_400_000).toISOString();
          for (const entry of entries.filter(e => e.endsWith('.json')).sort()) {
            if (entry < cutoff) {
              try {
                const { unlink } = await import('node:fs/promises');
                await unlink(join(ANALYTICS_DIR, entry));
                cleared++;
              } catch {
                // skip individual file errors
              }
            }
          }
        } catch {
          // no analytics dir
        }
        ok = true;
        detail = `Cleared ${cleared} stale analytics snapshot(s)`;
        break;
      }

      default:
        error = `Unknown action: ${action}`;
        detail = 'Action not in allowlist';
    }
  } catch (err) {
    error = err instanceof Error ? err.message : 'unknown error';
    detail = `Action failed: ${error}`.slice(0, 300);
  }

  const result: ActionResult = {
    ok,
    action,
    correlation_id: correlationId,
    started_at: startedAt,
    completed_at: new Date().toISOString(),
    detail: detail.slice(0, 500),
    error,
  };

  await appendAudit({
    action: 'safe_action_executed',
    target: action,
    ok,
    identity,
    correlation_id: correlationId,
    error,
  });

  return result;
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerGoviralPhase8Routes(app: OpenAPIHono): void {
  // v3 analytics snapshot
  app.get('/api/goviral/v3/analytics', async c => {
    c.header('Cache-Control', 'no-store');
    const snapshot = await buildAnalyticsSnapshot();
    return c.json(snapshot);
  });

  // v3 analytics CSV export
  app.get('/api/goviral/v3/analytics/export', async c => {
    const snapshot = await buildAnalyticsSnapshot();
    const csv = analyticsToCSV(snapshot);
    c.header('Content-Type', 'text/csv');
    c.header('Content-Disposition', 'attachment; filename="goviral-v3-analytics.csv"');
    return c.text(csv);
  });

  // v3 health summary
  app.get('/api/goviral/v3/health', async c => {
    c.header('Cache-Control', 'no-store');

    const brainCache = getSnapshotCacheStatus();
    const security = await observeSecurityServices();
    const qdrant = await observeQdrant();

    // Failed systemd units
    let failedUnits: string[] = [];
    try {
      const child = Bun.spawn(
        ['/usr/bin/systemctl', '--failed', '--no-legend', '--no-pager', '--plain'],
        { stdout: 'pipe', stderr: 'pipe' }
      );
      const [stdout] = await Promise.all([new Response(child.stdout).text(), child.exited]);
      failedUnits = stdout
        .split('\n')
        .map(l => l.trim().split(/\s+/)[0])
        .filter(u => u?.endsWith('.service'))
        .slice(0, 20);
    } catch {
      // systemctl unavailable
    }

    // Boot mounts
    let bootMount = false;
    let efiMount = false;
    try {
      const child = Bun.spawn(['/usr/bin/findmnt', '-n', '-o', 'TARGET', '/boot', '/boot/efi'], {
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [stdout] = await Promise.all([new Response(child.stdout).text(), child.exited]);
      bootMount = stdout.includes('/boot');
      efiMount = stdout.includes('/boot/efi');
    } catch {
      // findmnt unavailable
    }

    return c.json({
      generated_at: new Date().toISOString(),
      brain_cache: brainCache,
      security,
      qdrant,
      failed_units: failedUnits,
      boot_mount: bootMount,
      efi_mount: efiMount,
    });
  });

  // v3 security status
  app.get('/api/goviral/v3/security', async c => {
    c.header('Cache-Control', 'no-store');
    const services = await observeSecurityServices();
    return c.json({
      generated_at: new Date().toISOString(),
      services,
      all_healthy: services.every(s => !s.installed || s.healthy),
    });
  });

  // v3 Qdrant observed state
  app.get('/api/goviral/v3/qdrant', async c => {
    c.header('Cache-Control', 'no-store');
    const state = await observeQdrant();
    return c.json({
      generated_at: new Date().toISOString(),
      ...state,
    });
  });

  // v3 overlap metrics
  app.get('/api/goviral/v3/overlap', async c => {
    c.header('Cache-Control', 'no-store');
    const metrics = await readOverlapMetrics();
    return c.json({
      generated_at: new Date().toISOString(),
      ...metrics,
    });
  });

  // v3 safe actions metadata
  app.get('/api/goviral/v3/actions', async c => {
    c.header('Cache-Control', 'no-store');
    const role = resolveGoviralRole(c.req.raw.headers);

    return c.json({
      generated_at: new Date().toISOString(),
      available_actions: SAFE_ACTIONS,
      csrf_token: getOrCreateCsrfToken(),
      role,
      can_execute: requireRole(role, 'operator'),
      rate_limit: {
        window_ms: RATE_LIMIT_WINDOW_MS,
        max_actions: RATE_LIMIT_MAX,
        remaining: Math.max(
          0,
          RATE_LIMIT_MAX -
            actionTimestamps.filter(t => t > Date.now() - RATE_LIMIT_WINDOW_MS).length
        ),
      },
    });
  });

  // v3 safe action execution
  app.post('/api/goviral/v3/actions', async c => {
    c.header('Cache-Control', 'no-store');

    // Origin check
    if (!validateOrigin(c.req.raw.headers)) {
      return c.json({ ok: false, error: 'origin_rejected' }, 403);
    }

    // RBAC
    const gate = roleGate(c.req.raw.headers, 'operator');
    if (!gate.allowed) {
      return c.json({ ok: false, error: `${gate.role} role cannot execute actions` }, 403);
    }

    // CSRF
    if (!validateCsrf(c.req.raw.headers)) {
      return c.json({ ok: false, error: 'csrf_token_invalid' }, 403);
    }

    // Rate limit
    if (!checkRateLimit()) {
      return c.json({ ok: false, error: 'rate_limit_exceeded' }, 429);
    }

    // Parse body
    let body: JsonRecord;
    try {
      body = asRecord((await c.req.json()) as unknown);
    } catch {
      return c.json({ ok: false, error: 'invalid JSON' }, 400);
    }

    const action = safeStr(body.action, 40) as SafeActionTarget | null;
    if (!action || !SAFE_ACTIONS.includes(action)) {
      return c.json(
        {
          ok: false,
          error: 'invalid_action',
          detail: `Action must be one of: ${SAFE_ACTIONS.join(', ')}`,
        },
        400
      );
    }

    // Test telegram requires admin
    if (action === 'test_telegram' && !requireRole(gate.role, 'admin')) {
      return c.json({ ok: false, error: 'admin role required for test_telegram' }, 403);
    }

    recordAction();
    const result = await executeSafeAction(action, gate.identity);
    return c.json(result, result.ok ? 200 : 500);
  });
}
