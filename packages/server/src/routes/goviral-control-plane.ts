import { registerGoviralPhase5Routes } from './goviral-phase5';
import { registerGoviralPhase4Routes } from './goviral-phase4';
import { registerGoviralPhase3Routes } from './goviral-phase3';
import { registerGoviralPhase2Routes } from './goviral-phase2';
import type { OpenAPIHono } from '@hono/zod-openapi';
import { readFile, readdir, stat } from 'fs/promises';
import { basename, join, relative, resolve, sep } from 'path';

type JsonRecord = Record<string, unknown>;

const BRAIN_ROOT =
  process.env.GOVIRAL_BRAIN_ROOT ?? '/var/lib/goviral-archon/workspaces/goviral-brain';

const SAFE_SUMMARY_FIELDS = [
  'overall_status',
  'failed_count',
  'phase_count',
  'release',
  'timer_enabled',
  'real_execution_allowed',
  'real_execution_performed',
] as const;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

async function readJson(path: string): Promise<JsonRecord | null> {
  const text = await readText(path);
  if (text === null) return null;

  try {
    const value: unknown = JSON.parse(text);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

async function modifiedAt(path: string): Promise<string | null> {
  try {
    return (await stat(path)).mtime.toISOString();
  } catch {
    return null;
  }
}

function safeBrainPath(candidate: string): string | null {
  const root = resolve(BRAIN_ROOT);
  const value = resolve(candidate);

  if (value === root || value.startsWith(`${root}${sep}`)) {
    return value;
  }

  return null;
}

function countArray(record: JsonRecord | null, key: string): number {
  const value = record?.[key];
  return Array.isArray(value) ? value.length : 0;
}

function primitive(record: JsonRecord | null, key: string): string | number | boolean | null {
  const value = record?.[key];

  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }

  return null;
}

function safeSummary(record: JsonRecord | null): JsonRecord {
  const result: JsonRecord = {};

  for (const key of SAFE_SUMMARY_FIELDS) {
    const value = record?.[key];

    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      result[key] = value;
    }
  }

  return result;
}

async function readRunPointer(path: string): Promise<{
  runId: string | null;
  path: string | null;
  modifiedAt: string | null;
}> {
  const text = await readText(path);
  const candidate = text?.trim() ?? '';
  const safePath = candidate ? safeBrainPath(candidate) : null;

  return {
    runId: safePath === null ? null : basename(safePath),
    path: safePath,
    modifiedAt: await modifiedAt(path),
  };
}

async function recentAgentThreads(): Promise<JsonRecord[]> {
  const threadsDir = join(BRAIN_ROOT, '.governance', 'agent-bus', 'threads');

  try {
    const entries = await readdir(threadsDir, { withFileTypes: true });
    const names = entries
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
      .sort()
      .reverse()
      .slice(0, 5);

    const threads = await Promise.all(
      names.map(async name => {
        const record = await readJson(join(threadsDir, name, 'thread.json'));

        return {
          id: primitive(record, 'id'),
          status: primitive(record, 'status'),
          lane: primitive(record, 'lane'),
          lead_agent: primitive(record, 'lead_agent'),
          agent_type: primitive(record, 'agent_type'),
          created_at: primitive(record, 'created_at'),
        };
      })
    );

    return threads;
  } catch {
    return [];
  }
}

async function latestPrd(): Promise<JsonRecord | null> {
  const pointer = await readRunPointer(
    join(BRAIN_ROOT, '.governance', 'brain-auto-workflow', 'status', 'latest-run.txt')
  );

  if (pointer.path === null) return null;

  const prdPath = join(pointer.path, 'PRD.md');
  const content = await readText(prdPath);

  if (content === null) return null;

  const titleLine = content.split(/\r?\n/).find(line => line.trim().startsWith('# '));

  return {
    run_id: pointer.runId,
    title: titleLine?.trim().slice(2).trim() ?? pointer.runId,
    path: relative(BRAIN_ROOT, prdPath),
    modified_at: await modifiedAt(prdPath),
  };
}

export function registerGoviralRoutes(app: OpenAPIHono): void {
  registerGoviralPhase5Routes(app);
  registerGoviralPhase4Routes(app);
  registerGoviralPhase3Routes(app);
  registerGoviralPhase2Routes(app);
  app.get('/api/goviral/overview', async c => {
    const queuePath = join(BRAIN_ROOT, '.governance', 'approval', 'queue.json');

    const doctorPath = join(BRAIN_ROOT, '.governance', 'brainos-master', 'doctor', 'latest.txt');

    const queue = await readJson(queuePath);
    const doctorText = await readText(doctorPath);

    const modules = await Promise.all(
      [
        {
          id: 'approval_inbox',
          label: 'Approval Inbox',
          pointer: join(BRAIN_ROOT, '.governance', 'approval-inbox', 'status', 'latest-run.txt'),
          summary: join(
            BRAIN_ROOT,
            '.governance',
            'approval-inbox',
            'release',
            'latest-summary.json'
          ),
        },
        {
          id: 'prompt_command_center',
          label: 'Prompt Command Center',
          pointer: join(
            BRAIN_ROOT,
            '.governance',
            'prompt-command-center',
            'status',
            'latest-run.txt'
          ),
          summary: null,
        },
        {
          id: 'brainos_master',
          label: 'BrainOS Master',
          pointer: join(BRAIN_ROOT, '.governance', 'brainos-master', 'status', 'latest-run.txt'),
          summary: join(
            BRAIN_ROOT,
            '.governance',
            'brainos-master',
            'release',
            'latest-summary.json'
          ),
        },
        {
          id: 'brain_auto_workflow',
          label: 'Brain Auto Workflow',
          pointer: join(
            BRAIN_ROOT,
            '.governance',
            'brain-auto-workflow',
            'status',
            'latest-run.txt'
          ),
          summary: null,
        },
      ].map(async definition => {
        const pointer = await readRunPointer(definition.pointer);
        const summary = definition.summary === null ? null : await readJson(definition.summary);

        return {
          id: definition.id,
          label: definition.label,
          run_id: pointer.runId,
          updated_at: pointer.modifiedAt,
          summary: safeSummary(summary),
        };
      })
    );

    const doctorStatus =
      doctorText === null
        ? 'UNKNOWN'
        : doctorText.includes('PASS')
          ? 'PASS'
          : doctorText.includes('FAIL')
            ? 'FAIL'
            : 'UNKNOWN';

    return c.json({
      generated_at: new Date().toISOString(),
      brain_root: BRAIN_ROOT,
      doctor: {
        status: doctorStatus,
        source: relative(BRAIN_ROOT, doctorPath),
        modified_at: await modifiedAt(doctorPath),
      },
      approvals: {
        pending: countArray(queue, 'pending'),
        approved: countArray(queue, 'approved'),
        rejected: countArray(queue, 'rejected'),
        executed: countArray(queue, 'executed'),
        modified_at: await modifiedAt(queuePath),
      },
      modules,
      recent_threads: await recentAgentThreads(),
      latest_prd: await latestPrd(),
    });
  });
}
