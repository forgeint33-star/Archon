/**
 * GoViral Brain Inventory API — Phase 2 + 3
 *
 * Stable, read-only endpoints consuming the Brain snapshot service.
 * Fixes the agent semantic confusion from v2 (runs vs registered agents).
 * Preserves backward compatibility with existing v1/v2 consumers.
 */

import type { OpenAPIHono } from '@hono/zod-openapi';
import { getBrainSnapshot } from './goviral-brain-snapshot';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const BRAIN_ROOT =
  process.env.GOVIRAL_BRAIN_ROOT ?? '/var/lib/goviral-archon/workspaces/goviral-brain';

type JsonRecord = Record<string, unknown>;

function safeText(value: unknown, maxLength = 180): string {
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
    return '';
  }
  return String(value).replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

async function readSafeJson<T = JsonRecord>(path: string): Promise<T | null> {
  try {
    const s = await stat(path);
    if (!s.isFile() || s.size > 1024 * 1024) return null;
    const text = await readFile(path, 'utf8');
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

async function safeMtime(path: string): Promise<string | null> {
  try {
    return (await stat(path)).mtime.toISOString();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Pagination helper
// ---------------------------------------------------------------------------

interface PaginationParams {
  page: number;
  pageSize: number;
}

function parsePagination(
  query: Record<string, string | undefined>,
  maxPageSize = 100
): PaginationParams {
  const page = Math.max(1, parseInt(query.page ?? '1', 10) || 1);
  const pageSize = Math.min(maxPageSize, Math.max(1, parseInt(query.pageSize ?? '50', 10) || 50));
  return { page, pageSize };
}

function paginate<T>(
  items: T[],
  params: PaginationParams
): { items: T[]; total: number; page: number; page_size: number; total_pages: number } {
  const start = (params.page - 1) * params.pageSize;
  return {
    items: items.slice(start, start + params.pageSize),
    total: items.length,
    page: params.page,
    page_size: params.pageSize,
    total_pages: Math.ceil(items.length / params.pageSize),
  };
}

// ---------------------------------------------------------------------------
// Agent-bus thread reader (for runtime counts)
// ---------------------------------------------------------------------------

type Activity = 'active' | 'recent' | 'idle' | 'unknown';

interface AgentBusThread {
  id: string;
  title: string;
  agent: string;
  status: string;
  activity: Activity;
  activity_inferred: boolean;
  modified_at: string | null;
}

function inferActivity(status: string, modifiedAt: string | null): Activity {
  if (status === 'running' || status === 'in_progress') return 'active';
  if (modifiedAt) {
    const age = Date.now() - new Date(modifiedAt).getTime();
    if (age < 30 * 60 * 1000) return 'recent';
  }
  return 'idle';
}

async function readAgentBusThreads(): Promise<AgentBusThread[]> {
  const threadsDir = join(BRAIN_ROOT, '.governance', 'agent-bus', 'threads');
  try {
    const entries = await readdir(threadsDir, { withFileTypes: true });
    const dirs = entries
      .filter(e => e.isDirectory())
      .map(e => e.name)
      .sort()
      .reverse()
      .slice(0, 50);

    const threads: AgentBusThread[] = [];
    for (const dir of dirs) {
      const threadPath = join(threadsDir, dir, 'thread.json');
      const data = await readSafeJson(threadPath);
      if (!data) continue;

      const mtime = await safeMtime(join(threadsDir, dir));
      const status = safeText(data.status) || 'unknown';
      const activity = inferActivity(status, mtime);

      threads.push({
        id: dir,
        title: safeText(data.title) || dir,
        agent: safeText(data.lead_agent) || safeText(data.agent) || 'agent-bus',
        status,
        activity,
        activity_inferred: true,
        modified_at: mtime,
      });
    }
    return threads;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerGoviralBrainRoutes(app: OpenAPIHono): void {
  // ===========================================================================
  // Brain overview (master summary)
  // ===========================================================================
  app.get('/api/goviral/brain/overview', async c => {
    const snapshot = await getBrainSnapshot();
    const threads = await readAgentBusThreads();

    const activeNow = threads.filter(t => t.activity === 'active').length;
    const runs24h = threads.filter(t => {
      if (!t.modified_at) return false;
      return Date.now() - new Date(t.modified_at).getTime() < 24 * 60 * 60 * 1000;
    }).length;

    return c.json({
      schema_version: snapshot.schema_version,
      generated_at: snapshot.generated_at,
      source_root: snapshot.source_root,
      refresh_duration_ms: snapshot.refresh_duration_ms,
      health: snapshot.health,
      warnings: snapshot.warnings,
      summary: {
        agents: {
          registered: snapshot.agents.data.registered_count,
          discovered_definitions: snapshot.agents.data.discovered_definition_count,
          registry_drift: snapshot.agents.data.registry_drift_count,
          workers: snapshot.agents.data.worker_count,
          gates: snapshot.agents.data.gate_count,
          orchestrators: snapshot.agents.data.orchestrator_count,
          enabled: snapshot.agents.data.enabled_count,
          active_now: activeNow,
          runs_24h: runs24h,
        },
        skills: {
          catalog: snapshot.skills.data.catalog_count,
          canonical: snapshot.skills.data.canonical_count,
          bridges: snapshot.skills.data.bridge_count,
          operational: snapshot.skills.data.operational_count,
          total_skill_md: snapshot.skills.data.total_skill_md_count,
        },
        tools: {
          registered: snapshot.tools.data.registered_count,
          active: snapshot.tools.data.active_count,
          mcp_servers: snapshot.tools.data.mcp_servers.length,
        },
        clients: {
          indexed: snapshot.clients.data.indexed_count,
          directories: snapshot.clients.data.directory_count,
          runtime_knowledge_clients: snapshot.clients.data.runtime_knowledge_clients,
          runtime_knowledge_files: snapshot.clients.data.runtime_knowledge_files,
          drift: snapshot.clients.data.drift_count,
        },
        projects: {
          bridged: snapshot.projects.data.bridged_count,
        },
        memory: {
          brain_memory_entries: snapshot.memory.data.brain_memory.entry_count,
          knowledge_graph: snapshot.memory.data.knowledge_graph.status,
          learning_engine: snapshot.memory.data.learning_engine.status,
          runtime_knowledge: snapshot.memory.data.runtime_knowledge.status,
        },
        brain_os: {
          phase: snapshot.brain_os.data.phase,
          status: snapshot.brain_os.data.status,
        },
        telegram: {
          configured: snapshot.telegram.data.credentials_configured,
          notifier_active: snapshot.telegram.data.notifier_timer_active,
          digest_active: snapshot.telegram.data.daily_digest_timer_active,
          last_delivery: snapshot.telegram.data.last_successful_delivery,
        },
        clickup: {
          configured: snapshot.clickup.data.configured,
          state: snapshot.clickup.data.state,
          policies: snapshot.clickup.data.policy_count,
        },
        drift_count: snapshot.drift.length,
      },
    });
  });

  // ===========================================================================
  // Agents (FIXED semantics)
  // ===========================================================================
  app.get('/api/goviral/brain/agents', async c => {
    const snapshot = await getBrainSnapshot();
    const threads = await readAgentBusThreads();
    const query = c.req.query();
    const pagination = parsePagination(query);

    const activeNow = threads.filter(t => t.activity === 'active').length;
    const runs24h = threads.filter(t => {
      if (!t.modified_at) return false;
      return Date.now() - new Date(t.modified_at).getTime() < 24 * 60 * 60 * 1000;
    }).length;
    const recentRuns = threads.filter(t => t.activity === 'recent').length;

    // Filter agents
    let items = snapshot.agents.data.items;
    if (query.type) {
      items = items.filter(a => a.type === query.type);
    }
    if (query.lane) {
      items = items.filter(a => a.lane === query.lane);
    }
    if (query.consistency) {
      items = items.filter(a => a.consistency === query.consistency);
    }

    const paged = paginate(items, pagination);

    return c.json({
      generated_at: new Date().toISOString(),
      source_freshness: snapshot.agents.freshness,
      source_status: snapshot.agents.status,
      summary: {
        registered_count: snapshot.agents.data.registered_count,
        discovered_definition_count: snapshot.agents.data.discovered_definition_count,
        registry_drift_count: snapshot.agents.data.registry_drift_count,
        worker_count: snapshot.agents.data.worker_count,
        gate_count: snapshot.agents.data.gate_count,
        orchestrator_count: snapshot.agents.data.orchestrator_count,
        enabled_count: snapshot.agents.data.enabled_count,
        active_now_count: activeNow,
        runs_24h_count: runs24h,
        recent_run_count: recentRuns,
      },
      agents: paged.items,
      recent_threads: threads.slice(0, 10),
      pagination: {
        total: paged.total,
        page: paged.page,
        page_size: paged.page_size,
        total_pages: paged.total_pages,
      },
      warnings: snapshot.agents.warnings,
    });
  });

  // ===========================================================================
  // Skills
  // ===========================================================================
  app.get('/api/goviral/brain/skills', async c => {
    const snapshot = await getBrainSnapshot();
    const query = c.req.query();
    const pagination = parsePagination(query);

    let items = snapshot.skills.data.items;
    if (query.category) {
      items = items.filter(s => s.category === query.category);
    }
    if (query.source) {
      items = items.filter(s => s.source === query.source);
    }

    const paged = paginate(items, pagination);

    return c.json({
      generated_at: new Date().toISOString(),
      source_freshness: snapshot.skills.freshness,
      source_status: snapshot.skills.status,
      summary: {
        catalog_count: snapshot.skills.data.catalog_count,
        canonical_count: snapshot.skills.data.canonical_count,
        bridge_count: snapshot.skills.data.bridge_count,
        operational_count: snapshot.skills.data.operational_count,
        agent_skill_count: snapshot.skills.data.agent_skill_count,
        gsap_count: snapshot.skills.data.gsap_count,
        total_skill_md_count: snapshot.skills.data.total_skill_md_count,
      },
      categories: snapshot.skills.data.categories,
      skills: paged.items,
      pagination: {
        total: paged.total,
        page: paged.page,
        page_size: paged.page_size,
        total_pages: paged.total_pages,
      },
      warnings: snapshot.skills.warnings,
    });
  });

  // ===========================================================================
  // Tools & MCP
  // ===========================================================================
  app.get('/api/goviral/brain/tools', async c => {
    const snapshot = await getBrainSnapshot();

    return c.json({
      generated_at: new Date().toISOString(),
      source_freshness: snapshot.tools.freshness,
      source_status: snapshot.tools.status,
      summary: {
        registered_count: snapshot.tools.data.registered_count,
        active_count: snapshot.tools.data.active_count,
      },
      tools: snapshot.tools.data.items,
      mcp_servers: snapshot.tools.data.mcp_servers,
      warnings: snapshot.tools.warnings,
    });
  });

  // ===========================================================================
  // Clients
  // ===========================================================================
  app.get('/api/goviral/brain/clients', async c => {
    const snapshot = await getBrainSnapshot();
    const query = c.req.query();
    const pagination = parsePagination(query);

    let items = snapshot.clients.data.items;
    if (query.indexed === 'true') items = items.filter(c => c.indexed);
    if (query.indexed === 'false') items = items.filter(c => !c.indexed);

    const paged = paginate(items, pagination);

    return c.json({
      generated_at: new Date().toISOString(),
      source_freshness: snapshot.clients.freshness,
      source_status: snapshot.clients.status,
      summary: {
        indexed_count: snapshot.clients.data.indexed_count,
        directory_count: snapshot.clients.data.directory_count,
        runtime_knowledge_clients: snapshot.clients.data.runtime_knowledge_clients,
        runtime_knowledge_files: snapshot.clients.data.runtime_knowledge_files,
        drift_count: snapshot.clients.data.drift_count,
      },
      clients: paged.items,
      pagination: {
        total: paged.total,
        page: paged.page,
        page_size: paged.page_size,
        total_pages: paged.total_pages,
      },
      warnings: snapshot.clients.warnings,
    });
  });

  // ===========================================================================
  // Projects
  // ===========================================================================
  app.get('/api/goviral/brain/projects', async c => {
    const snapshot = await getBrainSnapshot();

    return c.json({
      generated_at: new Date().toISOString(),
      source_freshness: snapshot.projects.freshness,
      source_status: snapshot.projects.status,
      summary: {
        bridged_count: snapshot.projects.data.bridged_count,
      },
      projects: snapshot.projects.data.items,
      warnings: snapshot.projects.warnings,
    });
  });

  // ===========================================================================
  // Workflows (uses existing agent-bus thread data)
  // ===========================================================================
  app.get('/api/goviral/brain/workflows', async c => {
    const threads = await readAgentBusThreads();
    const query = c.req.query();
    const pagination = parsePagination(query);

    let items = threads;
    if (query.status) {
      items = items.filter(t => t.status === query.status);
    }
    if (query.activity) {
      items = items.filter(t => t.activity === query.activity);
    }

    const paged = paginate(items, pagination);

    const statusCounts: Record<string, number> = {};
    const activityCounts: Record<string, number> = {};
    for (const t of threads) {
      statusCounts[t.status] = (statusCounts[t.status] ?? 0) + 1;
      activityCounts[t.activity] = (activityCounts[t.activity] ?? 0) + 1;
    }

    return c.json({
      generated_at: new Date().toISOString(),
      summary: {
        total: threads.length,
        by_status: statusCounts,
        by_activity: activityCounts,
      },
      threads: paged.items,
      pagination: {
        total: paged.total,
        page: paged.page,
        page_size: paged.page_size,
        total_pages: paged.total_pages,
      },
    });
  });

  // ===========================================================================
  // Artifacts (safe metadata only)
  // ===========================================================================
  app.get('/api/goviral/brain/artifacts', async c => {
    // Check for artifact packs
    const artifactDir = join(BRAIN_ROOT, '.governance', 'artifact-packs');
    let artifactCount = 0;
    let latestArtifact: string | null = null;
    try {
      const entries = await readdir(artifactDir);
      artifactCount = entries.filter(e => !e.startsWith('.')).length;
      if (entries.length > 0) {
        latestArtifact = await safeMtime(join(artifactDir, entries[entries.length - 1]));
      }
    } catch {
      // No artifacts dir
    }

    // Quality scores
    const qualityDir = join(BRAIN_ROOT, '.governance', 'artifact-quality');
    let qualityStatus = 'unavailable';
    try {
      const entries = await readdir(qualityDir);
      qualityStatus = entries.length > 0 ? 'present' : 'empty';
    } catch {
      // No quality dir
    }

    return c.json({
      generated_at: new Date().toISOString(),
      summary: {
        artifact_packs: artifactCount,
        quality_status: qualityStatus,
        latest_artifact: latestArtifact,
      },
    });
  });

  // ===========================================================================
  // Memory & knowledge
  // ===========================================================================
  app.get('/api/goviral/brain/memory', async c => {
    const snapshot = await getBrainSnapshot();

    return c.json({
      generated_at: new Date().toISOString(),
      source_freshness: snapshot.memory.freshness,
      source_status: snapshot.memory.status,
      brain_memory: snapshot.memory.data.brain_memory,
      knowledge_graph: snapshot.memory.data.knowledge_graph,
      learning_engine: snapshot.memory.data.learning_engine,
      runtime_knowledge: snapshot.memory.data.runtime_knowledge,
      qdrant: {
        enabled: false,
        status: 'resource_deferred',
        fallback: 'keyword_metadata_search',
      },
      warnings: snapshot.memory.warnings,
    });
  });

  // ===========================================================================
  // Councils & swarms
  // ===========================================================================
  app.get('/api/goviral/brain/councils', async c => {
    const snapshot = await getBrainSnapshot();

    return c.json({
      generated_at: new Date().toISOString(),
      source_freshness: snapshot.councils.freshness,
      source_status: snapshot.councils.status,
      worker_swarm: snapshot.councils.data.worker_swarm,
      wow_engine: snapshot.councils.data.wow_engine,
      fast_subagent: snapshot.councils.data.fast_subagent,
      warnings: snapshot.councils.warnings,
    });
  });

  // ===========================================================================
  // Drift
  // ===========================================================================
  app.get('/api/goviral/brain/drift', async c => {
    const snapshot = await getBrainSnapshot();
    const query = c.req.query();

    let items = snapshot.drift;
    if (query.category) {
      items = items.filter(d => d.category === query.category);
    }
    if (query.severity) {
      items = items.filter(d => d.severity === query.severity);
    }

    return c.json({
      generated_at: new Date().toISOString(),
      source_freshness: snapshot.generated_at,
      summary: {
        total: snapshot.drift.length,
        by_severity: {
          critical: snapshot.drift.filter(d => d.severity === 'critical').length,
          high: snapshot.drift.filter(d => d.severity === 'high').length,
          medium: snapshot.drift.filter(d => d.severity === 'medium').length,
          low: snapshot.drift.filter(d => d.severity === 'low').length,
        },
        by_category: Object.fromEntries(
          [...new Set(snapshot.drift.map(d => d.category))].map(cat => [
            cat,
            snapshot.drift.filter(d => d.category === cat).length,
          ])
        ),
      },
      items,
    });
  });
}
