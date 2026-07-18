import { open, readdir, readFile, stat } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, resolve, sep } from 'node:path';
import type { OpenAPIHono } from '@hono/zod-openapi';
import { getBrainSnapshot } from './goviral-brain-snapshot';

const BRAIN_ROOT = '/var/lib/goviral-archon/workspaces/goviral-brain';

const GOVERNANCE_ROOT = join(BRAIN_ROOT, '.governance');

const DOCTOR_PATH = join(GOVERNANCE_ROOT, 'brainos-master', 'doctor', 'latest.txt');

const COMMAND_CENTER_PATH = join(BRAIN_ROOT, 'workspaces', 'command-center');

const AGENT_THREADS_PATH = join(GOVERNANCE_ROOT, 'agent-bus', 'threads');

const AUTO_WORKFLOW_ROOT = join(GOVERNANCE_ROOT, 'brain-auto-workflow');

const AUTO_WORKFLOW_POINTER = join(AUTO_WORKFLOW_ROOT, 'status', 'latest-run.txt');

const STALE_HOURS = 26;
const MAX_TEXT_BYTES = 128 * 1024;
const MAX_PLAN_DOCUMENTS = 12;
const MAX_PLAN_ITEMS = 40;
const MAX_THREAD_FILES = 12;
const MAX_THREAD_EVENTS = 5;

type JsonRecord = Record<string, unknown>;
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

interface FailedUnit {
  name: string;
  load_state: string;
  active_state: string;
  sub_state: string;
  description: string;
}

interface IncidentResponse {
  generated_at: string;
  doctor: {
    status: string;
    modified_at: string | null;
  };
  summary: Record<Severity, number>;
  incidents: Incident[];
  failed_units: FailedUnit[];
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

interface GoalsResponse {
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
  bounded_events: AgentEvent[];
}

interface RegisteredAgent {
  name: string;
  display_name: string | null;
  lane: string;
  type: string;
  enabled: boolean;
  can_modify_prod: boolean;
  consistency: string;
  has_definition: boolean;
  has_policy: boolean;
}

interface RegistryDefinitionDrift {
  agent: string;
  issue: string;
  recommendation: string;
}

interface AgentsResponse {
  generated_at: string;
  /** New canonical fields — clearly separated semantics */
  registered_agents: RegisteredAgent[];
  discovered_definitions: string[];
  enabled_agents: RegisteredAgent[];
  disabled_agents: RegisteredAgent[];
  active_runs: AgentRun[];
  runs_today: AgentRun[];
  recent_runs: AgentRun[];
  registry_definition_drift: RegistryDefinitionDrift[];
  summary: {
    registered_count: number;
    discovered_definition_count: number;
    enabled_count: number;
    disabled_count: number;
    active_run_count: number;
    runs_today_count: number;
    recent_run_count: number;
    drift_count: number;
    /** @deprecated Use registered_count. Kept for backward compatibility. */
    total: number;
    /** @deprecated Use active_run_count. Kept for backward compatibility. */
    active: number;
    /** @deprecated Use recent_run_count. Kept for backward compatibility. */
    recent: number;
    idle: number;
    unknown: number;
  };
  /** @deprecated Use active_runs/recent_runs. Kept for backward compatibility. */
  runs: AgentRun[];
}

interface CommandResult {
  ok: boolean;
  stdout: string;
}

interface PlanCandidate {
  path: string;
  kind: string;
  source: string;
}

function asRecord(value: unknown): JsonRecord {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as JsonRecord;
  }

  return {};
}

function safeText(value: unknown, maxLength = 180): string | null {
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

function numericField(record: JsonRecord, keys: string[]): number {
  const containers = [
    record,
    asRecord(record.summary),
    asRecord(record.result),
    asRecord(record.stats),
  ];

  for (const container of containers) {
    for (const key of keys) {
      const value = numericValue(container[key]);

      if (value !== null) {
        return value;
      }
    }
  }

  return 0;
}

function isInsideBrain(candidate: string): boolean {
  const normalized = resolve(candidate);

  return normalized === BRAIN_ROOT || normalized.startsWith(`${BRAIN_ROOT}${sep}`);
}

async function readBoundedText(path: string, maxBytes = MAX_TEXT_BYTES): Promise<string | null> {
  try {
    const fileStat = await stat(path);

    if (!fileStat.isFile()) {
      return null;
    }

    if (fileStat.size <= maxBytes) {
      return await readFile(path, 'utf8');
    }

    const handle = await open(path, 'r');

    try {
      const buffer = Buffer.alloc(maxBytes);
      const result = await handle.read(buffer, 0, maxBytes, 0);

      return buffer.subarray(0, result.bytesRead).toString('utf8');
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

async function readBoundedJson(path: string): Promise<unknown> {
  const text = await readBoundedText(path);

  if (!text) {
    return {};
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return {};
  }
}

async function modifiedAt(path: string): Promise<string | null> {
  try {
    return (await stat(path)).mtime.toISOString();
  } catch {
    return null;
  }
}

function ageHours(value: string | null): number | null {
  if (!value) {
    return null;
  }

  const timestamp = Date.parse(value);

  if (!Number.isFinite(timestamp)) {
    return null;
  }

  return (Date.now() - timestamp) / 3_600_000;
}

async function runCommand(executable: string, args: string[]): Promise<CommandResult> {
  try {
    const child = Bun.spawn([executable, ...args], {
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

async function failedGoviralUnits(): Promise<FailedUnit[]> {
  const result = await runCommand('/usr/bin/systemctl', [
    'list-units',
    '--state=failed',
    '--no-legend',
    '--no-pager',
    '--plain',
  ]);

  if (!result.ok) {
    return [];
  }

  return result.stdout
    .split('\n')
    .map((line): string[] => line.trim().split(/\s+/))
    .filter((parts): boolean => parts[0]?.startsWith('goviral-') ?? false)
    .slice(0, 20)
    .map(
      (parts): FailedUnit => ({
        name: parts[0] ?? 'unknown',
        load_state: parts[1] ?? 'unknown',
        active_state: parts[2] ?? 'unknown',
        sub_state: parts[3] ?? 'unknown',
        description: parts.slice(4).join(' ') || 'No description',
      })
    );
}

async function doctorState(): Promise<{
  status: string;
  modified_at: string | null;
}> {
  const [text, timestamp] = await Promise.all([
    readBoundedText(DOCTOR_PATH, 64 * 1024),
    modifiedAt(DOCTOR_PATH),
  ]);

  const content = text ?? '';

  let status = 'UNKNOWN';

  if (/\bPASS\b/i.test(content) && !/\bFAIL(?:ED)?\b/i.test(content)) {
    status = 'PASS';
  } else if (/\bFAIL(?:ED)?\b/i.test(content)) {
    status = 'FAIL';
  }

  return {
    status,
    modified_at: timestamp,
  };
}

async function incidentResponse(): Promise<IncidentResponse> {
  const incidents: Incident[] = [];

  const moduleSummaries = [
    {
      id: 'approval-inbox',
      label: 'Approval Inbox',
      path: join(GOVERNANCE_ROOT, 'approval-inbox', 'release', 'latest-summary.json'),
    },
    {
      id: 'brainos-master',
      label: 'BrainOS Master',
      path: join(GOVERNANCE_ROOT, 'brainos-master', 'release', 'latest-summary.json'),
    },
  ];

  const workflowPointers = [
    {
      id: 'prompt-command-center',
      label: 'Prompt Command Center',
      path: join(GOVERNANCE_ROOT, 'prompt-command-center', 'status', 'latest-run.txt'),
    },
    {
      id: 'brain-auto-workflow',
      label: 'Brain Auto Workflow',
      path: AUTO_WORKFLOW_POINTER,
    },
    {
      id: 'approval-inbox',
      label: 'Approval Inbox',
      path: join(GOVERNANCE_ROOT, 'approval-inbox', 'status', 'latest-run.txt'),
    },
    {
      id: 'brainos-master',
      label: 'BrainOS Master',
      path: join(GOVERNANCE_ROOT, 'brainos-master', 'status', 'latest-run.txt'),
    },
  ];

  const [doctor, failedUnits] = await Promise.all([doctorState(), failedGoviralUnits()]);

  if (doctor.status !== 'PASS') {
    incidents.push({
      id: 'brain-doctor',
      severity: 'critical',
      title: 'Brain Doctor is not passing',
      detail: `Current doctor status: ${doctor.status}`,
      source: 'BrainOS Doctor',
      detected_at: doctor.modified_at,
    });
  }

  for (const module of moduleSummaries) {
    const raw = asRecord(await readBoundedJson(module.path));

    const failedCount = numericField(raw, ['failed_count', 'failedCount', 'failures']);

    if (failedCount > 0) {
      incidents.push({
        id: `module-${module.id}`,
        severity: 'high',
        title: `${module.label} reported failures`,
        detail: `${failedCount} failed phase or check result(s)`,
        source: module.label,
        detected_at: await modifiedAt(module.path),
      });
    }
  }

  for (const workflow of workflowPointers) {
    const timestamp = await modifiedAt(workflow.path);
    const hours = ageHours(timestamp);

    if (hours !== null && hours > STALE_HOURS) {
      incidents.push({
        id: `stale-${workflow.id}`,
        severity: 'warning',
        title: `${workflow.label} may be stale`,
        detail: `Latest-run pointer is approximately ${Math.floor(hours)} hours old`,
        source: workflow.label,
        detected_at: timestamp,
      });
    }
  }

  for (const unit of failedUnits) {
    incidents.push({
      id: `unit-${unit.name}`,
      severity: 'critical',
      title: `${unit.name} is failed`,
      detail: `${unit.active_state}/${unit.sub_state} — ${unit.description}`,
      source: 'systemd',
      detected_at: new Date().toISOString(),
    });
  }

  if (incidents.length === 0) {
    incidents.push({
      id: 'healthy-state',
      severity: 'info',
      title: 'No current operational incidents',
      detail:
        'Bounded checks found no failed GoViral units, module failures or stale workflow pointers.',
      source: 'GoViral Control Plane',
      detected_at: new Date().toISOString(),
    });
  }

  const rank: Record<Severity, number> = {
    critical: 0,
    high: 1,
    warning: 2,
    info: 3,
  };

  incidents.sort((left, right): number => rank[left.severity] - rank[right.severity]);

  return {
    generated_at: new Date().toISOString(),
    doctor,
    summary: {
      critical: incidents.filter((incident): boolean => incident.severity === 'critical').length,
      high: incidents.filter((incident): boolean => incident.severity === 'high').length,
      warning: incidents.filter((incident): boolean => incident.severity === 'warning').length,
      info: incidents.filter((incident): boolean => incident.severity === 'info').length,
    },
    incidents,
    failed_units: failedUnits,
  };
}

async function existingFile(candidate: string): Promise<boolean> {
  if (!isInsideBrain(candidate)) {
    return false;
  }

  try {
    return (await stat(candidate)).isFile();
  } catch {
    return false;
  }
}

async function latestPrdCandidate(): Promise<PlanCandidate | null> {
  const pointerText = await readBoundedText(AUTO_WORKFLOW_POINTER, 16 * 1024);

  const pointer =
    pointerText
      ?.split(/\r?\n/)
      .map((line): string => line.trim())
      .find((line): boolean => Boolean(line)) ?? null;

  if (!pointer) {
    return null;
  }

  const candidates: string[] = [];

  if (isAbsolute(pointer)) {
    candidates.push(pointer);
    candidates.push(join(pointer, 'PRD.md'));
  } else {
    candidates.push(join(AUTO_WORKFLOW_ROOT, pointer));
    candidates.push(join(AUTO_WORKFLOW_ROOT, pointer, 'PRD.md'));
    candidates.push(join(AUTO_WORKFLOW_ROOT, 'runs', pointer, 'PRD.md'));
    candidates.push(join(AUTO_WORKFLOW_ROOT, 'run', pointer, 'PRD.md'));
  }

  for (const candidate of candidates) {
    const normalized =
      extname(candidate).toLowerCase() === '.md' ? candidate : join(candidate, 'PRD.md');

    if (await existingFile(normalized)) {
      return {
        path: normalized,
        kind: 'prd',
        source: 'Brain Auto Workflow',
      };
    }
  }

  return null;
}

async function planCandidates(): Promise<PlanCandidate[]> {
  const candidates: PlanCandidate[] = [];
  const latestPrd = await latestPrdCandidate();

  if (latestPrd) {
    candidates.push(latestPrd);
  }

  try {
    const entries = await readdir(COMMAND_CENTER_PATH, {
      withFileTypes: true,
    });

    const matchingFiles = entries
      .filter(
        (entry): boolean =>
          entry.isFile() &&
          entry.name.toLowerCase().endsWith('.md') &&
          /(goal|deliverable|roadmap|milestone|prd|plan|status)/i.test(entry.name)
      )
      .sort((left, right): number => left.name.localeCompare(right.name))
      .slice(0, MAX_PLAN_DOCUMENTS);

    for (const entry of matchingFiles) {
      candidates.push({
        path: join(COMMAND_CENTER_PATH, entry.name),
        kind: /prd/i.test(entry.name)
          ? 'prd'
          : /roadmap/i.test(entry.name)
            ? 'roadmap'
            : /deliverable/i.test(entry.name)
              ? 'deliverable'
              : 'plan',
        source: 'Command Center',
      });
    }
  } catch {
    // A missing command-center directory is represented by no documents.
  }

  const seen = new Set<string>();

  return candidates
    .filter((candidate): boolean => {
      const normalized = resolve(candidate.path);

      if (seen.has(normalized) || !isInsideBrain(normalized)) {
        return false;
      }

      seen.add(normalized);
      return true;
    })
    .slice(0, MAX_PLAN_DOCUMENTS);
}

function cleanMarkdownText(value: string): string {
  return value
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[*_~]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240);
}

function parsePlanItems(text: string): {
  title: string;
  items: PlanItem[];
} {
  const lines = text.split(/\r?\n/).slice(0, 4000);

  let title = 'Untitled plan';
  let section = 'Overview';

  const items: PlanItem[] = [];

  for (const line of lines) {
    const heading = /^(#{1,4})\s+(.+)$/.exec(line);

    if (heading) {
      const headingText = cleanMarkdownText(heading[2] ?? '');

      if (heading[1]?.length === 1 && headingText) {
        title = headingText;
      } else if (headingText) {
        section = headingText;
      }

      continue;
    }

    const checklist = /^\s*[-*]\s+\[([ xX])\]\s+(.+)$/.exec(line);

    if (checklist && items.length < MAX_PLAN_ITEMS) {
      const itemText = cleanMarkdownText(checklist[2] ?? '');

      if (itemText) {
        items.push({
          text: itemText,
          section,
          done: (checklist[1] ?? '').toLowerCase() === 'x',
        });
      }
    }
  }

  if (items.length === 0) {
    section = 'Overview';

    for (const line of lines) {
      const heading = /^(#{2,4})\s+(.+)$/.exec(line);

      if (heading) {
        section = cleanMarkdownText(heading[2] ?? '');
        continue;
      }

      if (!/(goal|deliverable|milestone|outcome|objective)/i.test(section)) {
        continue;
      }

      const bullet = /^\s*[-*]\s+(.+)$/.exec(line);

      if (bullet && items.length < MAX_PLAN_ITEMS) {
        const itemText = cleanMarkdownText(bullet[1] ?? '');

        if (itemText) {
          items.push({
            text: itemText,
            section,
            done: false,
          });
        }
      }
    }
  }

  return {
    title,
    items,
  };
}

async function goalsResponse(): Promise<GoalsResponse> {
  const candidates = await planCandidates();
  const documents: PlanDocument[] = [];

  for (const candidate of candidates) {
    const text = await readBoundedText(candidate.path);

    if (!text) {
      continue;
    }

    const parsed = parsePlanItems(text);
    const timestamp = await modifiedAt(candidate.path);
    const completed = parsed.items.filter((item): boolean => item.done).length;

    documents.push({
      id: `${candidate.kind}-${basename(candidate.path)}`,
      name: basename(candidate.path),
      title: parsed.title,
      kind: candidate.kind,
      source: candidate.source,
      modified_at: timestamp,
      total_items: parsed.items.length,
      completed_items: completed,
      open_items: parsed.items.length - completed,
      items: parsed.items,
    });
  }

  documents.sort((left, right): number => {
    const leftTime = Date.parse(left.modified_at ?? '') || 0;
    const rightTime = Date.parse(right.modified_at ?? '') || 0;

    return rightTime - leftTime;
  });

  const totalItems = documents.reduce((total, document): number => total + document.total_items, 0);

  const completedItems = documents.reduce(
    (total, document): number => total + document.completed_items,
    0
  );

  return {
    generated_at: new Date().toISOString(),
    summary: {
      documents: documents.length,
      total_items: totalItems,
      completed_items: completedItems,
      open_items: totalItems - completedItems,
      completion_percent: totalItems > 0 ? Math.round((completedItems / totalItems) * 100) : 0,
    },
    documents,
  };
}

function eventArray(record: JsonRecord): unknown[] {
  for (const key of ['events', 'history', 'updates', 'activity']) {
    const value = record[key];

    if (Array.isArray(value)) {
      return value;
    }
  }

  return [];
}

function parseAgentEvent(value: unknown): AgentEvent | null {
  const record = asRecord(value);

  if (Object.keys(record).length === 0) {
    return null;
  }

  const type = safeText(record.type ?? record.kind ?? record.event ?? record.status, 60) ?? 'event';

  const summary =
    safeText(record.summary, 180) ??
    safeText(record.title, 180) ??
    safeText(record.action, 180) ??
    safeText(record.result, 180);

  const timestamp =
    safeText(record.timestamp, 80) ??
    safeText(record.created_at, 80) ??
    safeText(record.updated_at, 80);

  return {
    type,
    summary,
    timestamp,
  };
}

function inferActivity(status: string, timestamp: string | null): Activity {
  const normalized = status.toLowerCase();

  if (
    ['active', 'running', 'in_progress', 'in-progress', 'working', 'executing'].includes(normalized)
  ) {
    return 'active';
  }

  const hours = ageHours(timestamp);

  if (hours !== null && hours <= 0.5) {
    return 'recent';
  }

  if (hours !== null) {
    return 'idle';
  }

  return 'unknown';
}

async function agentRunFromDirectory(directoryName: string): Promise<AgentRun | null> {
  const threadPath = join(AGENT_THREADS_PATH, directoryName, 'thread.json');

  if (!isInsideBrain(threadPath)) {
    return null;
  }

  const raw = asRecord(await readBoundedJson(threadPath));
  const nested = asRecord(raw.thread);

  const record = Object.keys(nested).length > 0 ? nested : raw;

  if (Object.keys(record).length === 0) {
    return null;
  }

  const fileTimestamp = await modifiedAt(threadPath);

  const timestamp =
    safeText(record.updated_at, 80) ??
    safeText(record.modified_at, 80) ??
    safeText(record.created_at, 80) ??
    fileTimestamp;

  const id = safeText(record.thread_id, 120) ?? safeText(record.id, 120) ?? directoryName;

  const status = safeText(record.status ?? record.state ?? record.phase, 80) ?? 'unknown';

  const events = eventArray(record)
    .slice(-MAX_THREAD_EVENTS)
    .map((event): AgentEvent | null => parseAgentEvent(event))
    .filter((event): event is AgentEvent => event !== null);

  return {
    id,
    title:
      safeText(record.title, 180) ??
      safeText(record.subject, 180) ??
      safeText(record.task, 180) ??
      id,
    agent: safeText(record.agent ?? record.worker ?? record.owner, 100) ?? 'agent-bus',
    status,
    activity: inferActivity(status, timestamp),
    activity_inferred: true,
    modified_at: timestamp,
    latest_event: events.length > 0 ? (events[events.length - 1] ?? null) : null,
    bounded_events: events,
  };
}

async function agentsResponse(): Promise<AgentsResponse> {
  // --- Registered agents from Brain snapshot (canonical source) ---
  const snapshot = await getBrainSnapshot();
  const brainAgents = snapshot.agents.data.items;

  const registeredAgents: RegisteredAgent[] = brainAgents
    .filter(a => a.registry_source)
    .map(a => ({
      name: a.name,
      display_name: a.display_name,
      lane: a.lane,
      type: a.type,
      enabled: a.can_execute,
      can_modify_prod: a.can_modify_prod,
      consistency: a.consistency,
      has_definition: a.definition_source,
      has_policy: a.policy_source,
    }));

  const discoveredDefinitions = brainAgents.filter(a => a.definition_source).map(a => a.name);

  const enabledAgents = registeredAgents.filter(a => a.enabled);
  const disabledAgents = registeredAgents.filter(a => !a.enabled);

  // --- Drift ---
  const driftItems: RegistryDefinitionDrift[] = brainAgents
    .filter(
      a =>
        a.consistency !== 'consistent' && a.type !== 'orchestrator' && a.type !== 'operator_persona'
    )
    .map(a => ({
      agent: a.name,
      issue: a.consistency.replace('drift_', ''),
      recommendation:
        a.consistency === 'drift_missing_registry'
          ? `Add "${a.name}" to registry.json or remove orphaned definition`
          : `Add missing ${a.consistency.replace('drift_missing_', '')} for "${a.name}"`,
    }));

  // --- Runtime activity from agent-bus threads ---
  let directoryNames: string[] = [];

  try {
    const entries = await readdir(AGENT_THREADS_PATH, {
      withFileTypes: true,
    });

    directoryNames = entries
      .filter((entry): boolean => entry.isDirectory())
      .map((entry): string => entry.name)
      .sort((left, right): number => right.localeCompare(left))
      .slice(0, MAX_THREAD_FILES);
  } catch {
    directoryNames = [];
  }

  const allRuns = (
    await Promise.all(
      directoryNames.map(
        async (directoryName): Promise<AgentRun | null> => agentRunFromDirectory(directoryName)
      )
    )
  )
    .filter((run): run is AgentRun => run !== null)
    .sort((left, right): number => {
      const leftTime = Date.parse(left.modified_at ?? '') || 0;
      const rightTime = Date.parse(right.modified_at ?? '') || 0;

      return rightTime - leftTime;
    });

  const activeRuns = allRuns.filter(r => r.activity === 'active');
  const recentRuns = allRuns.filter(r => r.activity === 'recent');

  const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
  const runsToday = allRuns.filter(r => {
    if (!r.modified_at) return false;
    return Date.parse(r.modified_at) >= oneDayAgo;
  });

  const idleCount = allRuns.filter(r => r.activity === 'idle').length;
  const unknownCount = allRuns.filter(r => r.activity === 'unknown').length;

  return {
    generated_at: new Date().toISOString(),
    registered_agents: registeredAgents,
    discovered_definitions: discoveredDefinitions,
    enabled_agents: enabledAgents,
    disabled_agents: disabledAgents,
    active_runs: activeRuns,
    runs_today: runsToday,
    recent_runs: recentRuns,
    registry_definition_drift: driftItems,
    summary: {
      registered_count: registeredAgents.length,
      discovered_definition_count: discoveredDefinitions.length,
      enabled_count: enabledAgents.length,
      disabled_count: disabledAgents.length,
      active_run_count: activeRuns.length,
      runs_today_count: runsToday.length,
      recent_run_count: recentRuns.length,
      drift_count: driftItems.length,
      // Backward-compatible fields
      total: registeredAgents.length,
      active: activeRuns.length,
      recent: recentRuns.length,
      idle: idleCount,
      unknown: unknownCount,
    },
    runs: allRuns,
  };
}

// ---------------------------------------------------------------------------
// Agent reconciliation
// ---------------------------------------------------------------------------

interface ReconciliationDrift {
  agent: string;
  classification:
    | 'missing_registry'
    | 'missing_definition'
    | 'duplicate_identity'
    | 'disabled_definition'
    | 'orphan_runtime'
    | 'invalid_manifest';
  evidence: string;
  recommendation: string;
  safe_action: string | null;
}

interface ReconciliationProposal {
  agent: string;
  action: string;
  requires_approval: boolean;
  justification: string;
}

interface ReconciliationResponse {
  generated_at: string;
  canonical_identity_key: 'agent_name';
  registered: string[];
  defined: string[];
  runtime_discovered: string[];
  drift: ReconciliationDrift[];
  reconciliation_proposal: ReconciliationProposal[];
  drift_count: number;
  resolved_count: number;
}

async function agentReconciliation(): Promise<ReconciliationResponse> {
  const snapshot = await getBrainSnapshot();
  const agents = snapshot.agents.data.items;

  const registered = agents.filter(a => a.registry_source).map(a => a.name);
  const defined = agents.filter(a => a.definition_source).map(a => a.name);

  // Runtime discovered: agents that appear in agent-bus threads
  const runtimeDiscovered: string[] = [];
  try {
    const entries = await readdir(AGENT_THREADS_PATH, { withFileTypes: true });
    const threadDirs = entries
      .filter(e => e.isDirectory())
      .map(e => e.name)
      .sort()
      .reverse()
      .slice(0, MAX_THREAD_FILES);

    for (const dir of threadDirs) {
      const threadPath = join(AGENT_THREADS_PATH, dir, 'thread.json');
      if (!isInsideBrain(threadPath)) continue;
      const raw = asRecord(await readBoundedJson(threadPath));
      const nested = asRecord(raw.thread);
      const record = Object.keys(nested).length > 0 ? nested : raw;
      const agentName =
        safeText(record.agent, 100) ?? safeText(record.worker, 100) ?? safeText(record.owner, 100);
      if (agentName && !runtimeDiscovered.includes(agentName)) {
        runtimeDiscovered.push(agentName);
      }
    }
  } catch {
    // threads dir may not exist
  }

  const drift: ReconciliationDrift[] = [];
  const proposals: ReconciliationProposal[] = [];

  for (const agent of agents) {
    if (agent.type === 'orchestrator' || agent.type === 'operator_persona') continue;

    if (agent.consistency === 'drift_missing_registry') {
      drift.push({
        agent: agent.name,
        classification: 'missing_registry',
        evidence: `Definition file exists at .claude/agents/${agent.name}.md but no entry in registry.json`,
        recommendation: `Add "${agent.name}" to .governance/agents/registry.json or remove the orphaned definition`,
        safe_action: null,
      });
      proposals.push({
        agent: agent.name,
        action: `Register agent "${agent.name}" in registry.json`,
        requires_approval: true,
        justification: 'Agent has a definition file but is not registered — cannot be dispatched',
      });
    } else if (agent.consistency === 'drift_missing_definition') {
      drift.push({
        agent: agent.name,
        classification: 'missing_definition',
        evidence: `Agent "${agent.name}" is registered but has no .claude/agents/${agent.name}.md definition file`,
        recommendation: `Create definition file at .claude/agents/${agent.name}.md`,
        safe_action: null,
      });
      proposals.push({
        agent: agent.name,
        action: `Create definition file for "${agent.name}"`,
        requires_approval: true,
        justification: 'Registered agent has no definition — cannot receive prompts',
      });
    } else if (agent.consistency === 'drift_missing_policy') {
      drift.push({
        agent: agent.name,
        classification: 'missing_definition',
        evidence: `Agent "${agent.name}" has no policy entry in policies.json`,
        recommendation: `Add policy entry for "${agent.name}" in .governance/agents/policies.json`,
        safe_action: null,
      });
    }
  }

  // Check for runtime agents not in registry
  for (const runtimeAgent of runtimeDiscovered) {
    if (!registered.includes(runtimeAgent) && !defined.includes(runtimeAgent)) {
      drift.push({
        agent: runtimeAgent,
        classification: 'orphan_runtime',
        evidence: `Agent "${runtimeAgent}" appears in agent-bus threads but is not registered or defined`,
        recommendation: `Investigate and either register "${runtimeAgent}" or clean up stale threads`,
        safe_action: null,
      });
    }
  }

  const resolvedCount = agents.filter(
    a =>
      a.consistency === 'consistent' && a.type !== 'orchestrator' && a.type !== 'operator_persona'
  ).length;

  return {
    generated_at: new Date().toISOString(),
    canonical_identity_key: 'agent_name',
    registered,
    defined,
    runtime_discovered: runtimeDiscovered,
    drift,
    reconciliation_proposal: proposals,
    drift_count: drift.length,
    resolved_count: resolvedCount,
  };
}

export function registerGoviralPhase3Routes(app: OpenAPIHono): void {
  app.get('/api/goviral/incidents', async c => c.json(await incidentResponse()));

  app.get('/api/goviral/goals', async c => c.json(await goalsResponse()));

  app.get('/api/goviral/agents', async c => c.json(await agentsResponse()));

  app.get('/api/goviral/agents/reconciliation', async c => c.json(await agentReconciliation()));
}
