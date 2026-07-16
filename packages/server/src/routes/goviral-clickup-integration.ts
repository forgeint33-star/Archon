/**
 * GoViral ClickUp Governed Integration — Phase 6
 *
 * Exposes the governed ClickUp integration lifecycle through the control plane API.
 * The Brain remains the canonical source of truth for ClickUp governance:
 * policies, schemas, draft builders, canary gates, permit binders, receipt
 * verification, and reconciliation logic all live in the Brain.
 *
 * This module reads Brain state and projects it as a clear progression:
 *   not_configured → credentials_configured → read_only_validated →
 *   mapping_validated → dry_run_validated → approval_pending →
 *   one_task_canary → post_write_verification → governed_sync_enabled
 *
 * Privacy: Never exposes token, credential path, headers, raw external
 * payloads, or private ClickUp content. Sanitizes all output.
 */
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import type { OpenAPIHono } from '@hono/zod-openapi';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type IntegrationMode =
  | 'not_configured'
  | 'credentials_configured'
  | 'read_only_validated'
  | 'mapping_validated'
  | 'dry_run_validated'
  | 'approval_pending'
  | 'one_task_canary'
  | 'post_write_verification'
  | 'governed_sync_enabled';

interface LayerStatus {
  capability_installed: boolean;
  credentials_configured: boolean;
  read_validation_passed: boolean;
  mapping_ready: boolean;
  dry_run_ready: boolean;
  approval_required: boolean;
  canary_ready: boolean;
  writes_enabled: boolean;
  last_successful_read: string | null;
  last_successful_write: string | null;
  last_reconciliation: string | null;
  current_mode: IntegrationMode;
}

interface MappingSummary {
  brain_clients: number;
  brain_projects: number;
  mapped_count: number;
  unmapped_count: number;
  conflict_count: number;
  drift_count: number;
}

interface DryRunItem {
  action: 'create' | 'update' | 'no_op' | 'conflict' | 'blocked';
  brain_id: string;
  brain_label: string;
  reason: string;
}

interface DryRunPlan {
  generated_at: string;
  total_items: number;
  create_count: number;
  update_count: number;
  no_op_count: number;
  conflict_count: number;
  blocked_count: number;
  items: DryRunItem[];
  deterministic: boolean;
  idempotent: boolean;
}

interface CanaryStatus {
  permit_exists: boolean;
  permit_id: string | null;
  task_created: boolean;
  task_verified: boolean;
  remote_id: string | null;
  receipt_recorded: boolean;
  receipt_path: string | null;
  last_canary_at: string | null;
}

interface GovernanceInventory {
  policies: number;
  governance_dirs: number;
  v2_source_enabled: boolean;
  systemd_timers: number;
  systemd_services: number;
  write_gate_active: boolean;
  canary_gate_active: boolean;
  master_lock_active: boolean;
}

type JsonRecord = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const BRAIN_ROOT =
  process.env.GOVIRAL_BRAIN_ROOT ?? '/var/lib/goviral-archon/workspaces/goviral-brain';
const GOVERNANCE_ROOT = join(BRAIN_ROOT, '.governance');
const STATE_DIR = process.env.GOVIRAL_STATE_DIR ?? '/var/lib/goviral-archon/.archon';
const CLICKUP_STATE_FILE = join(STATE_DIR, 'clickup-integration.json');
const MAX_FILE_SIZE = 512 * 1024;
const MAX_ITEMS = 100;

// ---------------------------------------------------------------------------
// Containment + I/O helpers
// ---------------------------------------------------------------------------

function isContained(candidate: string): boolean {
  const normalized = resolve(candidate);
  const root = resolve(BRAIN_ROOT);
  return normalized === root || normalized.startsWith(`${root}${sep}`);
}

async function readSafeJson(path: string): Promise<JsonRecord | null> {
  try {
    const s = await stat(path);
    if (!s.isFile() || s.size > MAX_FILE_SIZE) return null;
    const text = await readFile(path, 'utf8');
    const parsed = JSON.parse(text) as unknown;
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as JsonRecord)
      : null;
  } catch {
    return null;
  }
}

async function safeReaddir(path: string): Promise<string[]> {
  try {
    return await readdir(path);
  } catch {
    return [];
  }
}

async function isTimerActive(unitName: string): Promise<boolean> {
  try {
    const child = Bun.spawn(['/usr/bin/systemctl', 'is-active', '--quiet', unitName], {
      stdout: 'ignore',
      stderr: 'ignore',
    });
    return (await child.exited) === 0;
  } catch {
    return false;
  }
}

function safeStr(record: JsonRecord, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' ? value.slice(0, 200) : null;
}

function safeBool(record: JsonRecord, key: string): boolean {
  return record[key] === true;
}

// ---------------------------------------------------------------------------
// State readers — all read-only, all Brain-canonical
// ---------------------------------------------------------------------------

async function readIntegrationState(): Promise<JsonRecord> {
  return (await readSafeJson(CLICKUP_STATE_FILE)) ?? {};
}

async function countPolicies(): Promise<number> {
  const entries = await safeReaddir(join(GOVERNANCE_ROOT, 'policies'));
  return entries.filter(f => f.toLowerCase().includes('clickup')).length;
}

async function countGovernanceDirs(): Promise<number> {
  const entries = await safeReaddir(GOVERNANCE_ROOT);
  return entries.filter(d => d.startsWith('clickup-')).length;
}

async function readV2SourceEnabled(): Promise<boolean> {
  const path = join(GOVERNANCE_ROOT, 'v2-sources', 'registry.json');
  if (!isContained(path)) return false;
  const data = await readSafeJson(path);
  if (!data) return false;
  const sources = Array.isArray(data.sources) ? data.sources : [];
  const clickup = sources.find(
    (s: unknown) => typeof s === 'object' && s !== null && (s as JsonRecord).id === 'clickup'
  ) as JsonRecord | undefined;
  return clickup ? safeBool(clickup, 'enabled') : false;
}

async function readCanaryState(): Promise<CanaryStatus> {
  const canaryDir = join(GOVERNANCE_ROOT, 'clickup-canary-gate');
  const permitDir = join(GOVERNANCE_ROOT, 'clickup-canary-permit');

  // Check for canary permit
  const permits = await safeReaddir(permitDir);
  const latestPermit = permits
    .filter(f => f.endsWith('.json'))
    .sort()
    .pop();
  let permitData: JsonRecord | null = null;
  if (latestPermit) {
    const permitPath = join(permitDir, latestPermit);
    if (isContained(permitPath)) {
      permitData = await readSafeJson(permitPath);
    }
  }

  // Check for canary receipt
  const receiptDir = join(GOVERNANCE_ROOT, 'clickup-canary-receipt-workbench');
  const receipts = await safeReaddir(receiptDir);
  const latestReceipt = receipts
    .filter(f => f.endsWith('.json'))
    .sort()
    .pop();
  let receiptData: JsonRecord | null = null;
  if (latestReceipt) {
    const receiptPath = join(receiptDir, latestReceipt);
    if (isContained(receiptPath)) {
      receiptData = await readSafeJson(receiptPath);
    }
  }

  // Check canary gate status
  const gateFiles = await safeReaddir(canaryDir);
  const latestGate = gateFiles
    .filter(f => f.endsWith('.json'))
    .sort()
    .pop();
  let gateData: JsonRecord | null = null;
  if (latestGate) {
    const gatePath = join(canaryDir, latestGate);
    if (isContained(gatePath)) {
      gateData = await readSafeJson(gatePath);
    }
  }

  return {
    permit_exists: permitData !== null,
    permit_id: permitData ? (safeStr(permitData, 'permit_id') ?? safeStr(permitData, 'id')) : null,
    task_created: gateData ? safeBool(gateData, 'task_created') : false,
    task_verified: gateData ? safeBool(gateData, 'task_verified') : false,
    remote_id: gateData ? (safeStr(gateData, 'remote_id') ?? safeStr(gateData, 'task_id')) : null,
    receipt_recorded: receiptData !== null,
    receipt_path: latestReceipt ? `clickup-canary-receipt-workbench/${latestReceipt}` : null,
    last_canary_at: gateData
      ? (safeStr(gateData, 'completed_at') ?? safeStr(gateData, 'created_at'))
      : null,
  };
}

async function readMappingState(): Promise<MappingSummary> {
  // Read from Brain's mapping sources
  const bridgePath = join(GOVERNANCE_ROOT, 'client-project-bridge', 'project-map.json');
  const bridge = isContained(bridgePath) ? await readSafeJson(bridgePath) : null;

  const clientIndexPath = join(GOVERNANCE_ROOT, 'client-context', 'client-index.json');
  const clientIndex = isContained(clientIndexPath) ? await readSafeJson(clientIndexPath) : null;

  const clients = clientIndex
    ? Array.isArray(clientIndex.clients)
      ? clientIndex.clients
      : []
    : [];
  const projects = bridge
    ? Array.isArray(bridge.mappings)
      ? bridge.mappings
      : Array.isArray(bridge.projects)
        ? bridge.projects
        : []
    : [];

  // Count mapped vs unmapped (those with a clickup_id)
  let mapped = 0;
  let unmapped = 0;
  let conflicts = 0;

  for (const p of projects.slice(0, MAX_ITEMS)) {
    const rec = typeof p === 'object' && p !== null ? (p as JsonRecord) : {};
    if (rec.clickup_id || rec.clickup_list_id || rec.clickup_task_id) {
      mapped++;
    } else {
      unmapped++;
    }
    if (rec.conflict || rec.drift) {
      conflicts++;
    }
  }

  return {
    brain_clients: clients.length,
    brain_projects: projects.length,
    mapped_count: mapped,
    unmapped_count: unmapped,
    conflict_count: conflicts,
    drift_count: 0,
  };
}

function buildDryRunPlan(mapping: MappingSummary): DryRunPlan {
  // Deterministic dry-run plan from mapping state
  // Without credentials, this is a structural preview only
  const items: DryRunItem[] = [];

  // All unmapped items would need creation
  for (let i = 0; i < Math.min(mapping.unmapped_count, MAX_ITEMS); i++) {
    items.push({
      action: 'create',
      brain_id: `unmapped-${i + 1}`,
      brain_label: `Unmapped project ${i + 1}`,
      reason: 'No ClickUp mapping exists',
    });
  }

  // Conflicts block
  for (let i = 0; i < Math.min(mapping.conflict_count, MAX_ITEMS); i++) {
    items.push({
      action: 'conflict',
      brain_id: `conflict-${i + 1}`,
      brain_label: `Conflicted mapping ${i + 1}`,
      reason: 'Mapping conflict or drift detected',
    });
  }

  // Mapped items are no-ops
  for (let i = 0; i < Math.min(mapping.mapped_count, MAX_ITEMS); i++) {
    items.push({
      action: 'no_op',
      brain_id: `mapped-${i + 1}`,
      brain_label: `Mapped project ${i + 1}`,
      reason: 'Already mapped',
    });
  }

  return {
    generated_at: new Date().toISOString(),
    total_items: items.length,
    create_count: items.filter(i => i.action === 'create').length,
    update_count: items.filter(i => i.action === 'update').length,
    no_op_count: items.filter(i => i.action === 'no_op').length,
    conflict_count: items.filter(i => i.action === 'conflict').length,
    blocked_count: items.filter(i => i.action === 'blocked').length,
    items: items.slice(0, MAX_ITEMS),
    deterministic: true,
    idempotent: true,
  };
}

// ---------------------------------------------------------------------------
// Mode determination — reads all state and computes current mode
// ---------------------------------------------------------------------------

async function determineMode(
  integrationState: JsonRecord,
  canary: CanaryStatus
): Promise<IntegrationMode> {
  const configured = safeBool(integrationState, 'configured');
  const stateStr = safeStr(integrationState, 'state') ?? '';

  if (!configured) return 'not_configured';

  if (stateStr === 'read_only_verified' || stateStr === 'credentials_configured') {
    return 'read_only_validated';
  }

  if (stateStr === 'mapping_validated') return 'mapping_validated';
  if (stateStr === 'dry_run_validated') return 'dry_run_validated';

  if (canary.permit_exists && !canary.task_created) return 'approval_pending';
  if (canary.task_created && !canary.task_verified) return 'one_task_canary';
  if (canary.task_verified && canary.receipt_recorded) return 'post_write_verification';

  // Check if v2 source says enabled (Brain-level sync enablement)
  const v2Enabled = await readV2SourceEnabled();
  if (v2Enabled && canary.task_verified) return 'governed_sync_enabled';

  return 'credentials_configured';
}

// ---------------------------------------------------------------------------
// Master status builder
// ---------------------------------------------------------------------------

async function buildLayerStatus(): Promise<LayerStatus> {
  const [integrationState, policyCount, govDirCount, canary] = await Promise.all([
    readIntegrationState(),
    countPolicies(),
    countGovernanceDirs(),
    readCanaryState(),
  ]);

  const configured = safeBool(integrationState, 'configured');
  const lastCheck = safeStr(integrationState, 'last_check');
  const stateStr = safeStr(integrationState, 'state') ?? '';

  const mode = await determineMode(integrationState, canary);

  const readValidated =
    configured &&
    (stateStr === 'read_only_verified' ||
      mode === 'read_only_validated' ||
      mode === 'mapping_validated' ||
      mode === 'dry_run_validated' ||
      mode === 'governed_sync_enabled');

  const mappingReady =
    mode === 'mapping_validated' ||
    mode === 'dry_run_validated' ||
    mode === 'governed_sync_enabled';

  const dryRunReady = mode === 'dry_run_validated' || mode === 'governed_sync_enabled';

  const writesEnabled = mode === 'governed_sync_enabled';

  return {
    capability_installed: policyCount > 0 || govDirCount > 0,
    credentials_configured: configured,
    read_validation_passed: readValidated,
    mapping_ready: mappingReady,
    dry_run_ready: dryRunReady,
    approval_required: !canary.permit_exists && configured,
    canary_ready: canary.task_verified && canary.receipt_recorded,
    writes_enabled: writesEnabled,
    last_successful_read: readValidated ? lastCheck : null,
    last_successful_write: canary.last_canary_at,
    last_reconciliation: null,
    current_mode: mode,
  };
}

async function buildGovernanceInventory(): Promise<GovernanceInventory> {
  const [policyCount, govDirCount, v2Enabled] = await Promise.all([
    countPolicies(),
    countGovernanceDirs(),
    readV2SourceEnabled(),
  ]);

  const [writeGate, canaryGate, masterLock] = await Promise.all([
    isTimerActive('goviral-clickup-write-gate.timer'),
    isTimerActive('goviral-clickup-canary-gate.timer'),
    isTimerActive('goviral-clickup-v2-master-lock.timer'),
  ]);

  // Count systemd units
  let timerCount = 0;
  let serviceCount = 0;
  try {
    const child = Bun.spawn(
      [
        '/usr/bin/systemctl',
        'list-units',
        '--no-legend',
        '--no-pager',
        '--plain',
        'goviral-clickup-*',
      ],
      { stdout: 'pipe', stderr: 'ignore' }
    );
    const output = await new Response(child.stdout).text();
    for (const line of output.split('\n')) {
      if (line.includes('.timer')) timerCount++;
      if (line.includes('.service')) serviceCount++;
    }
  } catch {
    // systemctl unavailable
  }

  return {
    policies: policyCount,
    governance_dirs: govDirCount,
    v2_source_enabled: v2Enabled,
    systemd_timers: timerCount,
    systemd_services: serviceCount,
    write_gate_active: writeGate,
    canary_gate_active: canaryGate,
    master_lock_active: masterLock,
  };
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerGoviralClickUpRoutes(app: OpenAPIHono): void {
  // Master integration status — 4-layer + progression mode
  app.get('/api/goviral/clickup/status', async c => {
    c.header('Cache-Control', 'no-store');
    const status = await buildLayerStatus();
    return c.json({
      generated_at: new Date().toISOString(),
      ...status,
    });
  });

  // Governance inventory — Brain framework audit
  app.get('/api/goviral/clickup/governance', async c => {
    const inventory = await buildGovernanceInventory();
    return c.json({
      generated_at: new Date().toISOString(),
      ...inventory,
    });
  });

  // Mapping summary — Brain client/project ↔ ClickUp mapping state
  app.get('/api/goviral/clickup/mapping', async c => {
    const mapping = await readMappingState();
    return c.json({
      generated_at: new Date().toISOString(),
      ...mapping,
    });
  });

  // Dry-run preview — deterministic, idempotent, no external writes
  app.get('/api/goviral/clickup/dry-run', async c => {
    const mapping = await readMappingState();
    const plan = buildDryRunPlan(mapping);
    return c.json(plan);
  });

  // Canary status — one-task canary gate state
  app.get('/api/goviral/clickup/canary', async c => {
    const canary = await readCanaryState();
    return c.json({
      generated_at: new Date().toISOString(),
      ...canary,
    });
  });

  // Conflicts and drift — mapping conflicts only
  app.get('/api/goviral/clickup/conflicts', async c => {
    const mapping = await readMappingState();
    return c.json({
      generated_at: new Date().toISOString(),
      conflict_count: mapping.conflict_count,
      drift_count: mapping.drift_count,
      // Detailed conflict items would come from Brain mapping files
      // when credentials are configured and read validation passes
      items: [],
    });
  });
}
