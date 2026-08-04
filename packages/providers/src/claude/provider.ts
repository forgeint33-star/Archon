/**
 * Claude Agent SDK wrapper
 * Provides async generator interface for streaming Claude responses
 *
 * Type Safety Pattern:
 * - Uses `Options` type from SDK for query configuration
 * - SDK message types have strict type checking for content blocks
 * - Content blocks are typed via inline assertions for clarity
 *
 * Authentication:
 * - Credentials reach the subprocess via process.env (already cleaned by
 *   stripCwdEnv) PLUS any per-request `requestOptions.env` (per-user delivered
 *   keys/subscriptions), merged LAST so it wins. `buildSubprocessEnv` does NOT
 *   filter tokens — it only logs which posture process.env shows (explicit
 *   token present vs not); the historical env-token allowlist was removed in
 *   #1067, so the log can read "global" while a per-request token authenticates.
 * - CLAUDE_USE_GLOBAL_AUTH is an Archon-only boot sentinel (set for solo
 *   installs with no creds — see server/src/boot/claude-auth-posture.ts). The
 *   Claude CLI itself ignores it; it neither gates nor filters env here.
 *
 * Binary resolution:
 * - In compiled binaries, `pathToClaudeCodeExecutable` is resolved from
 *   `CLAUDE_BIN_PATH` env or `assistants.claude.claudeBinaryPath` config;
 *   see ./binary-resolver.ts. In dev mode the resolver returns undefined
 *   and the SDK picks its bundled per-platform native binary (Mach-O/ELF/PE
 *   from `@anthropic-ai/claude-agent-sdk-<platform>` optional dep). Pre-0.2.x
 *   SDKs shipped `cli.js` in the package and dev mode resolved that JS file;
 *   the SDK switched to native binaries in the 0.2.x series. See
 *   `shouldPassNoEnvFile` for the implications on the `--no-env-file` flag.
 */
import {
  query,
  type Options,
  type HookCallback,
  type HookCallbackMatcher,
  type SDKAssistantMessageError,
  type TerminalReason,
} from '@anthropic-ai/claude-agent-sdk';
import type {
  IAgentProvider,
  SendQueryOptions,
  MessageChunk,
  TokenUsage,
  ProviderCapabilities,
  NodeConfig,
  BoundedModeOptions,
} from '../types';
import { BoundedModeViolationError } from '../errors';
import { parseClaudeConfig } from './config';
import { CLAUDE_CAPABILITIES } from './capabilities';
import { buildContainerSpawn } from './container-spawn';
import { resolveClaudeBinaryPath } from './binary-resolver';
import { buildArchonMcpServer, ARCHON_TOOL_SERVER } from './native-tools';
import { createLogger } from '@archon/paths';
import { loadMcpConfig } from '../mcp/config';
import { withResumedOutcome, resumedOutcome } from '../shared/resumed';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('provider.claude');
  return cachedLog;
}

/**
 * Content block type for assistant messages
 */
interface ContentBlock {
  type: 'text' | 'tool_use';
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
  id?: string;
}

function normalizeClaudeUsage(usage?: {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}): TokenUsage | undefined {
  if (!usage) return undefined;
  const input = usage.input_tokens;
  const output = usage.output_tokens;
  if (typeof input !== 'number' || typeof output !== 'number') return undefined;
  const total = usage.total_tokens;
  const cacheRead = usage.cache_read_input_tokens;
  const cacheCreation = usage.cache_creation_input_tokens;
  return {
    input,
    output,
    ...(typeof total === 'number' ? { total } : {}),
    ...(typeof cacheRead === 'number' ? { cacheRead } : {}),
    ...(typeof cacheCreation === 'number' ? { cacheCreation } : {}),
  };
}

/**
 * Build environment for Claude subprocess.
 *
 * process.env is already clean at this point:
 * - stripCwdEnv() at entry point removed CWD .env keys + CLAUDECODE markers
 * - ~/.archon/.env loaded with override:true as the trusted source
 */
function buildSubprocessEnv(): NodeJS.ProcessEnv {
  // Using || intentionally: empty string should be treated as missing credential
  const hasExplicitTokens = Boolean(
    process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.CLAUDE_API_KEY
  );
  const authMode = hasExplicitTokens ? 'explicit' : 'global';
  getLog().info(
    { authMode },
    authMode === 'global' ? 'using_global_auth' : 'using_explicit_tokens'
  );
  return { ...process.env };
}

/**
 * Build the base env for a CONTAINER run. Deliberately does NOT spread
 * `process.env` — that is the isolation boundary itself (the container must
 * never inherit the host's environment). The Archon-managed bag
 * (`requestOptions.env`: codebase env vars + per-user AI creds + GitHub token)
 * is layered on top by the caller, and PATH/HOME/CLAUDE_CONFIG_DIR come from the
 * runner image. Only a minimal, host-independent base is seeded here.
 */
function buildContainerBaseEnv(): NodeJS.ProcessEnv {
  return { TERM: 'dumb' };
}

/**
 * Resolve the environment delivered to the Claude subprocess for a request.
 *
 * This is the env-isolation ENFORCEMENT POINT. A container run
 * (`execContext.kind === 'container'`) gets ONLY the Archon-managed bag
 * (`requestOptions.env`: codebase env + per-user creds + GitHub token) layered
 * over a minimal base — host `process.env` NEVER crosses the boundary. A host run
 * inherits the (already-cleaned) host env exactly as before. Exported so the
 * invariant can be unit-tested with a `process.env` canary.
 */
export function buildRequestSubprocessEnv(
  requestOptions: SendQueryOptions | undefined
): NodeJS.ProcessEnv {
  const isContainerRun = requestOptions?.execContext?.kind === 'container';
  const subprocessEnv = isContainerRun ? buildContainerBaseEnv() : buildSubprocessEnv();
  const env = requestOptions?.env ? { ...subprocessEnv, ...requestOptions.env } : subprocessEnv;
  // CLAUDE_API_KEY is Archon's variable name; the Claude Code CLI only reads
  // ANTHROPIC_API_KEY, so mirror it or solo .env installs never authenticate
  // (delivery.ts sets both vars on the per-user api_key path). Guarded on the
  // MERGED env, not process.env: a per-request CLAUDE_CODE_OAUTH_TOKEN (per-user
  // subscription delivered via requestOptions.env) must stay authoritative — the
  // CLI prefers ANTHROPIC_API_KEY over the OAuth token, so injecting the install
  // key alongside it would silently rebill the run. Truthiness is intentional:
  // empty string = missing credential. Never clobbers an explicit ANTHROPIC_API_KEY.
  if (env.CLAUDE_API_KEY && !env.ANTHROPIC_API_KEY && !env.CLAUDE_CODE_OAUTH_TOKEN) {
    env.ANTHROPIC_API_KEY = env.CLAUDE_API_KEY;
    getLog().debug('claude.api_key_mirrored');
  }
  // Bounded mode LAST so a caller-supplied `env` can never loosen a declared
  // bound by pre-setting these variables.
  if (requestOptions?.bounded) applyBoundedModeEnv(env, requestOptions.bounded);
  return env;
}

/**
 * Deliver the bounded output/context caps as CLI environment variables.
 *
 * These are the two bounds the SDK's TypeScript surface does not expose. The
 * installed CLI reads both (`CLAUDE_CODE_MAX_OUTPUT_TOKENS` becomes the request
 * `max_tokens`, clamped to the model's upper limit; `CLAUDE_CODE_MAX_CONTEXT_TOKENS`
 * is honored only when `DISABLE_COMPACT` is also set) — verified against the
 * 0.3.209 binary this install spawns.
 *
 * `DISABLE_COMPACT` is set for two reasons, not one: it unlocks the context cap,
 * AND it stops auto-compaction, whose summarization calls are extra billed model
 * calls that `--max-turns` does not count.
 *
 * Because these are env vars rather than a typed SDK option, the reservation
 * NEVER relies on them — see `computeWorstCase` in @archon/core, which prices
 * the guaranteed ceiling from the model's authoritative maxima instead. They are
 * defense in depth that makes real spend far lower than the ceiling.
 */
function applyBoundedModeEnv(env: NodeJS.ProcessEnv, bounded: BoundedModeOptions): void {
  env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(bounded.maxOutputTokens);
  env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = String(bounded.maxContextTokens);
  env.DISABLE_COMPACT = '1';
}

/**
 * Default max retries for transient subprocess failures.
 *
 * Each retry is a fresh subprocess and therefore a fresh billed model session,
 * invisible to whoever called `sendQuery`. Bounded mode overrides this
 * per-request via `bounded.maxSubprocessRetries` (see
 * {@link resolveMaxSubprocessRetries}); every other path keeps this value, so
 * normal Archon behaviour is unchanged.
 */
const MAX_SUBPROCESS_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 2000;

/** Retry budget for one request: bounded override, else the module default. */
function resolveMaxSubprocessRetries(requestOptions: SendQueryOptions | undefined): number {
  return requestOptions?.bounded?.maxSubprocessRetries ?? MAX_SUBPROCESS_RETRIES;
}

/**
 * Tools bounded mode ALWAYS denies, regardless of what the caller asked for.
 *
 * `Task` spawns subagents: each is its own session with its own turn count and
 * its own ~30s progress-summary forks, none of which `--max-turns` bounds. With
 * Task denied, `maxTurns` is the exact ceiling on outward model calls.
 */
export const BOUNDED_MODE_DISALLOWED_TOOLS: readonly string[] = ['Task'];

/**
 * Request options that are incompatible with a declared bound. Returns the
 * human-readable reasons; empty means the request is admissible.
 *
 * Checked before anything spawns, so a refusal costs nothing.
 */
export function findBoundedModeViolations(
  resumeSessionId: string | undefined,
  requestOptions: SendQueryOptions
): string[] {
  const violations: string[] = [];
  const bounded = requestOptions.bounded;
  if (!bounded) return violations;

  if (resumeSessionId) {
    violations.push(
      'resumeSessionId — a resumed session replays a transcript of unknown size, so the effective prompt cannot be measured'
    );
  }
  if (requestOptions.forkSession === true) {
    violations.push('forkSession — a fork duplicates session history into a second billed session');
  }
  if (requestOptions.fallbackModel !== undefined) {
    violations.push(
      'fallbackModel — a substituted model invalidates the reservation, which is priced for one fixed model'
    );
  }
  if (requestOptions.nodeConfig !== undefined) {
    violations.push(
      'nodeConfig — workflow node config can reintroduce agents, MCP servers and skills that bounded mode excludes'
    );
  }
  if (requestOptions.nativeTools !== undefined && requestOptions.nativeTools.length > 0) {
    violations.push('nativeTools — in-process tool definitions add unmeasured prompt content');
  }
  if (!Number.isInteger(bounded.maxTurns) || bounded.maxTurns < 1) {
    violations.push(`maxTurns must be an integer >= 1 (got ${String(bounded.maxTurns)})`);
  }
  if (!Number.isFinite(bounded.maxBudgetUsd) || bounded.maxBudgetUsd <= 0) {
    violations.push(
      `maxBudgetUsd must be a finite number > 0 (got ${String(bounded.maxBudgetUsd)})`
    );
  }
  if (!Number.isInteger(bounded.maxSubprocessRetries) || bounded.maxSubprocessRetries < 0) {
    violations.push(
      `maxSubprocessRetries must be an integer >= 0 (got ${String(bounded.maxSubprocessRetries)})`
    );
  }
  if (!Number.isInteger(bounded.maxOutputTokens) || bounded.maxOutputTokens < 1) {
    violations.push(
      `maxOutputTokens must be an integer >= 1 (got ${String(bounded.maxOutputTokens)})`
    );
  }
  if (!Number.isInteger(bounded.maxContextTokens) || bounded.maxContextTokens < 1) {
    violations.push(
      `maxContextTokens must be an integer >= 1 (got ${String(bounded.maxContextTokens)})`
    );
  }
  return violations;
}

/**
 * Final NARROWING pass over fully-built SDK options.
 *
 * Runs last on purpose: nodeConfig translation, native-tool registration and
 * session resume have all already written to `options`, so applying the bound
 * here means nothing downstream can widen it. Every mutation either tightens a
 * limit or removes an escape hatch — none relaxes anything.
 */
function applyBoundedMode(options: Options, bounded: BoundedModeOptions): void {
  options.maxTurns = bounded.maxTurns;
  options.maxBudgetUsd = bounded.maxBudgetUsd;
  options.settingSources = bounded.settingSources;
  options.forkSession = false;

  const denied = new Set<string>(options.disallowedTools ?? []);
  for (const t of BOUNDED_MODE_DISALLOWED_TOOLS) denied.add(t);
  for (const t of bounded.extraDisallowedTools ?? []) denied.add(t);
  options.disallowedTools = [...denied];

  // Custom subagent definitions and model fallback are escape hatches out of
  // the declared bound. `findBoundedModeViolations` already refuses a request
  // that ASKS for either; deleting here also covers anything a config default
  // or nodeConfig path might have set on its own.
  delete options.agents;
  delete options.fallbackModel;
}

const RATE_LIMIT_PATTERNS = [
  'rate limit',
  'too many requests',
  '429',
  'overloaded',
  // "API Error: 400 due to tool use concurrency issues" — transient server-side
  // rejection of concurrent tool calls; retrying after backoff succeeds (#1341).
  'tool use concurrency',
];

/**
 * Message-text fallbacks for Anthropic errors the SDK does not yet type.
 *
 * Entries are consulted ONLY when the SDK's typed error code has resolved to
 * the catch-all 'unknown' class (see the ClaudeApiResultError branch in
 * classifyAndEnrichError) — they must never override a typed classification.
 * A matching entry reclassifies the error as rate_limit so the existing
 * backoff-retry applies.
 *
 * Admission contract — each entry must:
 *   1. Name the upstream error it matches.
 *   2. Link an upstream issue/reference requesting the error be properly typed.
 *   3. Be removed once the SDK types it.
 * Do NOT add entries for errors the SDK already classifies.
 *
 * This is deliberately a separate list from RATE_LIMIT_PATTERNS above: that
 * list matches raw subprocess text (no typed code exists at all), while this
 * one is a narrow escape hatch inside the typed classification path (#1797).
 */
const UNTYPED_TRANSIENT_PATTERNS: readonly string[] = [
  // Anthropic 400 "due to tool use concurrency issues" — transient server-side
  // rejection of concurrent tool calls; retrying after backoff succeeds (#1341).
  // TODO: link the upstream SDK issue requesting a typed code for this error,
  // and remove this entry once the SDK classifies it.
  'tool use concurrency',
];

const AUTH_PATTERNS = [
  'credit balance',
  'unauthorized',
  'authentication',
  'invalid token',
  '401',
  '403',
];
const SUBPROCESS_CRASH_PATTERNS = ['exited with code', 'killed', 'signal', 'operation aborted'];

function classifySubprocessError(
  errorMessage: string,
  stderrOutput: string
): 'rate_limit' | 'auth' | 'crash' | 'unknown' {
  const combined = `${errorMessage} ${stderrOutput}`.toLowerCase();
  if (RATE_LIMIT_PATTERNS.some(p => combined.includes(p))) return 'rate_limit';
  if (AUTH_PATTERNS.some(p => combined.includes(p))) return 'auth';
  if (SUBPROCESS_CRASH_PATTERNS.some(p => combined.includes(p))) return 'crash';
  return 'unknown';
}

/**
 * The Claude Code SDK surfaces API-level failures (auth not configured,
 * invalid key, billing, rate limit, model errors) as TEXT rather than
 * throwing: it synthesizes an assistant message (`message.model:
 * '<synthetic>'`, wrapper `error: SDKAssistantMessageError`) whose content is
 * the error prose, then emits a result with `subtype: 'success'` and
 * `is_error: true` — the same field pair as the legitimate stop-sequence
 * termination carve-out (#1425). Without structural detection the error prose
 * flows downstream as successful node output (#1797).
 *
 * This error carries the SDK's typed error code so retry classification is
 * structural — never matched against the message text.
 */
type SdkErrorCode = SDKAssistantMessageError | 'unknown';

export class ClaudeApiResultError extends Error {
  readonly sdkErrorCode: SdkErrorCode;

  constructor(sdkErrorCode: SdkErrorCode, resultText: string) {
    super(`Claude API error (${sdkErrorCode}): ${resultText}`);
    this.name = 'ClaudeApiResultError';
    this.sdkErrorCode = sdkErrorCode;
  }
}

/**
 * Map the SDK's typed assistant-message error code onto the existing
 * subprocess retry classes. Auth-shaped codes are non-retryable (operator
 * must fix credentials); transient API states reuse the existing
 * rate_limit/crash backoff. Everything else is 'unknown' — fail fast rather
 * than retry blindly.
 */
function classifySdkErrorCode(code: SdkErrorCode): 'rate_limit' | 'auth' | 'crash' | 'unknown' {
  switch (code) {
    case 'authentication_failed':
    case 'oauth_org_not_allowed':
    case 'billing_error':
      return 'auth';
    case 'rate_limit':
    case 'overloaded':
      return 'rate_limit';
    case 'server_error':
      return 'crash';
    default:
      return 'unknown';
  }
}

function getFirstEventTimeoutMs(): number {
  const raw = process.env.ARCHON_CLAUDE_FIRST_EVENT_TIMEOUT_MS;
  if (raw) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return 60_000;
}

function buildFirstEventHangDiagnostics(
  subprocessEnv: Record<string, string>,
  model: string | undefined
): Record<string, unknown> {
  return {
    subprocessEnvKeys: Object.keys(subprocessEnv),
    parentClaudeKeys: Object.keys(process.env).filter(
      k => k === 'CLAUDECODE' || k.startsWith('CLAUDE_CODE_') || k.startsWith('ANTHROPIC_')
    ),
    model,
    platform: process.platform,
    uid: getProcessUid(),
    isTTY: process.stdout.isTTY ?? false,
    claudeCode: process.env.CLAUDECODE,
    claudeCodeEntrypoint: process.env.CLAUDE_CODE_ENTRYPOINT,
  };
}

class FirstEventTimeoutError extends Error {}

/**
 * Wraps an async generator so that the first call to .next() must resolve
 * within `timeoutMs`. If it doesn't, aborts the controller and throws.
 */
export async function* withFirstMessageTimeout<T>(
  gen: AsyncGenerator<T>,
  controller: AbortController,
  timeoutMs: number,
  diagnostics: Record<string, unknown>
): AsyncGenerator<T> {
  let timerId: ReturnType<typeof setTimeout> | undefined;
  let firstValue: IteratorResult<T>;
  try {
    firstValue = await Promise.race([
      gen.next(),
      new Promise<never>((_, reject) => {
        timerId = setTimeout(() => {
          reject(new FirstEventTimeoutError());
        }, timeoutMs);
      }),
    ]);
  } catch (err) {
    if (err instanceof FirstEventTimeoutError) {
      controller.abort();
      getLog().error({ ...diagnostics, timeoutMs }, 'claude.first_event_timeout');
      throw new Error(
        'Claude Code subprocess produced no output within ' +
          timeoutMs +
          'ms. ' +
          'See logs for claude.first_event_timeout diagnostic dump. ' +
          'Details: https://github.com/coleam00/Archon/issues/1067'
      );
    }
    throw err;
  } finally {
    clearTimeout(timerId);
  }

  if (firstValue.done) return;
  yield firstValue.value;
  yield* gen;
}

/**
 * Returns the current process UID, or undefined on platforms that don't support it.
 */
export function getProcessUid(): number | undefined {
  return typeof process.getuid === 'function' ? process.getuid() : undefined;
}

// ─── SDK Hooks Building (absorbed from dag-executor) ───────────────────────

/** YAML hook matcher shape (matches @archon/workflows/schemas/dag-node WorkflowNodeHooks) */
interface YAMLHookMatcher {
  matcher?: string;
  response: unknown;
  timeout?: number;
}

type SDKHooksMap = Partial<
  Record<
    string,
    {
      matcher?: string;
      hooks: ((
        input: unknown,
        toolUseID: string | undefined,
        options: { signal: AbortSignal }
      ) => Promise<unknown>)[];
      timeout?: number;
    }[]
  >
>;

/**
 * Convert declarative YAML hook definitions to SDK HookCallbackMatcher arrays.
 */
export function buildSDKHooksFromYAML(
  nodeHooks: Record<string, YAMLHookMatcher[] | undefined>
): SDKHooksMap {
  const sdkHooks: SDKHooksMap = {};

  for (const [event, matchers] of Object.entries(nodeHooks)) {
    if (!matchers) continue;
    sdkHooks[event] = matchers.map(m => ({
      ...(m.matcher ? { matcher: m.matcher } : {}),
      hooks: [async (): Promise<unknown> => m.response],
      ...(m.timeout ? { timeout: m.timeout } : {}),
    }));
  }

  if (Object.keys(sdkHooks).length === 0) {
    getLog().warn(
      { nodeHooksKeys: Object.keys(nodeHooks) },
      'claude.hooks_build_produced_empty_map'
    );
  }

  return sdkHooks;
}

// ─── Provider Warning Type ───────────────────────────────────────────────

/**
 * Structured provider warning. Providers collect these during translation;
 * callers convert them to system chunks before streaming starts.
 */
interface ProviderWarning {
  code: string;
  message: string;
}

// ─── NodeConfig → SDK Options Translation ──────────────────────────────────

/**
 * Translate nodeConfig into Claude SDK-specific options.
 * Called inside sendQuery when nodeConfig is present (workflow path).
 * Returns structured warnings that the caller should yield as system chunks.
 */
async function applyNodeConfig(
  options: Options,
  nodeConfig: NodeConfig,
  cwd: string
): Promise<ProviderWarning[]> {
  const warnings: ProviderWarning[] = [];
  // allowed_tools → tools
  if (nodeConfig.allowed_tools !== undefined) {
    options.tools = nodeConfig.allowed_tools;
  }

  // denied_tools → disallowedTools
  if (nodeConfig.denied_tools !== undefined) {
    options.disallowedTools = nodeConfig.denied_tools;
  }

  // hooks → build SDK hooks
  if (nodeConfig.hooks) {
    const builtHooks = buildSDKHooksFromYAML(
      nodeConfig.hooks as Record<string, YAMLHookMatcher[] | undefined>
    );
    if (Object.keys(builtHooks).length > 0) {
      // Merge with existing hooks (PostToolUse capture hook)
      const existingHooks = options.hooks as SDKHooksMap | undefined;
      if (!options.hooks) {
        (options as Record<string, unknown>).hooks = {};
      }
      for (const [event, matchers] of Object.entries(builtHooks)) {
        if (!matchers) continue;
        const existing = existingHooks?.[event] as HookCallbackMatcher[] | undefined;
        if (existing) {
          (options.hooks as Record<string, HookCallbackMatcher[]>)[event] = [
            ...(matchers as HookCallbackMatcher[]),
            ...existing,
          ];
        } else {
          (options.hooks as Record<string, HookCallbackMatcher[]>)[event] =
            matchers as HookCallbackMatcher[];
        }
      }
    }
  }

  // mcp → load config and set mcpServers + allowedTools wildcards
  if (nodeConfig.mcp) {
    const mcpPath = nodeConfig.mcp;
    const { servers, serverNames, missingVars } = await loadMcpConfig(mcpPath, cwd);
    options.mcpServers = servers as Options['mcpServers'];
    const mcpWildcards = serverNames.map(name => `mcp__${name}__*`);
    options.allowedTools = [...(options.allowedTools ?? []), ...mcpWildcards];
    getLog().info({ serverNames, mcpPath }, 'claude.mcp_config_loaded');
    if (missingVars.length > 0) {
      const uniqueVars = [...new Set(missingVars)];
      getLog().warn({ missingVars: uniqueVars }, 'claude.mcp_env_vars_missing');
      warnings.push({
        code: 'mcp_env_vars_missing',
        message: `MCP config references undefined env vars: ${uniqueVars.join(', ')}. These will be empty strings — MCP servers may fail to authenticate.`,
      });
    }
    // Haiku models don't support tool search (lazy loading for many tools)
    if (options.model?.toLowerCase().includes('haiku')) {
      getLog().warn({ model: options.model }, 'claude.mcp_haiku_tool_search_unsupported');
      warnings.push({
        code: 'mcp_haiku_tool_search',
        message:
          'Using Haiku model with MCP servers — tool search (lazy loading for many tools) is not supported on Haiku. Consider using Sonnet or Opus.',
      });
    }
  }

  // skills → AgentDefinition wrapping
  if (nodeConfig.skills) {
    const skills = nodeConfig.skills;
    const agentId = 'dag-node-skills';
    const agentDef: {
      description: string;
      prompt: string;
      skills: string[];
      tools?: string[];
      model?: string;
    } = {
      description: 'DAG node with skills',
      prompt: `You have preloaded skills: ${skills.join(', ')}. Use them when relevant.`,
      skills,
    };
    if (options.tools) {
      agentDef.tools = [...(options.tools as string[]), 'Skill'];
    }
    if (options.model) agentDef.model = options.model;
    options.agents = { [agentId]: agentDef };
    options.agent = agentId;
    if (!options.allowedTools?.includes('Skill')) {
      options.allowedTools = [...(options.allowedTools ?? []), 'Skill'];
    }
    getLog().info({ skills, agentId }, 'claude.skills_agent_created');
  }

  // agents → inline AgentDefinition pass-through.
  // Runs AFTER skills: so user-defined agents win on ID collision with
  // the internal 'dag-node-skills' wrapper.
  // options.agent is intentionally left alone — inline agents are sub-agents
  // invokable via the Task tool, not the primary agent for the query.
  if (nodeConfig.agents) {
    // Warn loudly when a user-defined agent overrides the internal
    // 'dag-node-skills' wrapper set by the skills: block above. The
    // merge is by design (user wins) but silent capability removal
    // is the exact failure mode we want to avoid.
    if (
      Object.hasOwn(nodeConfig.agents, 'dag-node-skills') &&
      options.agents?.['dag-node-skills'] !== undefined
    ) {
      getLog().warn(
        { nodeSkills: nodeConfig.skills ?? [] },
        'claude.inline_agents_override_skills_wrapper'
      );
    }
    options.agents = {
      ...(options.agents ?? {}),
      ...(nodeConfig.agents as NonNullable<Options['agents']>),
    };
    getLog().info({ agentIds: Object.keys(nodeConfig.agents) }, 'claude.inline_agents_registered');
  }

  // effort
  if (nodeConfig.effort !== undefined) {
    options.effort = nodeConfig.effort as Options['effort'];
  }

  // thinking
  if (nodeConfig.thinking !== undefined) {
    options.thinking = nodeConfig.thinking as Options['thinking'];
  }

  // sandbox
  if (nodeConfig.sandbox !== undefined) {
    options.sandbox = nodeConfig.sandbox as Options['sandbox'];
  }

  // betas
  if (nodeConfig.betas !== undefined) {
    options.betas = nodeConfig.betas as Options['betas'];
  }

  // output_format (from nodeConfig, overrides base outputFormat if present)
  if (nodeConfig.output_format) {
    options.outputFormat = {
      type: 'json_schema',
      schema: nodeConfig.output_format,
    } as Options['outputFormat'];
  }

  // maxBudgetUsd from nodeConfig
  if (nodeConfig.maxBudgetUsd !== undefined) {
    options.maxBudgetUsd = nodeConfig.maxBudgetUsd;
  }

  // systemPrompt from nodeConfig
  if (nodeConfig.systemPrompt !== undefined) {
    options.systemPrompt = nodeConfig.systemPrompt;
  }

  // fallbackModel from nodeConfig
  if (nodeConfig.fallbackModel !== undefined) {
    options.fallbackModel = nodeConfig.fallbackModel;
  }

  // Phase 4 of #975 — enable AI-generated progress summaries for subagents
  // spawned by workflow nodes. Without this, `task_progress` events arrive
  // every ~30s with just `description` + `last_tool_name`; with it, the SDK
  // forks the subagent's session every ~30s to produce a short present-tense
  // `summary` (e.g. "Analyzing auth module"). The fork reuses the subagent's
  // model + prompt cache, so cost stays minimal. Only workflow nodes opt in —
  // direct chat calls (no nodeConfig) skip this to keep the chat surface
  // unchanged. Authors can still override per-node by setting
  // `agentProgressSummaries: false` in nodeConfig (see below).
  if (nodeConfig.agentProgressSummaries !== undefined) {
    options.agentProgressSummaries = nodeConfig.agentProgressSummaries;
  } else {
    options.agentProgressSummaries = true;
  }

  return warnings;
}

// ─── Base Options Builder ────────────────────────────────────────────────

/** Queued tool result from SDK hooks, consumed during stream normalization. */
interface ToolResultEntry {
  toolName: string;
  toolOutput: string;
  toolCallId?: string;
}

/** Bun-runnable JS extensions. `.ts`/`.tsx`/`.jsx` are excluded — the SDK has
 * never shipped those as entry points, so accepting them would only widen the
 * surface for misconfiguration. */
const BUN_JS_EXTENSIONS = ['.js', '.mjs', '.cjs'] as const;

/**
 * Decide whether the Claude subprocess should be spawned with `--no-env-file`.
 *
 * `--no-env-file` is a Bun flag (consumed by the Bun runtime, not by Claude
 * Code itself) that prevents auto-loading `.env` from the target repo cwd
 * into the spawned process. It only does anything when the SDK spawns a
 * Bun-runnable JS file via `bun cli.js …` — Bun parses the flag and skips
 * its env autoload. For native Claude Code binaries the flag is meaningless
 * and, worse, gets handed to the binary which rejects unknown options.
 *
 * The dev-mode `cliPath === undefined` path used to imply "JS executable"
 * because the SDK shipped `cli.js` inside its package. SDK 0.2.x switched
 * to per-platform native binaries (e.g. `@anthropic-ai/claude-agent-sdk-darwin-arm64/claude`),
 * so dev mode now resolves to a native executable and the historical
 * `undefined → true` heuristic is unsafe. Only return `true` when we have
 * an explicit Bun-runnable JS path (`.js`/`.mjs`/`.cjs`) — i.e. when the
 * operator pointed Archon at a legacy Bun/Node-runnable cli script.
 * Otherwise return `false`.
 *
 * Safety: target-repo `.env` leaks are prevented by `stripCwdEnv()` in
 * `@archon/paths` (#1067), which deletes CWD `.env` keys from
 * `process.env` at every Archon entry point before any subprocess is
 * spawned. The native Claude binary does not auto-load `.env` from its
 * cwd either (verified end-to-end with sentinel keys). `--no-env-file`
 * was belt-and-suspenders for the JS-via-Bun case only.
 *
 * Exported so the decision can be unit-tested without needing to mock
 * `BUNDLED_IS_BINARY` or run the full provider sendQuery pathway.
 */
export function shouldPassNoEnvFile(cliPath: string | undefined): boolean {
  if (cliPath === undefined) return false;
  return BUN_JS_EXTENSIONS.some(ext => cliPath.endsWith(ext));
}

/**
 * Build base Claude SDK options from cwd, request options, and assistant defaults.
 * Does not include nodeConfig translation — that is handled by applyNodeConfig.
 */
function buildBaseClaudeOptions(
  cwd: string,
  requestOptions: SendQueryOptions | undefined,
  assistantDefaults: ReturnType<typeof parseClaudeConfig>,
  controller: AbortController,
  stderrLines: string[],
  toolResultQueue: ToolResultEntry[],
  env: NodeJS.ProcessEnv,
  cliPath: string | undefined
): Options {
  const isJsExecutable = shouldPassNoEnvFile(cliPath);
  getLog().debug({ cliPath: cliPath ?? null, isJsExecutable }, 'claude.subprocess_env_file_flag');

  // Container execution: the SDK runs Claude via our `docker exec` spawn hook
  // instead of a local process. When the hook is set the SDK bypasses ALL disk
  // resolution, so `pathToClaudeCodeExecutable` and the host-only
  // `--no-env-file` executableArg are intentionally omitted — the in-container
  // binary is resolved from the runner image's PATH.
  const containerExecContext =
    requestOptions?.execContext?.kind === 'container' ? requestOptions.execContext : undefined;
  const spawnOverride = containerExecContext
    ? { spawnClaudeCodeProcess: buildContainerSpawn(containerExecContext) }
    : {};

  return {
    cwd,
    // In compiled binaries, the resolver supplies an absolute executable path;
    // in dev mode it returns undefined and the SDK resolves from node_modules.
    // Both are skipped for container runs (spawn hook bypasses disk resolution).
    ...(cliPath !== undefined && containerExecContext === undefined
      ? { pathToClaudeCodeExecutable: cliPath }
      : {}),
    ...(isJsExecutable && containerExecContext === undefined
      ? { executableArgs: ['--no-env-file'] }
      : {}),
    ...spawnOverride,
    env,
    model: requestOptions?.model ?? assistantDefaults.model,
    abortController: controller,
    ...(requestOptions?.outputFormat !== undefined
      ? { outputFormat: requestOptions.outputFormat }
      : {}),
    ...(requestOptions?.maxBudgetUsd !== undefined
      ? { maxBudgetUsd: requestOptions.maxBudgetUsd }
      : {}),
    ...(requestOptions?.fallbackModel !== undefined
      ? { fallbackModel: requestOptions.fallbackModel }
      : {}),
    ...(requestOptions?.persistSession !== undefined
      ? { persistSession: requestOptions.persistSession }
      : {}),
    ...(requestOptions?.forkSession !== undefined
      ? { forkSession: requestOptions.forkSession }
      : {}),
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    systemPrompt: requestOptions?.systemPrompt ?? { type: 'preset', preset: 'claude_code' },
    // Per-node override wins over the assistant-level default; the final
    // fallback stays ['project', 'user'] (the SDK-loading default Archon ships).
    settingSources: requestOptions?.nodeConfig?.settingSources ??
      assistantDefaults.settingSources ?? ['project', 'user'],
    hooks: buildToolCaptureHooks(toolResultQueue),
    stderr: (data: string): void => {
      const output = data.trim();
      if (!output) return;
      stderrLines.push(output);

      const isError =
        output.toLowerCase().includes('error') ||
        output.toLowerCase().includes('fatal') ||
        output.toLowerCase().includes('failed') ||
        output.toLowerCase().includes('exception') ||
        output.includes('at ') ||
        output.includes('Error:');

      const isInfoMessage =
        output.includes('Spawning Claude Code') ||
        output.includes('--output-format') ||
        output.includes('--permission-mode');

      if (isError && !isInfoMessage) {
        getLog().error({ stderr: output }, 'subprocess_error');
      }
    },
  };
}

// ─── Tool Capture Hooks ──────────────────────────────────────────────────

/**
 * Build SDK hooks that capture tool use results into a shared queue.
 * The queue is drained during stream normalization.
 */
function buildToolCaptureHooks(toolResultQueue: ToolResultEntry[]): Options['hooks'] {
  return {
    PostToolUse: [
      {
        hooks: [
          (async (input: Record<string, unknown>): Promise<{ continue: true }> => {
            try {
              const toolName = (input as { tool_name?: string }).tool_name ?? 'unknown';
              const toolUseId = (input as { tool_use_id?: string }).tool_use_id;
              const toolResponse = (input as { tool_response?: unknown }).tool_response;
              const output =
                typeof toolResponse === 'string'
                  ? toolResponse
                  : JSON.stringify(toolResponse ?? '');
              const maxLen = 10_000;
              toolResultQueue.push({
                toolName,
                toolOutput: output.length > maxLen ? output.slice(0, maxLen) + '...' : output,
                ...(toolUseId !== undefined ? { toolCallId: toolUseId } : {}),
              });
            } catch (e) {
              getLog().error({ err: e, input }, 'claude.post_tool_use_hook_error');
            }
            return { continue: true };
          }) as HookCallback,
        ],
      },
    ],
    PostToolUseFailure: [
      {
        hooks: [
          (async (input: Record<string, unknown>): Promise<{ continue: true }> => {
            try {
              const toolName = (input as { tool_name?: string }).tool_name ?? 'unknown';
              const toolUseId = (input as { tool_use_id?: string }).tool_use_id;
              const rawError = (input as { error?: string }).error;
              if (rawError === undefined) {
                getLog().debug({ input }, 'claude.post_tool_use_failure_no_error_field');
              }
              const errorText = rawError ?? 'tool failed';
              const isInterrupt = (input as { is_interrupt?: boolean }).is_interrupt === true;
              const prefix = isInterrupt ? '⚠️ Interrupted' : '❌ Error';
              toolResultQueue.push({
                toolName,
                toolOutput: `${prefix}: ${errorText}`,
                ...(toolUseId !== undefined ? { toolCallId: toolUseId } : {}),
              });
            } catch (e) {
              getLog().error({ err: e, input }, 'claude.post_tool_use_failure_hook_error');
            }
            return { continue: true };
          }) as HookCallback,
        ],
      },
    ],
  };
}

// ─── Stream Normalizer ───────────────────────────────────────────────────

/**
 * Normalize raw Claude SDK events into Archon MessageChunks.
 * Drains the tool result queue between events (populated by SDK hooks).
 */
async function* streamClaudeMessages(
  events: AsyncGenerator,
  toolResultQueue: ToolResultEntry[]
): AsyncGenerator<MessageChunk> {
  // Synthetic error message recorded while waiting for the terminal result to
  // confirm it (#1797). Detection is two-signal: the typed wrapper `error`
  // field on a '<synthetic>' assistant message, then `is_error: true` on the
  // result. See ClaudeApiResultError.
  let pendingSdkError: { code: SDKAssistantMessageError; text: string } | undefined;

  // Model the CLI reports it is actually running (`system`/`init`). Recorded so
  // the terminal result can name what ran rather than what was requested.
  let reportedModel: string | undefined;

  for await (const msg of events) {
    // Drain tool results captured by hooks before processing the next event
    while (toolResultQueue.length > 0) {
      const tr = toolResultQueue.shift();
      if (tr) {
        yield {
          type: 'tool_result',
          toolName: tr.toolName,
          toolOutput: tr.toolOutput,
          ...(tr.toolCallId !== undefined ? { toolCallId: tr.toolCallId } : {}),
        };
      }
    }

    const event = msg as { type: string };

    if (event.type === 'assistant') {
      const message = msg as {
        message: { content: ContentBlock[]; model?: string };
        error?: SDKAssistantMessageError;
      };
      const content = message.message.content;

      // API-level failure surfaced as text (#1797): the SDK writes the error
      // prose into a synthesized assistant message instead of throwing. Both
      // signals are required — a REAL model message can carry an error code
      // too (e.g. 'max_output_tokens' on truncated output) and its content
      // must flow through untouched; only '<synthetic>' content is
      // SDK-generated error prose, never model output.
      if (message.error !== undefined && message.message.model === '<synthetic>') {
        const text = content
          .filter(b => b.type === 'text' && b.text)
          .map(b => b.text)
          .join('\n');
        pendingSdkError = { code: message.error, text };
        getLog().warn({ errorCode: message.error, text }, 'claude.synthetic_error_message');
        // Withhold the error prose from the output stream — yielding it is
        // what poisons downstream $node.output. If the terminal result
        // contradicts (no is_error), the text is yielded late as a fail-safe.
        continue;
      }

      for (const block of content) {
        if (block.type === 'text' && block.text) {
          yield { type: 'assistant', content: block.text };
        } else if (block.type === 'tool_use' && block.name) {
          yield {
            type: 'tool',
            toolName: block.name,
            toolInput: block.input ?? {},
            ...(block.id !== undefined ? { toolCallId: block.id } : {}),
          };
        }
      }
    } else if (event.type === 'system') {
      const sysMsg = msg as {
        subtype?: string;
        /** Model the CLI resolved for this session (`init` only). */
        model?: string;
        mcp_servers?: { name: string; status: string }[];
        // Subagent task lifecycle (Claude SDK v0.2.89+)
        task_id?: string;
        tool_use_id?: string;
        description?: string;
        task_type?: string;
        prompt?: string;
        summary?: string;
        usage?: { total_tokens: number; tool_uses: number; duration_ms: number };
        last_tool_name?: string;
        status?: string;
        output_file?: string;
        skip_transcript?: boolean;
        // Background-task set (Claude SDK v0.3.209+ `background_tasks_changed`)
        tasks?: { task_id: string; task_type: string; description: string }[];
        // Hook lifecycle (Claude SDK v0.2.89+)
        hook_id?: string;
        hook_name?: string;
        hook_event?: string;
        outcome?: 'success' | 'error' | 'cancelled';
        exit_code?: number;
      };
      const subtype = sysMsg.subtype;
      // Record the resolved model on EVERY init, independently of the
      // mcp_servers branch below — an init without MCP servers still names the
      // model, and settlement must not lose it just because nothing was mounted.
      if (subtype === 'init' && typeof sysMsg.model === 'string' && sysMsg.model) {
        reportedModel = sysMsg.model;
      }
      if (subtype === 'init' && sysMsg.mcp_servers) {
        const failed = sysMsg.mcp_servers.filter(s => s.status !== 'connected');
        if (failed.length > 0) {
          const names = failed.map(s => `${s.name} (${s.status})`).join(', ');
          yield { type: 'system', content: `MCP server connection failed: ${names}` };
        }
      } else if (subtype === 'task_started' && sysMsg.task_id) {
        // Ambient / housekeeping tasks (SDK signals via skip_transcript) are
        // SDK-internal — they bloat the Web UI's tasks panel without telling
        // the user anything actionable. Drop them at the provider boundary;
        // the workflow executor and SSE bridge never see them.
        if (sysMsg.skip_transcript === true) {
          getLog().debug(
            { taskId: sysMsg.task_id, taskType: sysMsg.task_type },
            'claude.task_started_housekeeping_suppressed'
          );
        } else {
          yield {
            type: 'task_started',
            taskId: sysMsg.task_id,
            description: sysMsg.description ?? '',
            ...(sysMsg.task_type !== undefined ? { taskType: sysMsg.task_type } : {}),
            ...(sysMsg.prompt !== undefined ? { prompt: sysMsg.prompt } : {}),
            ...(sysMsg.tool_use_id !== undefined ? { toolUseId: sysMsg.tool_use_id } : {}),
          };
        }
      } else if (subtype === 'task_progress' && sysMsg.task_id) {
        yield {
          type: 'task_progress',
          taskId: sysMsg.task_id,
          description: sysMsg.description ?? '',
          ...(sysMsg.summary !== undefined ? { summary: sysMsg.summary } : {}),
          ...(sysMsg.usage !== undefined ? { usage: sysMsg.usage } : {}),
          ...(sysMsg.last_tool_name !== undefined ? { lastToolName: sysMsg.last_tool_name } : {}),
          ...(sysMsg.tool_use_id !== undefined ? { toolUseId: sysMsg.tool_use_id } : {}),
        };
      } else if (subtype === 'task_notification' && sysMsg.task_id) {
        const status = sysMsg.status;
        if (status !== 'completed' && status !== 'failed' && status !== 'stopped') {
          getLog().warn(
            { taskId: sysMsg.task_id, status },
            'claude.task_notification_unknown_status'
          );
          // Fall through with raw status to avoid dropping the event entirely
        }
        yield {
          type: 'task_notification',
          taskId: sysMsg.task_id,
          status:
            status === 'completed' || status === 'failed' || status === 'stopped'
              ? status
              : 'stopped',
          summary: sysMsg.summary ?? '',
          outputFile: sysMsg.output_file ?? '',
          ...(sysMsg.usage !== undefined ? { usage: sysMsg.usage } : {}),
          ...(sysMsg.tool_use_id !== undefined ? { toolUseId: sysMsg.tool_use_id } : {}),
        };
      } else if (subtype === 'background_tasks_changed') {
        // Level signal: the FULL set of live background tasks after a membership
        // change (REPLACE semantics — see the MessageChunk variant docs). An
        // empty `tasks` array is meaningful ("all drained") and MUST be
        // forwarded, so no `&& sysMsg.tasks` guard here.
        const tasks = Array.isArray(sysMsg.tasks) ? sysMsg.tasks : [];
        yield {
          type: 'background_tasks',
          tasks: tasks.map(t => ({
            taskId: t.task_id,
            taskType: t.task_type,
            description: t.description,
          })),
        };
      } else if (subtype === 'hook_started' && sysMsg.hook_id) {
        yield {
          type: 'hook_started',
          hookId: sysMsg.hook_id,
          hookName: sysMsg.hook_name ?? '',
          hookEvent: sysMsg.hook_event ?? '',
        };
      } else if (subtype === 'hook_response' && sysMsg.hook_id) {
        const outcome = sysMsg.outcome;
        yield {
          type: 'hook_response',
          hookId: sysMsg.hook_id,
          hookName: sysMsg.hook_name ?? '',
          hookEvent: sysMsg.hook_event ?? '',
          outcome:
            outcome === 'success' || outcome === 'error' || outcome === 'cancelled'
              ? outcome
              : 'error',
          ...(sysMsg.exit_code !== undefined ? { exitCode: sysMsg.exit_code } : {}),
        };
      } else {
        getLog().debug({ subtype: sysMsg.subtype }, 'claude.system_message_unhandled');
      }
    } else if (event.type === 'rate_limit_event') {
      const rateLimitMsg = msg as { rate_limit_info?: Record<string, unknown> };
      getLog().warn({ rateLimitInfo: rateLimitMsg.rate_limit_info }, 'claude.rate_limit_event');
      yield { type: 'rate_limit', rateLimitInfo: rateLimitMsg.rate_limit_info ?? {} };
    } else if (event.type === 'result') {
      const resultMsg = msg as {
        session_id?: string;
        is_error?: boolean;
        subtype?: string;
        usage?: {
          input_tokens?: number;
          output_tokens?: number;
          total_tokens?: number;
          cache_read_input_tokens?: number;
          cache_creation_input_tokens?: number;
        };
        structured_output?: unknown;
        total_cost_usd?: number;
        stop_reason?: string | null;
        num_turns?: number;
        errors?: string[];
        result?: string;
        terminal_reason?: TerminalReason;
        api_error_status?: number | null;
        /**
         * Per-model usage map. The SDK's own type (`SDKResultSuccess` /
         * `SDKResultError` in sdk.d.ts) declares this CAMEL-cased, and the
         * wire payload matches — `model_usage` appears nowhere in sdk.mjs.
         * The snake_cased alias is kept only so an older or re-shaped payload
         * still resolves instead of silently yielding `undefined`; camelCase
         * is authoritative when both are present.
         */
        modelUsage?: Record<string, Record<string, unknown>>;
        model_usage?: Record<string, Record<string, unknown>>;
      };
      // The terminal result resolves any recorded synthetic error message.
      const syntheticError = pendingSdkError;
      pendingSdkError = undefined;
      const tokens = normalizeClaudeUsage(resultMsg.usage);
      const sdkErrors = Array.isArray(resultMsg.errors) ? resultMsg.errors : undefined;

      // `is_error: true` + `subtype: 'success'` is ambiguous: it is BOTH the
      // SDK's stop-sequence termination encoding (#1425, a legitimate success)
      // AND its API-failure-as-text encoding (#1797 — auth/billing/rate-limit
      // errors that even set stop_reason: 'stop_sequence').
      const isSuccessWithErrorFlag = resultMsg.is_error === true && resultMsg.subtype === 'success';

      // Disambiguate structurally: a preceding synthetic error message
      // (primary, typed signal), or a recorded API error status on the result
      // (secondary — catches an error result with no preceding synthetic
      // message), marks a real failure. Throw so callers fail the node/turn
      // instead of consuming error prose as successful output.
      //
      // `api_error_status` is the SDK's only typed API-error field on the
      // success-shaped result (SDKResultSuccess). It is null/absent on clean
      // turns and on the #1425 stop-sequence carve-out. `terminal_reason`
      // cannot serve as this signal: its union ('model_error', 'max_turns',
      // 'completed', …) has no API-error member, so testing it against
      // 'api_error' was statically dead and let a status-only API error
      // through as successful output.
      //
      // Any recorded numeric status counts, not just >= 400: `is_error` is
      // already true on this path, so under-detecting here would re-poison
      // downstream output with error prose — the exact failure this guard exists
      // to prevent.
      const hasApiErrorStatus = typeof resultMsg.api_error_status === 'number';

      if (isSuccessWithErrorFlag && (syntheticError !== undefined || hasApiErrorStatus)) {
        const code = syntheticError?.code ?? 'unknown';
        const text =
          syntheticError?.text ||
          resultMsg.result ||
          sdkErrors?.join('; ') ||
          'API error result with no error text';
        getLog().error(
          {
            sessionId: resultMsg.session_id,
            errorCode: code,
            terminalReason: resultMsg.terminal_reason,
            apiErrorStatus: resultMsg.api_error_status,
            text,
          },
          'claude.result_api_error'
        );
        throw new ClaudeApiResultError(code, text);
      }

      // Fail-safe (never observed in practice): a synthetic error message
      // followed by a non-error result. Yield the withheld text late rather
      // than silently swallowing content.
      if (syntheticError !== undefined && resultMsg.is_error !== true) {
        getLog().warn(
          { sessionId: resultMsg.session_id, errorCode: syntheticError.code },
          'claude.synthetic_error_not_confirmed'
        );
        yield { type: 'assistant', content: syntheticError.text };
      }

      // SDKResultSuccess declares `is_error: boolean` (not literal false). When a
      // model terminates via a configured stop sequence (stop_reason ===
      // 'stop_sequence') the SDK can set is_error: true while keeping
      // subtype: 'success' — its encoding of "non-default termination, not a
      // failure". Treat that pair as a clean success so downstream consumers
      // (which gate failure on isError) don't misclassify it.
      const isRealError = resultMsg.is_error === true && !isSuccessWithErrorFlag;
      if (isRealError) {
        getLog().error(
          {
            sessionId: resultMsg.session_id,
            errorSubtype: resultMsg.subtype,
            stopReason: resultMsg.stop_reason,
            errors: sdkErrors,
          },
          'claude.result_is_error'
        );
      } else if (isSuccessWithErrorFlag) {
        getLog().debug(
          {
            sessionId: resultMsg.session_id,
            stopReason: resultMsg.stop_reason,
          },
          'claude.result_success_validated'
        );
      }
      const modelUsage = resultMsg.modelUsage ?? resultMsg.model_usage;
      // Prefer the model the CLI announced at init; fall back to a single-entry
      // usage map. A multi-model run (fallback/subagents) is left unnamed rather
      // than guessed — bounded mode forbids both, so an unnamed model there is
      // itself a signal worth surfacing instead of papering over.
      const modelUsageKeys = modelUsage ? Object.keys(modelUsage) : [];
      const resolvedModel =
        reportedModel ?? (modelUsageKeys.length === 1 ? modelUsageKeys[0] : undefined);
      yield {
        type: 'result',
        sessionId: resultMsg.session_id,
        ...(resolvedModel !== undefined ? { model: resolvedModel } : {}),
        ...(tokens ? { tokens } : {}),
        ...(resultMsg.structured_output !== undefined
          ? { structuredOutput: resultMsg.structured_output }
          : {}),
        ...(isRealError ? { isError: true, errorSubtype: resultMsg.subtype } : {}),
        ...(isRealError && sdkErrors?.length ? { errors: sdkErrors } : {}),
        ...(resultMsg.total_cost_usd !== undefined ? { cost: resultMsg.total_cost_usd } : {}),
        ...(resultMsg.stop_reason != null ? { stopReason: resultMsg.stop_reason } : {}),
        ...(resultMsg.num_turns !== undefined ? { numTurns: resultMsg.num_turns } : {}),
        ...(modelUsage ? { modelUsage: modelUsage as Record<string, unknown> } : {}),
      };
    }
  }

  // Stream ended after a synthetic error message with no terminal result to
  // confirm or contradict it. A dangling synthetic error is a failure — the
  // SDK ends every turn with a result, so this is an abnormal end (#1797).
  if (pendingSdkError !== undefined) {
    getLog().error(
      { errorCode: pendingSdkError.code, text: pendingSdkError.text },
      'claude.synthetic_error_stream_ended'
    );
    throw new ClaudeApiResultError(pendingSdkError.code, pendingSdkError.text);
  }

  // Drain any remaining tool results after the stream ends
  while (toolResultQueue.length > 0) {
    const tr = toolResultQueue.shift();
    if (tr) {
      yield {
        type: 'tool_result',
        toolName: tr.toolName,
        toolOutput: tr.toolOutput,
        ...(tr.toolCallId !== undefined ? { toolCallId: tr.toolCallId } : {}),
      };
    }
  }
}

// ─── Error Classification & Retry ────────────────────────────────────────

/**
 * Classify a subprocess error and enrich with stderr context.
 * Returns null if the error should be retried (caller handles retry logic).
 */
function classifyAndEnrichError(
  error: Error,
  stderrLines: string[],
  controller: AbortController
): { enrichedError: Error; errorClass: string; shouldRetry: boolean } {
  // If the controller was aborted by withFirstMessageTimeout, the original
  // timeout error carries the diagnostic message and #1067 breadcrumb.
  // Preserve it instead of collapsing into a generic "Query aborted".
  if (controller.signal.aborted) {
    if (error.message.includes('produced no output within')) {
      return { enrichedError: error, errorClass: 'timeout', shouldRetry: false };
    }
    return {
      enrichedError: new Error('Query aborted'),
      errorClass: 'aborted',
      shouldRetry: false,
    };
  }

  // API failures the SDK surfaced as text (#1797) carry a typed error code —
  // classify by that code, never by matching the (arbitrary) message text.
  if (error instanceof ClaudeApiResultError) {
    let errorClass = classifySdkErrorCode(error.sdkErrorCode);
    // Exception for the SDK's catch-all codes only ('unknown'/'invalid_request'
    // — a 400 status maps here): they conflate transient server-side rejections
    // with true client errors, so the code alone carries no retry signal. For
    // those, and ONLY those, fall back to UNTYPED_TRANSIENT_PATTERNS (see its
    // admission contract) to reclassify known-transient errors as rate_limit
    // so the existing backoff applies (#1341). Specific typed codes above
    // remain authoritative and are never overridden by text.
    if (errorClass === 'unknown') {
      const message = error.message.toLowerCase();
      if (UNTYPED_TRANSIENT_PATTERNS.some(p => message.includes(p))) {
        errorClass = 'rate_limit';
      }
    }
    return {
      enrichedError: error,
      errorClass,
      shouldRetry: errorClass === 'rate_limit' || errorClass === 'crash',
    };
  }

  const stderrContext = stderrLines.join('\n');
  const errorClass = classifySubprocessError(error.message, stderrContext);

  if (errorClass === 'auth') {
    const enrichedError = new Error(
      `Claude Code auth error: ${error.message}${stderrContext ? ` (${stderrContext})` : ''}`
    );
    enrichedError.cause = error;
    return { enrichedError, errorClass, shouldRetry: false };
  }

  const enrichedMessage = stderrContext
    ? `Claude Code ${errorClass}: ${error.message} (stderr: ${stderrContext})`
    : `Claude Code ${errorClass}: ${error.message}`;
  const enrichedError = new Error(enrichedMessage);
  enrichedError.cause = error;
  const shouldRetry = errorClass === 'rate_limit' || errorClass === 'crash';
  return { enrichedError, errorClass, shouldRetry };
}

// ─── Claude Provider ───────────────────────────────────────────────────────

/**
 * Claude AI agent provider.
 * Implements IAgentProvider with full SDK integration.
 *
 * sendQuery orchestrates the following internal helpers:
 * - buildBaseClaudeOptions: SDK option construction
 * - applyNodeConfig: workflow nodeConfig → SDK option translation + warnings
 * - streamClaudeMessages: raw SDK event normalization into MessageChunks
 * - classifyAndEnrichError: error classification for retry decisions
 */
export class ClaudeProvider implements IAgentProvider {
  private readonly retryBaseDelayMs: number;

  constructor(options?: { retryBaseDelayMs?: number }) {
    if (getProcessUid() === 0 && process.env.IS_SANDBOX !== '1') {
      throw new Error(
        'Claude Code SDK does not support bypassPermissions when running as root (UID 0). ' +
          'Run as a non-root user, set IS_SANDBOX=1, or use the Dockerfile which creates a non-root appuser.'
      );
    }
    this.retryBaseDelayMs = options?.retryBaseDelayMs ?? RETRY_BASE_DELAY_MS;
  }

  getCapabilities(): ProviderCapabilities {
    return CLAUDE_CAPABILITIES;
  }

  /**
   * Send a query to Claude and stream responses.
   * Orchestrates option building, nodeConfig translation, streaming, and retry.
   */
  // TODO(#1135): Pre-spawn env-leak gate was removed during provider extraction.
  // Caller-side enforcement (orchestrator, dag-executor) is tracked in #1135.
  // Providers must NOT implement security gates — the platform guarantees safety
  // before a provider runs.
  async *sendQuery(
    prompt: string,
    cwd: string,
    resumeSessionId?: string,
    requestOptions?: SendQueryOptions
  ): AsyncGenerator<MessageChunk> {
    let lastError: Error | undefined;

    // Bounded mode is refused-or-honored before ANY work happens: resolution,
    // env building and subprocess spawn all cost something, and a request that
    // cannot be bounded must not reach any of them.
    const bounded = requestOptions?.bounded;
    if (bounded && requestOptions) {
      const violations = findBoundedModeViolations(resumeSessionId, requestOptions);
      if (violations.length > 0) {
        getLog().error({ violations }, 'claude.bounded_mode_refused');
        throw new BoundedModeViolationError(violations);
      }
    }
    const maxSubprocessRetries = resolveMaxSubprocessRetries(requestOptions);

    const assistantDefaults = parseClaudeConfig(requestOptions?.assistantConfig ?? {});

    // Resolve Claude CLI path once before the retry loop. In binary mode this
    // throws immediately if neither env nor config supplies a valid path, so
    // the user gets a clean error rather than N retries of "Module not found".
    // SKIP entirely for container runs: the SDK bypasses disk resolution when
    // `spawnClaudeCodeProcess` is set (buildBaseClaudeOptions omits
    // pathToClaudeCodeExecutable), and Claude is baked into the runner image — a
    // compiled Archon binary has no host Claude, so resolving it here would throw
    // and kill an otherwise-valid container run.
    const isContainerRun = requestOptions?.execContext?.kind === 'container';
    const resolvedCliPath = isContainerRun
      ? undefined
      : await resolveClaudeBinaryPath(assistantDefaults.claudeBinaryPath);

    // Build subprocess env once (avoids re-logging auth mode per retry). A
    // container run gets ONLY the Archon-managed bag + a minimal base — host
    // process.env never crosses the boundary (the isolation invariant); the host
    // path inherits the (already-cleaned) process env exactly as before.
    const env = buildRequestSubprocessEnv(requestOptions);

    // Apply nodeConfig translation once (deterministic, not retry-dependent)
    // We need a throwaway Options to extract warnings from applyNodeConfig,
    // then re-apply per attempt. But nodeConfig warnings are deterministic,
    // so we compute them once and yield them before the first attempt.
    let nodeConfigWarnings: ProviderWarning[] = [];
    if (requestOptions?.nodeConfig) {
      const tempOptions: Options = {} as Options;
      nodeConfigWarnings = await applyNodeConfig(tempOptions, requestOptions.nodeConfig, cwd);
    }

    // Yield provider warnings once before retries
    for (const warning of nodeConfigWarnings) {
      yield { type: 'system' as const, content: `⚠️ ${warning.message}` };
    }

    // Track the current attempt's controller so a single abort listener
    // can forward cancellation without accumulating per-retry listeners.
    let currentController: AbortController | undefined;
    const onAbort = (): void => {
      currentController?.abort();
    };
    if (requestOptions?.abortSignal) {
      requestOptions.abortSignal.addEventListener('abort', onAbort, { once: true });
    }

    for (let attempt = 0; attempt <= maxSubprocessRetries; attempt++) {
      if (requestOptions?.abortSignal?.aborted) {
        throw new Error('Query aborted');
      }

      const stderrLines: string[] = [];
      const toolResultQueue: ToolResultEntry[] = [];
      const controller = new AbortController();
      currentController = controller;

      // 1. Build SDK options (env and cliPath pre-computed above)
      const options = buildBaseClaudeOptions(
        cwd,
        requestOptions,
        assistantDefaults,
        controller,
        stderrLines,
        toolResultQueue,
        env,
        resolvedCliPath
      );

      // 2. Apply nodeConfig translation (re-applied per attempt since options are fresh)
      if (requestOptions?.nodeConfig) {
        await applyNodeConfig(options, requestOptions.nodeConfig, cwd);
      }

      // 2b. Register in-process native tools (e.g. manage_run) as an archon MCP
      //     server, mirroring the file-based mcp branch. Merge so a nodeConfig
      //     mcp config and native tools can coexist.
      if (requestOptions?.nativeTools && requestOptions.nativeTools.length > 0) {
        const server = buildArchonMcpServer(requestOptions.nativeTools);
        options.mcpServers = { ...(options.mcpServers ?? {}), [ARCHON_TOOL_SERVER]: server };
        options.allowedTools = [...(options.allowedTools ?? []), `mcp__${ARCHON_TOOL_SERVER}__*`];
        getLog().info(
          { count: requestOptions.nativeTools.length },
          'claude.native_tools_registered'
        );
      }

      // 3. Set session resume
      if (resumeSessionId) {
        options.resume = resumeSessionId;
        getLog().debug(
          { sessionId: resumeSessionId, forkSession: requestOptions?.forkSession },
          'resuming_session'
        );
      } else {
        getLog().debug({ cwd, attempt }, 'starting_new_session');
      }

      // 3b. Bounded mode LAST — after nodeConfig, native tools and resume have
      //     all written to `options`, so the declared bound is the final word.
      if (bounded) {
        applyBoundedMode(options, bounded);
        getLog().info(
          {
            maxTurns: options.maxTurns,
            maxBudgetUsd: options.maxBudgetUsd,
            maxSubprocessRetries,
            disallowedTools: options.disallowedTools,
            settingSources: options.settingSources,
          },
          'claude.bounded_mode_applied'
        );
      }

      try {
        // 4. Run query with first-event timeout protection
        const rawEvents = query({ prompt, options });
        const timeoutMs = getFirstEventTimeoutMs();
        const diagnostics = buildFirstEventHangDiagnostics(
          options.env as Record<string, string>,
          options.model
        );
        const events = withFirstMessageTimeout(rawEvents, controller, timeoutMs, diagnostics);

        // 5. Stream normalized events
        // Claude resumes-or-errors: an invalid resume id throws (and is
        // retried/surfaced), so reaching the result stream means the prior
        // session was restored. Hence `true` whenever a resume was requested.
        yield* withResumedOutcome(
          streamClaudeMessages(events, toolResultQueue),
          resumedOutcome(resumeSessionId, true)
        );
        return;
      } catch (error) {
        const err = error as Error;
        const { enrichedError, errorClass, shouldRetry } = classifyAndEnrichError(
          err,
          stderrLines,
          controller
        );

        getLog().error(
          {
            err,
            stderrContext: stderrLines.join('\n'),
            errorClass,
            attempt,
            maxRetries: maxSubprocessRetries,
          },
          'query_error'
        );

        if (!shouldRetry || attempt >= maxSubprocessRetries) {
          throw enrichedError;
        }

        const delayMs = this.retryBaseDelayMs * Math.pow(2, attempt);
        getLog().info({ attempt, delayMs, errorClass }, 'retrying_subprocess');
        await new Promise(resolve => setTimeout(resolve, delayMs));
        lastError = enrichedError;
      }
    }

    throw lastError ?? new Error('Claude Code query failed after retries');
  }

  getType(): string {
    return 'claude';
  }
}
