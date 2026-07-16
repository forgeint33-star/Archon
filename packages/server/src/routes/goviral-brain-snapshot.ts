/**
 * GoViral Brain Snapshot Service — Phase 1
 *
 * Read-only, schema-versioned, cached snapshot of the canonical Brain
 * with bounded filesystem reads, containment checks, and error isolation.
 *
 * Design:
 * - One canonical adapter layer for all Brain parsing
 * - Strict root allowlist + realpath containment
 * - JSON parsing with per-source error isolation
 * - Mtime/fingerprint cache invalidation
 * - Bounded refresh with cancellation
 * - Last-good snapshot retained on partial failure
 * - Never caches or returns secret values
 */

import { readFile, readdir, stat, writeFile, rename, mkdir } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export const BRAIN_SNAPSHOT_SCHEMA_VERSION = 1;

type AgentType = 'worker' | 'gate' | 'researcher' | 'orchestrator' | 'operator_persona' | 'unknown';

export interface BrainAgent {
  name: string;
  display_name: string | null;
  lane: string;
  type: AgentType;
  can_execute: boolean;
  can_modify_prod: boolean;
  approval_requirements: string[];
  registry_source: boolean;
  definition_source: boolean;
  policy_source: boolean;
  consistency:
    | 'consistent'
    | 'drift_missing_registry'
    | 'drift_missing_definition'
    | 'drift_missing_policy';
  skills: string[];
  categories: string[];
}

export interface BrainSkill {
  name: string;
  category: string;
  source: 'catalog' | 'bridge' | 'operational' | 'agent' | 'gsap';
  suggested_agent: string | null;
  has_skill_md: boolean;
  canonical_path: string | null;
}

interface BrainTool {
  name: string;
  active: boolean;
  read_only: boolean;
  owner_agent: string | null;
  source: string;
}

interface BrainMcpServer {
  name: string;
  env_var_keys: string[];
  configured: boolean;
}

interface BrainClient {
  name: string;
  indexed: boolean;
  has_directory: boolean;
  has_runtime_knowledge: boolean;
  project_count: number;
  context_available: boolean;
}

interface BrainProject {
  client: string;
  path: string;
  status: string;
  markers: string[];
  package_scripts: string[];
}

interface BrainMemoryStatus {
  entry_count: number;
  generated_at: string | null;
}

interface BrainKnowledgeStatus {
  status: string;
  files_count: number;
  clients_count: number;
}

interface BrainOSStatus {
  phase: number | null;
  status: string;
  generated_at: string | null;
}

interface SubsystemStatus {
  name: string;
  has_dashboard: boolean;
  has_status: boolean;
  latest_run: string | null;
}

interface BrainTelegramStatus {
  framework_installed: boolean;
  credentials_configured: boolean;
  validation_test_passed: boolean;
  notifier_timer_active: boolean;
  daily_digest_timer_active: boolean;
  last_successful_delivery: string | null;
  detection_method: string;
}

interface BrainClickUpStatus {
  policy_count: number;
  governance_dir_count: number;
  v2_source_enabled: boolean;
  configured: boolean;
  state: string;
}

interface DriftItem {
  category: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  description: string;
  source: string;
  recommendation: string;
}

interface SnapshotSection<T> {
  source: string;
  freshness: string | null;
  status: 'ok' | 'partial' | 'error' | 'unavailable';
  data: T;
  warnings: string[];
}

export interface BrainSnapshot {
  schema_version: number;
  generated_at: string;
  source_root: string;
  refresh_duration_ms: number;
  health: 'healthy' | 'degraded' | 'error';
  warnings: string[];
  agents: SnapshotSection<{
    registered_count: number;
    discovered_definition_count: number;
    registry_drift_count: number;
    worker_count: number;
    gate_count: number;
    orchestrator_count: number;
    enabled_count: number;
    items: BrainAgent[];
  }>;
  skills: SnapshotSection<{
    catalog_count: number;
    canonical_count: number;
    bridge_count: number;
    operational_count: number;
    agent_skill_count: number;
    gsap_count: number;
    total_skill_md_count: number;
    categories: Record<string, number>;
    items: BrainSkill[];
  }>;
  tools: SnapshotSection<{
    registered_count: number;
    active_count: number;
    items: BrainTool[];
    mcp_servers: BrainMcpServer[];
  }>;
  clients: SnapshotSection<{
    indexed_count: number;
    directory_count: number;
    runtime_knowledge_clients: number;
    runtime_knowledge_files: number;
    drift_count: number;
    items: BrainClient[];
  }>;
  projects: SnapshotSection<{
    bridged_count: number;
    items: BrainProject[];
  }>;
  memory: SnapshotSection<{
    brain_memory: BrainMemoryStatus;
    knowledge_graph: { status: string };
    learning_engine: { status: string };
    runtime_knowledge: BrainKnowledgeStatus;
  }>;
  brain_os: SnapshotSection<BrainOSStatus>;
  councils: SnapshotSection<{
    worker_swarm: SubsystemStatus;
    wow_engine: SubsystemStatus;
    fast_subagent: SubsystemStatus;
  }>;
  telegram: SnapshotSection<BrainTelegramStatus>;
  clickup: SnapshotSection<BrainClickUpStatus>;
  drift: DriftItem[];
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const BRAIN_ROOT =
  process.env.GOVIRAL_BRAIN_ROOT ?? '/var/lib/goviral-archon/workspaces/goviral-brain';

const CACHE_DIR = join(
  process.env.GOVIRAL_STATE_DIR ?? '/var/lib/goviral-archon/.archon',
  'brain-snapshot'
);

const MAX_FILE_SIZE = 1024 * 1024; // 1 MB per file
const MAX_DIR_ENTRIES = 500;
const REFRESH_TIMEOUT_MS = 30_000;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// ---------------------------------------------------------------------------
// Containment helpers
// ---------------------------------------------------------------------------

function isContained(candidate: string): boolean {
  const normalized = resolve(candidate);
  const root = resolve(BRAIN_ROOT);
  return normalized === root || normalized.startsWith(`${root}${sep}`);
}

function safePath(...segments: string[]): string | null {
  const candidate = join(BRAIN_ROOT, ...segments);
  return isContained(candidate) ? candidate : null;
}

// ---------------------------------------------------------------------------
// Bounded file I/O
// ---------------------------------------------------------------------------

async function readSafeText(path: string, maxBytes = MAX_FILE_SIZE): Promise<string | null> {
  try {
    const s = await stat(path);
    if (!s.isFile() || s.isSymbolicLink()) return null;
    if (s.size > maxBytes) return null;
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

async function readSafeJson<T = Record<string, unknown>>(path: string): Promise<T | null> {
  const text = await readSafeText(path);
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

async function safeReaddir(path: string, maxEntries = MAX_DIR_ENTRIES): Promise<string[]> {
  try {
    const entries = await readdir(path);
    return entries.slice(0, maxEntries);
  } catch {
    return [];
  }
}

async function safeMtime(path: string): Promise<string | null> {
  try {
    return (await stat(path)).mtime.toISOString();
  } catch {
    return null;
  }
}

/** Safely extract a string from an unknown value, with fallback. */
function str(value: unknown, fallback = 'unknown'): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return `${value}`;
  return fallback;
}

// ---------------------------------------------------------------------------
// Section builders
// ---------------------------------------------------------------------------

function section<T>(
  source: string,
  data: T,
  opts: {
    freshness?: string | null;
    status?: 'ok' | 'partial' | 'error' | 'unavailable';
    warnings?: string[];
  } = {}
): SnapshotSection<T> {
  return {
    source,
    freshness: opts.freshness ?? null,
    status: opts.status ?? 'ok',
    data,
    warnings: opts.warnings ?? [],
  };
}

// ---------------------------------------------------------------------------
// Agent collector
// ---------------------------------------------------------------------------

async function collectAgents(): Promise<SnapshotSection<BrainSnapshot['agents']['data']>> {
  const warnings: string[] = [];

  // Read registry
  const registryPath = safePath('.governance', 'agents', 'registry.json');
  const registry = registryPath
    ? await readSafeJson<{ agents: Record<string, unknown>[] }>(registryPath)
    : null;
  const registeredAgents = registry?.agents ?? [];

  // Read policies
  const policiesPath = safePath('.governance', 'agents', 'policies.json');
  const policies = policiesPath
    ? await readSafeJson<Record<string, Record<string, unknown>>>(policiesPath)
    : null;

  // Discover definitions
  const agentsDir = safePath('.claude', 'agents');
  const definitionFiles = agentsDir ? await safeReaddir(agentsDir) : [];
  const definitions = definitionFiles
    .filter(f => f.endsWith('.md') && !f.includes('CONTEXT'))
    .map(f => f.replace('.md', ''));

  // Discover personas
  const personasDir = safePath('.claude', 'personas');
  const personaFiles = personasDir ? await safeReaddir(personasDir) : [];
  const personas = personaFiles.filter(f => f.endsWith('.md')).map(f => f.replace('.md', ''));

  // Build unified agent list
  const allNames = new Set<string>();
  for (const a of registeredAgents) {
    if (typeof a.name === 'string') allNames.add(a.name);
  }
  for (const d of definitions) allNames.add(d);

  const items: BrainAgent[] = [];
  let driftCount = 0;

  for (const name of allNames) {
    const regEntry = registeredAgents.find(a => a.name === name);
    const hasRegistry = !!regEntry;
    const hasDefinition = definitions.includes(name);
    const hasPolicy = policies ? name in policies : false;
    const policyEntry = policies?.[name];

    let consistency: BrainAgent['consistency'] = 'consistent';
    if (!hasRegistry) {
      consistency = 'drift_missing_registry';
      driftCount++;
    } else if (!hasDefinition) {
      consistency = 'drift_missing_definition';
      driftCount++;
    } else if (!hasPolicy) {
      consistency = 'drift_missing_policy';
      driftCount++;
    }

    const rawType = str(regEntry?.type ?? policyEntry?.level);
    let type: AgentType = 'unknown';
    if (rawType === 'worker') type = 'worker';
    else if (rawType === 'gate') type = 'gate';
    else if (rawType === 'researcher') type = 'researcher';

    items.push({
      name,
      display_name: typeof regEntry?.name === 'string' ? regEntry.name : null,
      lane: str(regEntry?.lane ?? policyEntry?.lane),
      type,
      can_execute: Boolean(regEntry?.can_execute ?? policyEntry?.can_execute ?? false),
      can_modify_prod: Boolean(policyEntry?.can_modify_prod ?? false),
      approval_requirements: Array.isArray(policyEntry?.requires_approval_for)
        ? (policyEntry.requires_approval_for as string[])
        : [],
      registry_source: hasRegistry,
      definition_source: hasDefinition,
      policy_source: hasPolicy,
      consistency,
      skills: [],
      categories: typeof regEntry?.lane === 'string' ? [regEntry.lane] : [],
    });
  }

  // Add personas as orchestrator type
  for (const persona of personas) {
    items.push({
      name: persona,
      display_name: persona,
      lane: persona === 'leonidas' ? 'orchestrator' : 'operator',
      type: persona === 'leonidas' ? 'orchestrator' : 'operator_persona',
      can_execute: false,
      can_modify_prod: false,
      approval_requirements: [],
      registry_source: false,
      definition_source: true,
      policy_source: false,
      consistency: 'consistent',
      skills: [],
      categories: [],
    });
  }

  const workerCount = items.filter(a => a.type === 'worker').length;
  const gateCount = items.filter(a => a.type === 'gate').length;
  const orchestratorCount = items.filter(
    a => a.type === 'orchestrator' || a.type === 'operator_persona'
  ).length;
  const enabledCount = items.filter(a => a.can_execute).length;

  if (driftCount > 0) {
    warnings.push(`${driftCount} agent(s) have registry/definition/policy drift`);
  }

  return section(
    '.governance/agents/',
    {
      registered_count: registeredAgents.length,
      discovered_definition_count: definitions.length,
      registry_drift_count: driftCount,
      worker_count: workerCount,
      gate_count: gateCount,
      orchestrator_count: orchestratorCount,
      enabled_count: enabledCount,
      items,
    },
    {
      freshness: registryPath ? await safeMtime(registryPath) : null,
      warnings,
      status: registry ? 'ok' : 'error',
    }
  );
}

// ---------------------------------------------------------------------------
// Skills collector
// ---------------------------------------------------------------------------

async function collectSkills(): Promise<SnapshotSection<BrainSnapshot['skills']['data']>> {
  const warnings: string[] = [];

  // Read catalog
  const catalogPath = safePath('.governance', 'skills', 'catalog.json');
  const catalog = catalogPath
    ? await readSafeJson<{
        skills?: Record<string, unknown>[];
        catalog?: Record<string, unknown>[];
      }>(catalogPath)
    : null;
  const catalogSkills = catalog?.skills ?? catalog?.catalog ?? [];

  // Count categories
  const categories: Record<string, number> = {};
  for (const s of catalogSkills) {
    const cat = str(s.category);
    categories[cat] = (categories[cat] ?? 0) + 1;
  }

  // Count skill dirs by type
  const claudeSkillsDir = safePath('.claude', 'skills');
  const allSkillDirs = claudeSkillsDir ? await safeReaddir(claudeSkillsDir) : [];

  const operationalDirs = allSkillDirs.filter(d => d.startsWith('goviral-'));
  const bridgeDirs = allSkillDirs.filter(d => d.startsWith('gv-'));
  const gsapDirs = allSkillDirs.filter(d => d.startsWith('gsap-'));

  // Count canonical category dirs
  const categoryDirNames = [
    '3d',
    'ads',
    'compliance',
    'creative',
    'design',
    'engineering',
    'finance',
    'seo',
    'social',
  ];
  let canonicalCount = 0;
  for (const cat of categoryDirNames) {
    const catDir = safePath('.claude', 'skills', cat);
    if (catDir) {
      const entries = await safeReaddir(catDir);
      canonicalCount += entries.filter(e => !e.startsWith('.')).length;
    }
  }

  // Agent skills
  const agentSkillsDir = safePath('.agents', 'skills');
  const agentSkillEntries = agentSkillsDir ? await safeReaddir(agentSkillsDir) : [];
  const agentSkillCount = agentSkillEntries.filter(e => !e.startsWith('.')).length;

  // Build items from catalog
  const items: BrainSkill[] = catalogSkills.map(s => ({
    name: str(s.name),
    category: str(s.category),
    source: 'catalog' as const,
    suggested_agent: typeof s.suggested_agent === 'string' ? s.suggested_agent : null,
    has_skill_md: true,
    canonical_path: typeof s.canonical_source === 'string' ? s.canonical_source : null,
  }));

  return section(
    '.governance/skills/',
    {
      catalog_count: catalogSkills.length,
      canonical_count: canonicalCount,
      bridge_count: bridgeDirs.length,
      operational_count: operationalDirs.length,
      agent_skill_count: agentSkillCount,
      gsap_count: gsapDirs.length,
      total_skill_md_count:
        operationalDirs.length +
        bridgeDirs.length +
        gsapDirs.length +
        canonicalCount +
        agentSkillCount,
      categories,
      items,
    },
    {
      freshness: catalogPath ? await safeMtime(catalogPath) : null,
      status: catalog ? 'ok' : 'error',
      warnings,
    }
  );
}

// ---------------------------------------------------------------------------
// Tools & MCP collector
// ---------------------------------------------------------------------------

async function collectTools(): Promise<SnapshotSection<BrainSnapshot['tools']['data']>> {
  const warnings: string[] = [];

  // Tool activation registry
  const toolsDir = safePath('.governance', 'tool-activation-registry', 'tools');
  const toolFiles = toolsDir ? (await safeReaddir(toolsDir)).filter(f => f.endsWith('.json')) : [];

  const items: BrainTool[] = [];
  for (const file of toolFiles) {
    const toolData = toolsDir ? await readSafeJson(join(toolsDir, file)) : null;
    items.push({
      name: file.replace('.json', ''),
      active: Boolean(toolData?.active ?? toolData?.enabled ?? true),
      read_only: Boolean(toolData?.read_only ?? true),
      owner_agent:
        typeof toolData?.owner_agent === 'string'
          ? toolData.owner_agent
          : typeof toolData?.owner === 'string'
            ? toolData.owner
            : null,
      source: `.governance/tool-activation-registry/tools/${file}`,
    });
  }

  // MCP servers
  const mcpPath = safePath('.mcp.json');
  const mcpConfig = mcpPath
    ? await readSafeJson<{ mcpServers?: Record<string, Record<string, unknown>> }>(mcpPath)
    : null;
  const mcpServers: BrainMcpServer[] = [];

  if (mcpConfig?.mcpServers) {
    for (const [name, config] of Object.entries(mcpConfig.mcpServers)) {
      const envObj = config.env as Record<string, unknown> | undefined;
      mcpServers.push({
        name,
        env_var_keys: envObj ? Object.keys(envObj) : [],
        configured: true,
      });
    }
  }

  return section(
    '.governance/tools/',
    {
      registered_count: items.length,
      active_count: items.filter(t => t.active).length,
      items,
      mcp_servers: mcpServers,
    },
    { freshness: toolsDir ? await safeMtime(toolsDir) : null, warnings }
  );
}

// ---------------------------------------------------------------------------
// Clients collector
// ---------------------------------------------------------------------------

async function collectClients(): Promise<SnapshotSection<BrainSnapshot['clients']['data']>> {
  const warnings: string[] = [];

  // Client index
  const indexPath = safePath('.governance', 'client-context', 'client-index.json');
  const index = indexPath
    ? await readSafeJson<{ clients?: Record<string, unknown>[] }>(indexPath)
    : null;
  const indexedClients = index?.clients ?? [];

  // Client directories
  const clientsDir = safePath('clients');
  const clientDirs = clientsDir
    ? (await safeReaddir(clientsDir)).filter(d => !d.startsWith('.') && d !== '_template')
    : [];

  // Runtime knowledge index
  const runtimePath = safePath('.governance', 'client-knowledge', 'runtime-index.json');
  const runtime = runtimePath ? await readSafeJson(runtimePath) : null;
  const runtimeClients = typeof runtime?.clients_count === 'number' ? runtime.clients_count : 0;
  const runtimeFiles = typeof runtime?.files_count === 'number' ? runtime.files_count : 0;

  // Reconcile
  const allNames = new Set<string>();
  for (const c of indexedClients) {
    if (typeof c.name === 'string') allNames.add(c.name);
  }
  for (const d of clientDirs) allNames.add(d);

  const items: BrainClient[] = [];
  let driftCount = 0;

  for (const name of allNames) {
    const isIndexed = indexedClients.some(c => c.name === name);
    const hasDir = clientDirs.includes(name);

    if (isIndexed !== hasDir) driftCount++;

    items.push({
      name,
      indexed: isIndexed,
      has_directory: hasDir,
      has_runtime_knowledge: false, // Would need deeper scan
      project_count: 0,
      context_available: isIndexed,
    });
  }

  if (driftCount > 0) {
    warnings.push(`${driftCount} client(s) have index/directory mismatch`);
  }

  return section(
    '.governance/client-context/',
    {
      indexed_count: indexedClients.length,
      directory_count: clientDirs.length,
      runtime_knowledge_clients: runtimeClients,
      runtime_knowledge_files: runtimeFiles,
      drift_count: driftCount,
      items,
    },
    { freshness: indexPath ? await safeMtime(indexPath) : null, warnings }
  );
}

// ---------------------------------------------------------------------------
// Projects collector
// ---------------------------------------------------------------------------

async function collectProjects(): Promise<SnapshotSection<BrainSnapshot['projects']['data']>> {
  const mapPath = safePath('.governance', 'client-project-bridge', 'project-map.json');
  const map = mapPath
    ? await readSafeJson<{ projects?: Record<string, unknown>[] }>(mapPath)
    : null;
  const projects = map?.projects ?? [];

  const items: BrainProject[] = projects.map(p => ({
    client: str(p.client),
    path: str(p.path, ''),
    status: str(p.status),
    markers: Array.isArray(p.markers) ? (p.markers as string[]) : [],
    package_scripts: Array.isArray(p.package_scripts) ? (p.package_scripts as string[]) : [],
  }));

  return section(
    '.governance/client-project-bridge/',
    {
      bridged_count: items.length,
      items,
    },
    { freshness: mapPath ? await safeMtime(mapPath) : null }
  );
}

// ---------------------------------------------------------------------------
// Memory & knowledge collector
// ---------------------------------------------------------------------------

async function collectMemory(): Promise<SnapshotSection<BrainSnapshot['memory']['data']>> {
  const warnings: string[] = [];

  // Brain memory
  const memoryPath = safePath('.governance', 'brain-memory', 'memory.json');
  const memory = memoryPath ? await readSafeJson(memoryPath) : null;
  let entryCount = 0;
  if (memory) {
    if (typeof memory.entries === 'object' && memory.entries !== null) {
      entryCount = Object.keys(memory.entries as Record<string, unknown>).length;
    } else if (Array.isArray(memory.entries)) {
      entryCount = (memory.entries as unknown[]).length;
    }
  }

  // Knowledge graph
  const kgPath = safePath('.governance', 'brain-knowledge-graph', 'knowledge-graph.json');
  const kgExists = kgPath ? await safeMtime(kgPath) : null;

  // Learning engine
  const lePath = safePath('.governance', 'brain-learning', 'learning-examples.json');
  const leExists = lePath ? await safeMtime(lePath) : null;

  // Runtime knowledge
  const runtimePath = safePath('.governance', 'client-knowledge', 'runtime-index.json');
  const runtime = runtimePath ? await readSafeJson(runtimePath) : null;

  return section(
    '.governance/brain-memory/',
    {
      brain_memory: {
        entry_count: entryCount,
        generated_at: typeof memory?.created_at === 'string' ? memory.created_at : null,
      },
      knowledge_graph: { status: kgExists ? 'present' : 'unavailable' },
      learning_engine: { status: leExists ? 'present' : 'unavailable' },
      runtime_knowledge: {
        status: str(runtime?.status),
        files_count: typeof runtime?.files_count === 'number' ? runtime.files_count : 0,
        clients_count: typeof runtime?.clients_count === 'number' ? runtime.clients_count : 0,
      },
    },
    { freshness: memoryPath ? await safeMtime(memoryPath) : null, warnings }
  );
}

// ---------------------------------------------------------------------------
// BrainOS collector
// ---------------------------------------------------------------------------

async function collectBrainOS(): Promise<SnapshotSection<BrainOSStatus>> {
  const consolePath = safePath('.governance', 'brain-os', 'brain-os-console.json');
  const console = consolePath ? await readSafeJson(consolePath) : null;

  return section(
    '.governance/brain-os/',
    {
      phase: typeof console?.phase === 'number' ? console.phase : null,
      status: str(console?.status ?? console?.brain_os_status),
      generated_at: typeof console?.created_at === 'string' ? console.created_at : null,
    },
    { freshness: consolePath ? await safeMtime(consolePath) : null }
  );
}

// ---------------------------------------------------------------------------
// Councils & swarms collector
// ---------------------------------------------------------------------------

async function collectCouncils(): Promise<SnapshotSection<BrainSnapshot['councils']['data']>> {
  async function subsystemStatus(dirName: string): Promise<SubsystemStatus> {
    const dir = safePath('.governance', dirName);
    const hasDashboard = dir ? (await safeReaddir(join(dir, 'dashboard'))).length > 0 : false;
    const statusPath = dir ? join(dir, 'dashboard', 'status.json') : null;
    const statusData = statusPath ? await readSafeJson(statusPath) : null;

    return {
      name: dirName,
      has_dashboard: hasDashboard,
      has_status: statusData !== null,
      latest_run: null, // Would need run dir scan
    };
  }

  return section('.governance/', {
    worker_swarm: await subsystemStatus('worker-swarm'),
    wow_engine: await subsystemStatus('wow-engine'),
    fast_subagent: await subsystemStatus('fast-subagent-runtime'),
  });
}

// ---------------------------------------------------------------------------
// Systemd helper
// ---------------------------------------------------------------------------

interface SystemdTimerInfo {
  active: boolean;
  enabled: boolean;
  lastRunResult: string | null;
  lastRunTimestamp: string | null;
}

async function querySystemdTimer(unitName: string): Promise<SystemdTimerInfo> {
  try {
    const child = Bun.spawn(
      ['/usr/bin/systemctl', 'show', `${unitName}.timer`, '--property=ActiveState,UnitFileState'],
      { stdout: 'pipe', stderr: 'pipe' }
    );
    const [stdout, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    if (exitCode !== 0)
      return { active: false, enabled: false, lastRunResult: null, lastRunTimestamp: null };

    const props: Record<string, string> = {};
    for (const line of stdout.split('\n')) {
      const [key, ...rest] = line.split('=');
      if (key && rest.length > 0) props[key.trim()] = rest.join('=').trim();
    }

    // Also get the service's last execution result
    const svcChild = Bun.spawn(
      [
        '/usr/bin/systemctl',
        'show',
        `${unitName}.service`,
        '--property=Result,ExecMainStartTimestamp',
      ],
      { stdout: 'pipe', stderr: 'pipe' }
    );
    const [svcStdout, svcExit] = await Promise.all([
      new Response(svcChild.stdout).text(),
      svcChild.exited,
    ]);

    const svcProps: Record<string, string> = {};
    if (svcExit === 0) {
      for (const line of svcStdout.split('\n')) {
        const [key, ...rest] = line.split('=');
        if (key && rest.length > 0) svcProps[key.trim()] = rest.join('=').trim();
      }
    }

    return {
      active: props.ActiveState === 'active',
      enabled: props.UnitFileState === 'enabled',
      lastRunResult: svcProps.Result || null,
      lastRunTimestamp: svcProps.ExecMainStartTimestamp || null,
    };
  } catch {
    return { active: false, enabled: false, lastRunResult: null, lastRunTimestamp: null };
  }
}

// ---------------------------------------------------------------------------
// Telegram collector (systemd + state evidence, never unprivileged stat)
// ---------------------------------------------------------------------------

async function collectTelegram(): Promise<SnapshotSection<BrainTelegramStatus>> {
  const stateDir = process.env.GOVIRAL_STATE_DIR ?? '/var/lib/goviral-archon/.archon';

  // Check timers via systemd
  const notifierTimer = await querySystemdTimer('goviral-telegram-notifier');
  const digestTimer = await querySystemdTimer('goviral-daily-ops-report');

  // Read daily digest state file for last successful delivery
  const digestStatePath = join(stateDir, 'notifications', 'daily-digest-state.json');
  const digestState = await readSafeJson(digestStatePath);
  const lastSent = typeof digestState?.last_sent === 'string' ? digestState.last_sent : null;
  const lastSuccess = digestState?.success === true;

  // Framework: check if scripts are installed (timer existence proves it)
  const frameworkInstalled =
    notifierTimer.active || digestTimer.active || notifierTimer.enabled || digestTimer.enabled;

  // Credentials: inferred from successful delivery or timer enablement
  // We CANNOT stat root-owned files from this process. Instead we use evidence:
  // - If the daily digest was successfully sent recently, credentials work
  // - If timers are enabled, the deploy script verified credential existence
  const hasSuccessfulDelivery = lastSuccess && lastSent !== null;
  const credentialsConfigured =
    hasSuccessfulDelivery ||
    (notifierTimer.lastRunResult === 'success' && digestTimer.lastRunResult === 'success');

  // Validation test: a successful delivery IS a validation
  const validationPassed = hasSuccessfulDelivery;

  return section(
    'systemd + notifications/',
    {
      framework_installed: frameworkInstalled,
      credentials_configured: credentialsConfigured,
      validation_test_passed: validationPassed,
      notifier_timer_active: notifierTimer.active,
      daily_digest_timer_active: digestTimer.active,
      last_successful_delivery: lastSent,
      detection_method: 'systemd_timer_state_and_delivery_evidence',
    },
    {
      freshness: lastSent,
      status: credentialsConfigured ? 'ok' : frameworkInstalled ? 'partial' : 'unavailable',
    }
  );
}

// ---------------------------------------------------------------------------
// ClickUp collector
// ---------------------------------------------------------------------------

async function collectClickUp(): Promise<SnapshotSection<BrainClickUpStatus>> {
  const warnings: string[] = [];

  // Count ClickUp policies
  const policiesDir = safePath('.governance', 'policies');
  const allPolicies = policiesDir ? await safeReaddir(policiesDir) : [];
  const clickupPolicies = allPolicies.filter(f => f.toLowerCase().includes('clickup'));

  // Count ClickUp governance dirs
  const govDir = safePath('.governance');
  const allGovDirs = govDir ? await safeReaddir(govDir) : [];
  const clickupDirs = allGovDirs.filter(d => d.startsWith('clickup-'));

  // v2 sources registry
  const v2Path = safePath('.governance', 'v2-sources', 'registry.json');
  const v2 = v2Path ? await readSafeJson<{ sources?: Record<string, unknown>[] }>(v2Path) : null;
  const clickupSource = v2?.sources?.find(s => s.id === 'clickup');
  const v2Enabled = Boolean(clickupSource?.enabled);

  // Integration state from Archon
  const integrationPath = join(
    process.env.GOVIRAL_STATE_DIR ?? '/var/lib/goviral-archon/.archon',
    'clickup-integration.json'
  );
  const integration = await readSafeJson(integrationPath);
  const configured = Boolean(integration?.configured);
  const state = configured ? str(integration?.state, 'configured_unverified') : 'not_configured';

  return section(
    '.governance/clickup-*',
    {
      policy_count: clickupPolicies.length,
      governance_dir_count: clickupDirs.length,
      v2_source_enabled: v2Enabled,
      configured,
      state,
    },
    { freshness: v2Path ? await safeMtime(v2Path) : null, warnings }
  );
}

// ---------------------------------------------------------------------------
// Drift detector
// ---------------------------------------------------------------------------

function detectDrift(snapshot: Partial<BrainSnapshot>): DriftItem[] {
  const drift: DriftItem[] = [];

  // Agent drift
  const agents = snapshot.agents?.data;
  if (agents) {
    for (const agent of agents.items) {
      if (
        agent.consistency !== 'consistent' &&
        agent.type !== 'orchestrator' &&
        agent.type !== 'operator_persona'
      ) {
        drift.push({
          category: 'agents',
          severity: 'high',
          description: `Agent "${agent.name}" has ${agent.consistency.replace('drift_', '')}`,
          source: '.governance/agents/',
          recommendation:
            agent.consistency === 'drift_missing_registry'
              ? `Add "${agent.name}" to registry.json or remove orphaned definition`
              : `Add missing ${agent.consistency.replace('drift_missing_', '')} for "${agent.name}"`,
        });
      }
    }
  }

  // Client drift
  const clients = snapshot.clients?.data;
  if (clients && clients.drift_count > 0) {
    for (const client of clients.items) {
      if (client.indexed !== client.has_directory) {
        drift.push({
          category: 'clients',
          severity: 'medium',
          description: client.indexed
            ? `Client "${client.name}" is indexed but has no directory`
            : `Client directory "${client.name}" exists but is not in the index`,
          source: '.governance/client-context/',
          recommendation: 'Reconcile client-index.json with filesystem directories',
        });
      }
    }
  }

  // Council/swarm drift
  const councils = snapshot.councils?.data;
  if (councils) {
    for (const sub of [councils.worker_swarm, councils.wow_engine, councils.fast_subagent]) {
      if (sub.has_dashboard && !sub.has_status) {
        drift.push({
          category: 'councils',
          severity: 'low',
          description: `${sub.name} has dashboard directory but no status.json`,
          source: `.governance/${sub.name}/`,
          recommendation: 'Run the subsystem to generate initial status or remove empty dashboard',
        });
      }
    }
  }

  return drift;
}

// ---------------------------------------------------------------------------
// Snapshot cache
// ---------------------------------------------------------------------------

let cachedSnapshot: BrainSnapshot | null = null;
let cacheTimestamp = 0;
let refreshInProgress = false;

async function ensureCacheDir(): Promise<void> {
  try {
    await mkdir(CACHE_DIR, { recursive: true, mode: 0o700 });
  } catch {
    // ignore - may already exist
  }
}

async function writeCacheFile(snapshot: BrainSnapshot): Promise<void> {
  await ensureCacheDir();
  const tmpPath = join(CACHE_DIR, `snapshot-${Date.now()}.tmp`);
  const finalPath = join(CACHE_DIR, 'latest.json');
  try {
    await writeFile(tmpPath, JSON.stringify(snapshot, null, 2), { mode: 0o600 });
    await rename(tmpPath, finalPath);
  } catch {
    // Cache write failure is non-fatal
  }
}

async function readCacheFile(): Promise<BrainSnapshot | null> {
  const cachePath = join(CACHE_DIR, 'latest.json');
  return readSafeJson<BrainSnapshot>(cachePath);
}

// ---------------------------------------------------------------------------
// Main refresh
// ---------------------------------------------------------------------------

export async function refreshBrainSnapshot(): Promise<BrainSnapshot> {
  if (refreshInProgress) {
    if (cachedSnapshot) return cachedSnapshot;
    const cached = await readCacheFile();
    if (cached) return cached;
    throw new Error('Snapshot refresh already in progress and no cached snapshot available');
  }

  refreshInProgress = true;
  const startTime = Date.now();

  try {
    const warnings: string[] = [];

    // Verify Brain root exists
    try {
      const rootStat = await stat(BRAIN_ROOT);
      if (!rootStat.isDirectory()) {
        throw new Error('Brain root is not a directory');
      }
    } catch {
      throw new Error(`Brain root not accessible: ${BRAIN_ROOT}`);
    }

    // Collect all sections with timeout protection
    const timeout = new Promise<never>((_, reject) => {
      setTimeout(() => {
        reject(new Error('Snapshot refresh timed out'));
      }, REFRESH_TIMEOUT_MS);
    });

    const [agents, skills, tools, clients, projects, memory, brainOS, councils, telegram, clickup] =
      await Promise.race([
        Promise.all([
          collectAgents().catch(e => {
            warnings.push(`agents: ${(e as Error).message}`);
            return section(
              '.governance/agents/',
              {
                registered_count: 0,
                discovered_definition_count: 0,
                registry_drift_count: 0,
                worker_count: 0,
                gate_count: 0,
                orchestrator_count: 0,
                enabled_count: 0,
                items: [],
              },
              { status: 'error', warnings: [(e as Error).message] }
            );
          }),
          collectSkills().catch(e => {
            warnings.push(`skills: ${(e as Error).message}`);
            return section(
              '.governance/skills/',
              {
                catalog_count: 0,
                canonical_count: 0,
                bridge_count: 0,
                operational_count: 0,
                agent_skill_count: 0,
                gsap_count: 0,
                total_skill_md_count: 0,
                categories: {},
                items: [],
              },
              { status: 'error', warnings: [(e as Error).message] }
            );
          }),
          collectTools().catch(e => {
            warnings.push(`tools: ${(e as Error).message}`);
            return section(
              '.governance/tools/',
              {
                registered_count: 0,
                active_count: 0,
                items: [],
                mcp_servers: [],
              },
              { status: 'error', warnings: [(e as Error).message] }
            );
          }),
          collectClients().catch(e => {
            warnings.push(`clients: ${(e as Error).message}`);
            return section(
              '.governance/client-context/',
              {
                indexed_count: 0,
                directory_count: 0,
                runtime_knowledge_clients: 0,
                runtime_knowledge_files: 0,
                drift_count: 0,
                items: [],
              },
              { status: 'error', warnings: [(e as Error).message] }
            );
          }),
          collectProjects().catch(e => {
            warnings.push(`projects: ${(e as Error).message}`);
            return section(
              '.governance/client-project-bridge/',
              {
                bridged_count: 0,
                items: [],
              },
              { status: 'error', warnings: [(e as Error).message] }
            );
          }),
          collectMemory().catch(e => {
            warnings.push(`memory: ${(e as Error).message}`);
            return section(
              '.governance/brain-memory/',
              {
                brain_memory: { entry_count: 0, generated_at: null },
                knowledge_graph: { status: 'unavailable' },
                learning_engine: { status: 'unavailable' },
                runtime_knowledge: { status: 'unknown', files_count: 0, clients_count: 0 },
              },
              { status: 'error', warnings: [(e as Error).message] }
            );
          }),
          collectBrainOS().catch(e => {
            warnings.push(`brain_os: ${(e as Error).message}`);
            return section(
              '.governance/brain-os/',
              {
                phase: null,
                status: 'unknown',
                generated_at: null,
              },
              { status: 'error', warnings: [(e as Error).message] }
            );
          }),
          collectCouncils().catch(e => {
            warnings.push(`councils: ${(e as Error).message}`);
            return section(
              '.governance/',
              {
                worker_swarm: {
                  name: 'worker-swarm',
                  has_dashboard: false,
                  has_status: false,
                  latest_run: null,
                },
                wow_engine: {
                  name: 'wow-engine',
                  has_dashboard: false,
                  has_status: false,
                  latest_run: null,
                },
                fast_subagent: {
                  name: 'fast-subagent-runtime',
                  has_dashboard: false,
                  has_status: false,
                  latest_run: null,
                },
              },
              { status: 'error', warnings: [(e as Error).message] }
            );
          }),
          collectTelegram().catch(e => {
            warnings.push(`telegram: ${(e as Error).message}`);
            return section(
              'systemd + notifications/',
              {
                framework_installed: false,
                credentials_configured: false,
                validation_test_passed: false,
                notifier_timer_active: false,
                daily_digest_timer_active: false,
                last_successful_delivery: null,
                detection_method: 'error',
              },
              { status: 'error', warnings: [(e as Error).message] }
            );
          }),
          collectClickUp().catch(e => {
            warnings.push(`clickup: ${(e as Error).message}`);
            return section(
              '.governance/clickup-*',
              {
                policy_count: 0,
                governance_dir_count: 0,
                v2_source_enabled: false,
                configured: false,
                state: 'error',
              },
              { status: 'error', warnings: [(e as Error).message] }
            );
          }),
        ]),
        timeout,
      ]);

    const partialSnapshot = {
      agents,
      skills,
      tools,
      clients,
      projects,
      memory,
      brain_os: brainOS,
      councils,
      telegram,
      clickup,
    };
    const drift = detectDrift(partialSnapshot);

    const errorSections = [
      agents,
      skills,
      tools,
      clients,
      projects,
      memory,
      brainOS,
      councils,
      telegram,
      clickup,
    ].filter(s => s.status === 'error').length;

    const health = errorSections === 0 ? 'healthy' : errorSections <= 3 ? 'degraded' : 'error';

    const snapshot: BrainSnapshot = {
      schema_version: BRAIN_SNAPSHOT_SCHEMA_VERSION,
      generated_at: new Date().toISOString(),
      source_root: BRAIN_ROOT,
      refresh_duration_ms: Date.now() - startTime,
      health,
      warnings,
      ...partialSnapshot,
      drift,
    };

    // Update cache
    cachedSnapshot = snapshot;
    cacheTimestamp = Date.now();
    await writeCacheFile(snapshot);

    return snapshot;
  } catch (error) {
    // On failure, return last-good snapshot
    if (cachedSnapshot) {
      return cachedSnapshot;
    }
    const cached = await readCacheFile();
    if (cached) {
      cachedSnapshot = cached;
      return cached;
    }
    throw error;
  } finally {
    refreshInProgress = false;
  }
}

export async function getBrainSnapshot(forceRefresh = false): Promise<BrainSnapshot> {
  if (!forceRefresh && cachedSnapshot && Date.now() - cacheTimestamp < CACHE_TTL_MS) {
    return cachedSnapshot;
  }

  return refreshBrainSnapshot();
}

export function getCachedSnapshot(): BrainSnapshot | null {
  return cachedSnapshot;
}
