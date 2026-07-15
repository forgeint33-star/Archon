import { readFile, stat } from 'node:fs/promises';
import type { OpenAPIHono } from '@hono/zod-openapi';

const APPROVAL_QUEUE_PATH =
  '/var/lib/goviral-archon/workspaces/goviral-brain/.governance/approval/queue.json';

const APPROVAL_STATUSES = ['pending', 'approved', 'rejected', 'executed'] as const;

type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];
type JsonRecord = Record<string, unknown>;
type UnitKind = 'service' | 'timer';

interface ApprovalItem {
  id: string;
  title: string;
  status: ApprovalStatus;
  requested_by: string | null;
  risk: string | null;
  created_at: string | null;
}

interface ApprovalResponse {
  generated_at: string;
  source_modified_at: string | null;
  counts: Record<ApprovalStatus, number>;
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

interface UnitResult {
  units: SystemdUnit[];
  error: string | null;
}

interface RuntimeResponse {
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

interface CommandResult {
  ok: boolean;
  stdout: string;
}

function asRecord(value: unknown): JsonRecord {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as JsonRecord;
  }

  return {};
}

function safeText(value: unknown, maxLength = 120): string | null {
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
    return null;
  }

  const text = String(value).replace(/\s+/g, ' ').trim();

  if (!text) {
    return null;
  }

  return text.slice(0, maxLength);
}

function numericValue(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.max(0, Math.trunc(value));
  }

  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    return Number.parseInt(value, 10);
  }

  return null;
}

function normalizeApprovalStatus(value: unknown, fallback: ApprovalStatus): ApprovalStatus {
  const status = safeText(value)?.toLowerCase() ?? '';

  if (status.includes('execut')) {
    return 'executed';
  }

  if (status.includes('reject') || status.includes('denied')) {
    return 'rejected';
  }

  if (status.includes('approv')) {
    return 'approved';
  }

  if (status.includes('pending') || status.includes('waiting') || status.includes('queued')) {
    return 'pending';
  }

  return fallback;
}

function approvalArrays(raw: unknown): { rows: unknown[]; hint: ApprovalStatus }[] {
  const output: { rows: unknown[]; hint: ApprovalStatus }[] = [];
  const root = asRecord(raw);
  const containers = [
    root,
    asRecord(root.queue),
    asRecord(root.approvals),
    asRecord(root.requests),
  ];

  if (Array.isArray(raw)) {
    output.push({ rows: raw, hint: 'pending' });
  }

  for (const container of containers) {
    for (const status of APPROVAL_STATUSES) {
      const value =
        container[status] ?? container[`${status}_items`] ?? container[`${status}_requests`];

      if (Array.isArray(value)) {
        output.push({ rows: value, hint: status });
      }
    }

    for (const key of ['items', 'entries', 'requests', 'queue']) {
      const value = container[key];

      if (Array.isArray(value)) {
        output.push({ rows: value, hint: 'pending' });
      }
    }
  }

  const rootValues = Object.values(root).filter(
    (value): boolean =>
      typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value) &&
      ('status' in value || 'state' in value)
  );

  if (rootValues.length > 0) {
    output.push({ rows: rootValues.slice(0, 200), hint: 'pending' });
  }

  return output;
}

function approvalTitle(record: JsonRecord): string {
  return (
    safeText(record.title) ??
    safeText(record.summary) ??
    safeText(record.name) ??
    safeText(record.action_type) ??
    safeText(record.kind) ??
    safeText(record.type) ??
    'Governed request'
  );
}

function extractApprovalItems(raw: unknown): ApprovalItem[] {
  const items: ApprovalItem[] = [];
  const seen = new Set<string>();

  for (const candidate of approvalArrays(raw)) {
    for (const value of candidate.rows.slice(0, 200)) {
      const record = asRecord(value);

      if (Object.keys(record).length === 0) {
        continue;
      }

      const status = normalizeApprovalStatus(record.status ?? record.state, candidate.hint);

      const createdAt =
        safeText(record.created_at) ??
        safeText(record.createdAt) ??
        safeText(record.timestamp) ??
        safeText(record.requested_at);

      const id =
        safeText(record.id) ??
        safeText(record.request_id) ??
        safeText(record.approval_id) ??
        safeText(record.uuid) ??
        `${status}-${createdAt ?? 'unknown'}-${items.length + 1}`;

      const dedupeKey = `${status}:${id}`;

      if (seen.has(dedupeKey)) {
        continue;
      }

      seen.add(dedupeKey);

      items.push({
        id,
        title: approvalTitle(record),
        status,
        requested_by:
          safeText(record.requested_by) ?? safeText(record.agent) ?? safeText(record.source),
        risk: safeText(record.risk) ?? safeText(record.risk_level) ?? safeText(record.severity),
        created_at: createdAt,
      });
    }
  }

  return items
    .sort((left, right): number => {
      const leftTime = Date.parse(left.created_at ?? '') || 0;
      const rightTime = Date.parse(right.created_at ?? '') || 0;
      return rightTime - leftTime;
    })
    .slice(0, 20);
}

function countFromRecord(raw: unknown, status: ApprovalStatus, items: ApprovalItem[]): number {
  const root = asRecord(raw);
  const containers = [root, asRecord(root.counts), asRecord(root.stats), asRecord(root.summary)];

  for (const container of containers) {
    for (const key of [status, `${status}_count`, `${status}Count`]) {
      const count = numericValue(container[key]);

      if (count !== null) {
        return count;
      }
    }
  }

  for (const container of [root, asRecord(root.queue), asRecord(root.approvals)]) {
    const value = container[status];

    if (Array.isArray(value)) {
      return value.length;
    }
  }

  return items.filter((item): boolean => item.status === status).length;
}

async function approvalResponse(): Promise<ApprovalResponse> {
  let raw: unknown = {};
  let modifiedAt: string | null = null;

  try {
    raw = JSON.parse(await readFile(APPROVAL_QUEUE_PATH, 'utf8')) as unknown;
    modifiedAt = (await stat(APPROVAL_QUEUE_PATH)).mtime.toISOString();
  } catch {
    raw = {};
  }

  const items = extractApprovalItems(raw);

  return {
    generated_at: new Date().toISOString(),
    source_modified_at: modifiedAt,
    counts: {
      pending: countFromRecord(raw, 'pending', items),
      approved: countFromRecord(raw, 'approved', items),
      rejected: countFromRecord(raw, 'rejected', items),
      executed: countFromRecord(raw, 'executed', items),
    },
    items,
  };
}

async function runSystemctl(args: string[]): Promise<CommandResult> {
  try {
    const child = Bun.spawn(['/usr/bin/systemctl', ...args], {
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const [stdout, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited]);

    return {
      ok: exitCode === 0,
      stdout,
    };
  } catch {
    return {
      ok: false,
      stdout: '',
    };
  }
}

function parsePropertyBlocks(output: string): JsonRecord[] {
  return output
    .trim()
    .split(/\n\s*\n/)
    .map((block): JsonRecord => {
      const result: JsonRecord = {};

      for (const line of block.split('\n')) {
        const separator = line.indexOf('=');

        if (separator <= 0) {
          continue;
        }

        result[line.slice(0, separator)] = line.slice(separator + 1);
      }

      return result;
    })
    .filter((record): boolean => Boolean(record.Id));
}

async function listGoviralUnits(kind: UnitKind): Promise<UnitResult> {
  const listResult = await runSystemctl([
    'list-unit-files',
    `--type=${kind}`,
    '--no-legend',
    '--no-pager',
    '--plain',
  ]);

  if (!listResult.ok) {
    return {
      units: [],
      error: 'systemd query unavailable',
    };
  }

  const suffix = `.${kind}`;

  const names = listResult.stdout
    .split('\n')
    .map((line): string => line.trim().split(/\s+/)[0] ?? '')
    .filter((name): boolean => name.startsWith('goviral-') && name.endsWith(suffix))
    .sort((left, right): number => left.localeCompare(right))
    .slice(0, 40);

  if (names.length === 0) {
    return {
      units: [],
      error: null,
    };
  }

  const showResult = await runSystemctl([
    'show',
    '--no-pager',
    '--property=Id',
    '--property=Description',
    '--property=ActiveState',
    '--property=SubState',
    '--property=UnitFileState',
    '--property=NextElapseUSecRealtime',
    ...names,
  ]);

  if (!showResult.ok) {
    return {
      units: [],
      error: 'systemd unit details unavailable',
    };
  }

  const units = parsePropertyBlocks(showResult.stdout)
    .map(
      (record): SystemdUnit => ({
        name: safeText(record.Id) ?? 'unknown',
        description: safeText(record.Description),
        active_state: safeText(record.ActiveState) ?? 'unknown',
        sub_state: safeText(record.SubState) ?? 'unknown',
        unit_file_state: safeText(record.UnitFileState),
        next_trigger: kind === 'timer' ? safeText(record.NextElapseUSecRealtime) : null,
      })
    )
    .sort((left, right): number => left.name.localeCompare(right.name));

  return {
    units,
    error: null,
  };
}

async function runtimeResponse(): Promise<RuntimeResponse> {
  const [serviceResult, timerResult] = await Promise.all([
    listGoviralUnits('service'),
    listGoviralUnits('timer'),
  ]);

  const allUnits = [...serviceResult.units, ...timerResult.units];

  const error = serviceResult.error ?? timerResult.error ?? null;

  return {
    generated_at: new Date().toISOString(),
    available: error === null,
    services: serviceResult.units,
    timers: timerResult.units,
    summary: {
      services_total: serviceResult.units.length,
      services_active: serviceResult.units.filter((unit): boolean => unit.active_state === 'active')
        .length,
      timers_total: timerResult.units.length,
      timers_active: timerResult.units.filter((unit): boolean => unit.active_state === 'active')
        .length,
      failed_units: allUnits.filter(
        (unit): boolean => unit.active_state === 'failed' || unit.sub_state === 'failed'
      ).length,
    },
    error,
  };
}

export function registerGoviralPhase2Routes(app: OpenAPIHono): void {
  app.get('/api/goviral/approvals', async c => c.json(await approvalResponse()));

  app.get('/api/goviral/runtime', async c => c.json(await runtimeResponse()));
}
