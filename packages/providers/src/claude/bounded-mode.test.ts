/**
 * Bounded-mode coverage for the Claude provider, driven by a FAKE SDK
 * SUBPROCESS rather than a mocked `query()`.
 *
 * The real @anthropic-ai/claude-agent-sdk builds the argv and speaks the
 * stream-json protocol; `__fixtures__/fake-claude-cli.mjs` stands in for the
 * CLI. That is what makes these assertions meaningful — every claim about a
 * bound is checked against the flags and environment that genuinely reached a
 * spawned process, not against our own idea of them.
 *
 * NO PROVIDER CALL: nothing here contacts Anthropic, and the fake needs no
 * credentials. `CLAUDE_BIN_PATH` points the resolver at the fixture.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  ClaudeProvider,
  findBoundedModeViolations,
  BOUNDED_MODE_DISALLOWED_TOOLS,
} from './provider';
import { BoundedModeViolationError } from '../errors';
import type { BoundedModeOptions, MessageChunk, SendQueryOptions } from '../types';

const FIXTURE = resolve(import.meta.dir, '__fixtures__', 'fake-claude-cli.mjs');

let workDir: string;
let logPath: string;
const savedEnv: Record<string, string | undefined> = {};

const ENV_KEYS = [
  'CLAUDE_BIN_PATH',
  'FAKE_CLAUDE_LOG',
  'FAKE_CLAUDE_SCENARIO',
  'FAKE_CLAUDE_EXIT_CODE',
  'ANTHROPIC_API_KEY',
  'CLAUDE_API_KEY',
  // The ClaudeProvider constructor refuses to build under UID 0 unless
  // IS_SANDBOX=1. Pinned per-test (same pattern as provider.test.ts) so the
  // suite behaves identically as root and as a normal user.
  'IS_SANDBOX',
] as const;

beforeEach(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  workDir = mkdtempSync(join(tmpdir(), 'archon-bounded-'));
  logPath = join(workDir, 'fake-claude.jsonl');
  process.env.CLAUDE_BIN_PATH = FIXTURE;
  process.env.FAKE_CLAUDE_LOG = logPath;
  // A dummy key so the provider's auth mirroring has something to do; the fake
  // never reads it and never contacts a provider.
  process.env.ANTHROPIC_API_KEY = 'test-not-a-real-key';
  delete process.env.CLAUDE_API_KEY;
  process.env.IS_SANDBOX = '1';
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  rmSync(workDir, { recursive: true, force: true });
});

interface SpawnRecord {
  kind: string;
  argv?: string[];
  env?: Record<string, string | null>;
  request?: { subtype?: string; systemPrompt?: string[] };
  message?: { content?: { type: string; text?: string }[] };
}

function readLog(): SpawnRecord[] {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(l => JSON.parse(l) as SpawnRecord);
}

function spawns(): SpawnRecord[] {
  return readLog().filter(r => r.kind === 'spawn');
}

/** Value that follows `flag` in argv, or undefined when the flag is absent. */
function argValue(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

function boundedOptions(overrides: Partial<BoundedModeOptions> = {}): BoundedModeOptions {
  return {
    maxTurns: 3,
    maxBudgetUsd: 1.25,
    maxSubprocessRetries: 0,
    settingSources: [],
    maxOutputTokens: 8000,
    maxContextTokens: 120_000,
    ...overrides,
  };
}

async function run(
  options: Partial<SendQueryOptions> = {},
  prompt = 'bounded canary task'
): Promise<MessageChunk[]> {
  const provider = new ClaudeProvider({ retryBaseDelayMs: 1 });
  const chunks: MessageChunk[] = [];
  for await (const chunk of provider.sendQuery(prompt, workDir, undefined, {
    model: 'claude-sonnet-5',
    systemPrompt: 'BOUNDED SYSTEM PROMPT',
    bounded: boundedOptions(),
    persistSession: false,
    ...options,
  })) {
    chunks.push(chunk);
  }
  return chunks;
}

function resultChunk(chunks: MessageChunk[]): Extract<MessageChunk, { type: 'result' }> {
  const r = chunks.find(c => c.type === 'result');
  if (!r || r.type !== 'result') throw new Error('no result chunk was produced');
  return r;
}

describe('bounded mode — what actually reaches the SDK subprocess', () => {
  test('maxTurns and maxBudgetUsd are passed to the installed SDK as CLI flags', async () => {
    await run();

    const [spawn] = spawns();
    expect(spawn).toBeDefined();
    const argv = spawn.argv ?? [];
    // The whole point of the fake subprocess: these are the flags the SDK
    // genuinely emitted, not options we handed to a mock.
    expect(argValue(argv, '--max-turns')).toBe('3');
    expect(argValue(argv, '--max-budget-usd')).toBe('1.25');
    expect(argValue(argv, '--model')).toBe('claude-sonnet-5');
  });

  test('Task is disallowed, so subagents cannot be spawned', async () => {
    await run();

    const argv = spawns()[0].argv ?? [];
    const disallowed = (argValue(argv, '--disallowedTools') ?? '').split(',');
    expect(disallowed).toContain('Task');
    expect(BOUNDED_MODE_DISALLOWED_TOOLS).toContain('Task');
  });

  test('extra disallowed tools are unioned with the mandatory set, never replacing it', async () => {
    await run({ bounded: boundedOptions({ extraDisallowedTools: ['WebFetch', 'Bash'] }) });

    const argv = spawns()[0].argv ?? [];
    const disallowed = (argValue(argv, '--disallowedTools') ?? '').split(',');
    expect(disallowed).toContain('Task');
    expect(disallowed).toContain('WebFetch');
    expect(disallowed).toContain('Bash');
  });

  test('no fork, no fallback model, and no custom agents reach the CLI', async () => {
    await run();

    const argv = spawns()[0].argv ?? [];
    expect(argv).not.toContain('--fork-session');
    expect(argv).not.toContain('--fallback-model');
    expect(argv).not.toContain('--agents');
  });

  test('setting sources are empty, so no CLAUDE.md, skills, commands or agents load', async () => {
    await run();

    const argv = spawns()[0].argv ?? [];
    // The SDK emits this as a single `--setting-sources=<csv>` token.
    expect(argv).toContain('--setting-sources=');
  });

  test('the output and context caps reach the subprocess environment with DISABLE_COMPACT', async () => {
    await run();

    const env = spawns()[0].env ?? {};
    expect(env.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe('8000');
    expect(env.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBe('120000');
    // The CLI only honors the context cap alongside DISABLE_COMPACT, and
    // disabling compaction also removes its unbudgeted summarization calls.
    expect(env.DISABLE_COMPACT).toBe('1');
  });

  test('a caller-supplied env cannot loosen the declared caps', async () => {
    await run({
      env: {
        CLAUDE_CODE_MAX_OUTPUT_TOKENS: '999999',
        DISABLE_COMPACT: '0',
        ANTHROPIC_API_KEY: 'test-not-a-real-key',
      },
    });

    const env = spawns()[0].env ?? {};
    expect(env.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe('8000');
    expect(env.DISABLE_COMPACT).toBe('1');
  });

  test('the complete effective prompt is exactly the system prompt plus the task prompt', async () => {
    await run({}, 'the only user content');

    const log = readLog();
    const init = log.find(r => r.kind === 'control_request');
    const user = log.find(r => r.kind === 'user_message');

    // Measured from what the SDK transmitted, not from what we intended.
    expect(init?.request?.systemPrompt).toEqual(['BOUNDED SYSTEM PROMPT']);
    expect(user?.message?.content?.[0]?.text).toBe('the only user content');
  });
});

describe('bounded mode — terminal aggregates', () => {
  test('success records model, usage with cache split, turns and cost', async () => {
    process.env.FAKE_CLAUDE_SCENARIO = 'success';
    const result = resultChunk(await run());

    expect(result.isError).toBeUndefined();
    // Model comes from the SDK's own init message — what RAN, not what we asked for.
    expect(result.model).toBe('claude-sonnet-5');
    expect(result.tokens).toEqual({
      input: 1200,
      output: 340,
      cacheRead: 64,
      cacheCreation: 16,
    });
    expect(result.numTurns).toBe(2);
    expect(result.cost).toBe(0.0087);
    // modelUsage is camelCase on the wire; reading `model_usage` would silently
    // yield undefined and lose the per-model breakdown entirely.
    expect(result.modelUsage).toBeDefined();
    expect(Object.keys(result.modelUsage ?? {})).toEqual(['claude-sonnet-5']);
  });

  test('max-turn exhaustion still carries the full aggregate and its own subtype', async () => {
    process.env.FAKE_CLAUDE_SCENARIO = 'max_turns';
    const result = resultChunk(await run());

    expect(result.isError).toBe(true);
    expect(result.errorSubtype).toBe('error_max_turns');
    expect(result.numTurns).toBe(3);
    expect(result.cost).toBe(0.42);
    expect(result.tokens).toEqual({ input: 1200, output: 340 });
  });

  test('max-budget exhaustion still carries the full aggregate and its own subtype', async () => {
    process.env.FAKE_CLAUDE_SCENARIO = 'max_budget';
    const result = resultChunk(await run());

    expect(result.isError).toBe(true);
    expect(result.errorSubtype).toBe('error_max_budget_usd');
    expect(result.numTurns).toBe(2);
    expect(result.cost).toBe(1.07);
  });

  test('a terminal result with no usage yields no token block rather than a fabricated zero', async () => {
    process.env.FAKE_CLAUDE_SCENARIO = 'no_usage';
    const result = resultChunk(await run());

    expect(result.isError).toBe(true);
    expect(result.errorSubtype).toBe('error_during_execution');
    // Absent, NOT {input: 0, output: 0} — a zero would read as "this cost nothing".
    expect(result.tokens).toBeUndefined();
    expect(result.cost).toBeUndefined();
    expect(result.numTurns).toBe(1);
  });
});

describe('bounded mode — subprocess retry suppression', () => {
  test('a dying subprocess is spawned exactly once when retries are zero', async () => {
    process.env.FAKE_CLAUDE_SCENARIO = 'crash';

    await expect(run()).rejects.toThrow();

    // One spawn, one charge. Archon's default would have spawned four, each a
    // fresh billed model session invisible to the caller.
    expect(spawns()).toHaveLength(1);
  });

  test('without bounded mode the same failure still retries — normal behaviour is unchanged', async () => {
    process.env.FAKE_CLAUDE_SCENARIO = 'crash';

    const provider = new ClaudeProvider({ retryBaseDelayMs: 1 });
    await expect(
      (async () => {
        for await (const _ of provider.sendQuery('unbounded task', workDir, undefined, {
          model: 'claude-sonnet-5',
          persistSession: false,
        })) {
          // drain
        }
      })()
    ).rejects.toThrow();

    // 1 initial attempt + MAX_SUBPROCESS_RETRIES (3). This is the multiplier the
    // bounded path removes; asserting it here proves the removal is scoped to
    // bounded mode rather than applied globally.
    expect(spawns()).toHaveLength(4);
  });
});

describe('bounded mode — refusals before any spawn', () => {
  /** Assert the request was refused AND that nothing was spawned. */
  async function expectRefusedWithoutSpawning(
    options: Partial<SendQueryOptions>,
    resumeSessionId?: string
  ): Promise<BoundedModeViolationError> {
    const provider = new ClaudeProvider({ retryBaseDelayMs: 1 });
    let caught: unknown;
    try {
      for await (const _ of provider.sendQuery('task', workDir, resumeSessionId, {
        model: 'claude-sonnet-5',
        systemPrompt: 'BOUNDED SYSTEM PROMPT',
        bounded: boundedOptions(),
        ...options,
      })) {
        // drain
      }
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(BoundedModeViolationError);
    // The refusal must cost nothing — no subprocess, no model call.
    expect(spawns()).toHaveLength(0);
    return caught as BoundedModeViolationError;
  }

  test('an attempted session fork is refused, not silently ignored', async () => {
    const err = await expectRefusedWithoutSpawning({ forkSession: true });
    expect(err.violations.join(' ')).toContain('forkSession');
  });

  test('an attempted fallback model is refused', async () => {
    const err = await expectRefusedWithoutSpawning({ fallbackModel: 'claude-haiku-4-5' });
    expect(err.violations.join(' ')).toContain('fallbackModel');
  });

  test('an attempted session resume is refused — its transcript is unmeasurable', async () => {
    const err = await expectRefusedWithoutSpawning({}, 'prior-session-id');
    expect(err.violations.join(' ')).toContain('resumeSessionId');
  });

  test('nodeConfig is refused because it can reintroduce agents, MCP and skills', async () => {
    const err = await expectRefusedWithoutSpawning({
      nodeConfig: { agents: { helper: { description: 'd', prompt: 'p' } } },
    });
    expect(err.violations.join(' ')).toContain('nodeConfig');
  });

  test('native tools are refused because their definitions are unmeasured prompt content', async () => {
    const err = await expectRefusedWithoutSpawning({
      nativeTools: [
        {
          name: 'manage_run',
          description: 'd',
          inputSchema: { type: 'object' },
          handler: async () => 'ok',
        },
      ],
    });
    expect(err.violations.join(' ')).toContain('nativeTools');
  });
});

describe('findBoundedModeViolations — bound validity', () => {
  const base: SendQueryOptions = { bounded: boundedOptions() };

  test('admits a well-formed bounded request', () => {
    expect(findBoundedModeViolations(undefined, base)).toEqual([]);
  });

  test('returns nothing at all when bounded mode is absent', () => {
    expect(findBoundedModeViolations('some-session', { forkSession: true })).toEqual([]);
  });

  test.each([
    ['maxTurns', { maxTurns: 0 }],
    ['maxTurns', { maxTurns: 1.5 }],
    ['maxBudgetUsd', { maxBudgetUsd: 0 }],
    ['maxSubprocessRetries', { maxSubprocessRetries: -1 }],
    ['maxOutputTokens', { maxOutputTokens: 0 }],
    ['maxContextTokens', { maxContextTokens: 0 }],
  ])('rejects an invalid %s', (field, override) => {
    const violations = findBoundedModeViolations(undefined, {
      bounded: boundedOptions(override as Partial<BoundedModeOptions>),
    });
    expect(violations.join(' ')).toContain(field);
  });
});
