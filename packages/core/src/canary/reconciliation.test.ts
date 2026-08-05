/**
 * Adversarial coverage for the v2 identity reconciliation.
 *
 * Every case here is one the integration lead can point at. They run against a
 * REAL SQLite database and a REAL @anthropic-ai/claude-agent-sdk driving a FAKE
 * CLI subprocess — so the uniqueness constraint, the ON CONFLICT target and the
 * bounded CLI posture are all exercised as they actually behave, not as mocked.
 *
 * The seven required cases, and where each lives below:
 *   1. same body, two principals      → 'independent records'
 *   2. same principal, identical retry → 'idempotent'
 *   3. same principal, changed envelope → 'conflict'
 *   4. cross-principal receipt read    → 'refused'
 *   5. wrong version / unknown field   → 'refused at the schema'
 *   6. no terminal result              → 'pending only'
 *   7. bounded CLI posture unchanged   → 'posture'
 *
 * NO PROVIDER CALL.
 */
import { mock, describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SqliteAdapter, sqliteDialect } from '../db/adapters/sqlite';

const FIXTURE = resolve(
  import.meta.dir,
  '..',
  '..',
  '..',
  'providers',
  'src',
  'claude',
  '__fixtures__',
  'fake-claude-cli.mjs'
);

/**
 * The run cwd is created ONCE for the file and never deleted between tests.
 *
 * `submitCanaryRun` is fire-and-forget by design, so a dispatch can outlive the
 * test that started it. Deleting its cwd in afterEach made those stragglers die
 * with "current working directory was deleted" and flood the output with error
 * logs — noise that would hide a real failure. Per-test scratch (database, fake
 * CLI log) still gets its own directory and is still cleaned up.
 */
const RUN_CWD = mkdtempSync(join(tmpdir(), 'archon-canary-cwd-'));

let db: SqliteAdapter;
let workDir: string;
let logPath: string;

const proxyPool = {
  query: <T>(text: string, params?: unknown[]): Promise<{ rows: T[]; rowCount?: number | null }> =>
    db.query(text, params) as Promise<{ rows: T[]; rowCount?: number | null }>,
};
mock.module('../db/connection', () => ({ pool: proxyPool, getDialect: () => sqliteDialect }));

const { CANARY_CONTRACT_VERSION, canaryRequestSchema, contractDigest } = await import('./contract');
const { CanaryRefusedError, submitCanaryRun } = await import('./runner');
const { getCanaryReceiptForPrincipal } = await import('../db/canary-receipts');
type CanaryRequestType = import('./contract').CanaryRequest;

const ALPHA = 'alpha';
const BETA = 'beta';
const NOW = new Date('2026-08-04T10:00:00.000Z');

const ENV_KEYS = [
  'CLAUDE_BIN_PATH',
  'FAKE_CLAUDE_LOG',
  'FAKE_CLAUDE_SCENARIO',
  'ANTHROPIC_API_KEY',
  'IS_SANDBOX',
] as const;
const savedEnv: Record<string, string | undefined> = {};

function request(overrides: Partial<CanaryRequestType> = {}): CanaryRequestType {
  return canaryRequestSchema.parse({
    contract_version: CANARY_CONTRACT_VERSION,
    external_run_id: 'run-1',
    external_task_id: 'task-1',
    model: 'claude-sonnet-5',
    max_turns: 3,
    max_budget_usd: 1.0,
    max_prompt_tokens: 32_000,
    max_output_tokens_per_turn: 8_000,
    max_context_tokens: 120_000,
    max_reservation_usd: 50.0,
    deadline_at: '2026-08-04T10:05:00.000Z',
    prompt: 'build the bounded thing',
    system_prompt: 'You are a bounded canary worker.',
    cwd: RUN_CWD,
    ...overrides,
  });
}

function keyFor(
  req: CanaryRequestType,
  principal: string
): {
  principal: string;
  externalRunId: string;
  externalTaskId: string;
  contractDigest: string;
} {
  return {
    principal,
    externalRunId: req.external_run_id,
    externalTaskId: req.external_task_id,
    contractDigest: contractDigest(req, principal),
  };
}

async function waitForTerminal(
  req: CanaryRequestType,
  principal: string,
  timeoutMs = 20_000
): Promise<NonNullable<Awaited<ReturnType<typeof getCanaryReceiptForPrincipal>>>> {
  const key = keyFor(req, principal);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const receipt = await getCanaryReceiptForPrincipal(key);
    if (receipt?.state === 'terminal') return receipt;
    if (Date.now() > deadline) {
      throw new Error(`receipt never became terminal (last: ${receipt?.state ?? 'missing'})`);
    }
    await new Promise(r => setTimeout(r, 25));
  }
}

async function rowCount(): Promise<number> {
  const r = await db.query<{ n: number }>('SELECT COUNT(*) AS n FROM remote_agent_canary_receipts');
  return r.rows[0].n;
}

/**
 * Wait for every dispatch started by the finished test to reach `terminal`.
 *
 * `submitCanaryRun` is fire-and-forget, and `proxyPool` always reads the
 * CURRENT `db`. Without this drain a straggler from one test settles into the
 * NEXT test's database and corrupts it — which is exactly what happened when
 * the shared run cwd first stopped stragglers from dying on their own.
 *
 * Capped rather than unbounded: a test that deliberately leaves a run hanging
 * should cost a bounded pause, not hang the suite.
 */
async function drainInFlightDispatches(capMs = 5_000): Promise<void> {
  const deadline = Date.now() + capMs;
  for (;;) {
    let pending = 0;
    try {
      const r = await db.query<{ n: number }>(
        "SELECT COUNT(*) AS n FROM remote_agent_canary_receipts WHERE state = 'pending'"
      );
      pending = r.rows[0].n;
    } catch {
      return; // database already closed — nothing left to drain
    }
    if (pending === 0 || Date.now() > deadline) return;
    await new Promise(res => setTimeout(res, 25));
  }
}

beforeEach(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  workDir = mkdtempSync(join(tmpdir(), 'archon-recon-'));
  logPath = join(workDir, 'fake.jsonl');
  db = new SqliteAdapter(join(workDir, 'recon.db'));
  process.env.CLAUDE_BIN_PATH = FIXTURE;
  process.env.FAKE_CLAUDE_LOG = logPath;
  process.env.FAKE_CLAUDE_SCENARIO = 'success';
  process.env.ANTHROPIC_API_KEY = 'test-not-a-real-key';
  process.env.IS_SANDBOX = '1';
});

afterEach(async () => {
  await drainInFlightDispatches();
  db.close?.();
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  if (existsSync(workDir)) rmSync(workDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 1 · Same body, two principals → independent records
// ---------------------------------------------------------------------------

describe('1 · same body, two principals', () => {
  test('produce independent records rather than colliding', async () => {
    const req = request();

    const a = await submitCanaryRun(req, ALPHA, { now: () => NOW });
    const b = await submitCanaryRun(req, BETA, { now: () => NOW });

    // Under v1 this second submit threw: its insert was suppressed by a
    // principal-free ON CONFLICT and the principal-scoped read-back then found
    // nothing. Both must now start.
    expect(a.started).toBe(true);
    expect(b.started).toBe(true);
    expect(await rowCount()).toBe(2);

    expect(a.receipt.principal).toBe(ALPHA);
    expect(b.receipt.principal).toBe(BETA);
    expect(a.receipt.request_id).not.toBe(b.receipt.request_id);
    // The digests differ because the principal is inside the digest, so the
    // two identities are distinct even before the uniqueness key is consulted.
    expect(a.receipt.contract_digest).not.toBe(b.receipt.contract_digest);
    // ...and the external ids they chose really are identical.
    expect(a.receipt.external_run_id).toBe(b.receipt.external_run_id);
    expect(a.receipt.external_task_id).toBe(b.receipt.external_task_id);
  }, 40_000);

  test('each settles independently with its own terminal receipt', async () => {
    const req = request();
    await submitCanaryRun(req, ALPHA, { now: () => NOW });
    await submitCanaryRun(req, BETA, { now: () => NOW });

    const a = await waitForTerminal(req, ALPHA);
    const b = await waitForTerminal(req, BETA);

    expect(a.principal).toBe(ALPHA);
    expect(b.principal).toBe(BETA);
    expect(a.terminal_status).toBe('succeeded');
    expect(b.terminal_status).toBe('succeeded');
    // Two separate billed dispatches, each with its own aggregate.
    expect(a.request_id).not.toBe(b.request_id);
    expect(a.total_cost_usd).toBeDefined();
    expect(b.total_cost_usd).toBeDefined();
  }, 40_000);

  test('a third principal on the same ids is still independent', async () => {
    const req = request();
    await submitCanaryRun(req, ALPHA, { now: () => NOW });
    await submitCanaryRun(req, BETA, { now: () => NOW });
    const c = await submitCanaryRun(req, 'gamma', { now: () => NOW });

    expect(c.started).toBe(true);
    expect(await rowCount()).toBe(3);
  }, 40_000);
});

// ---------------------------------------------------------------------------
// 2 · Same principal, identical retry → idempotent
// ---------------------------------------------------------------------------

describe('2 · same principal, identical retry', () => {
  test('is idempotent and starts no second dispatch', async () => {
    const req = request();

    const first = await submitCanaryRun(req, ALPHA, { now: () => NOW });
    expect(first.started).toBe(true);
    await waitForTerminal(req, ALPHA);

    const retry = await submitCanaryRun(req, ALPHA, { now: () => NOW });
    expect(retry.started).toBe(false);
    expect(await rowCount()).toBe(1);
    // The retry returns the SAME record, already settled.
    expect(retry.receipt.request_id).toBe(first.receipt.request_id);
    expect(retry.receipt.state).toBe('terminal');
  }, 40_000);

  test('remains idempotent when the retry is a re-serialization with reordered keys', async () => {
    const req = request();
    await submitCanaryRun(req, ALPHA, { now: () => NOW });
    await waitForTerminal(req, ALPHA);

    // Same meaning, different key order — the canonical digest must not care.
    const reordered = Object.fromEntries(
      Object.entries(req as unknown as Record<string, unknown>).reverse()
    ) as unknown as CanaryRequestType;

    const retry = await submitCanaryRun(reordered, ALPHA, { now: () => NOW });
    expect(retry.started).toBe(false);
    expect(await rowCount()).toBe(1);
  }, 40_000);

  test('concurrent identical retries start exactly one dispatch', async () => {
    const req = request();
    const results = await Promise.all([
      submitCanaryRun(req, ALPHA, { now: () => NOW }),
      submitCanaryRun(req, ALPHA, { now: () => NOW }),
      submitCanaryRun(req, ALPHA, { now: () => NOW }),
    ]);

    // Exactly one wins the insert; the others read the winner's row.
    expect(results.filter(r => r.started)).toHaveLength(1);
    expect(await rowCount()).toBe(1);
  }, 40_000);
});

// ---------------------------------------------------------------------------
// 3 · Same principal + identity, changed envelope → conflict
// ---------------------------------------------------------------------------

describe('3 · same principal and identity, changed bounded envelope', () => {
  test.each([
    ['max_turns', { max_turns: 5 }],
    ['max_budget_usd', { max_budget_usd: 2.5 }],
    ['model', { model: 'claude-haiku-4-5' }],
    ['deadline_at', { deadline_at: '2026-08-04T10:09:00.000Z' }],
    ['max_output_tokens_per_turn', { max_output_tokens_per_turn: 16_000 }],
    ['prompt', { prompt: 'build something else entirely' }],
  ])(
    'fails closed as a conflict when %s changes',
    async (_label, override) => {
      const req = request();
      await submitCanaryRun(req, ALPHA, { now: () => NOW });
      await waitForTerminal(req, ALPHA);

      const changed = request(override as Partial<CanaryRequestType>);
      let code: string | undefined;
      try {
        await submitCanaryRun(changed, ALPHA, { now: () => NOW });
      } catch (err) {
        code = (err as InstanceType<typeof CanaryRefusedError>).code;
      }

      expect(code).toBe('contract_conflict');
      // Fail CLOSED: no second row, and therefore no second billed dispatch.
      expect(await rowCount()).toBe(1);
    },
    40_000
  );

  test('the conflict is scoped to the principal — another principal is unaffected', async () => {
    const req = request();
    await submitCanaryRun(req, ALPHA, { now: () => NOW });

    // BETA has no prior contract for these ids, so a different envelope from
    // BETA is an ordinary first submission, not a conflict.
    const changed = request({ max_turns: 5 });
    const b = await submitCanaryRun(changed, BETA, { now: () => NOW });
    expect(b.started).toBe(true);

    // ...but ALPHA changing its own envelope still conflicts.
    await expect(submitCanaryRun(changed, ALPHA, { now: () => NOW })).rejects.toThrow(
      CanaryRefusedError
    );
  }, 40_000);
});

// ---------------------------------------------------------------------------
// 4 · Cross-principal receipt read → refused
// ---------------------------------------------------------------------------

describe('4 · cross-principal receipt read', () => {
  test("returns no receipt, even with the owner's exact digest", async () => {
    const req = request();
    await submitCanaryRun(req, ALPHA, { now: () => NOW });
    const owned = await waitForTerminal(req, ALPHA);

    // BETA presenting ALPHA's exact key material.
    const stolen = await getCanaryReceiptForPrincipal({
      principal: BETA,
      externalRunId: req.external_run_id,
      externalTaskId: req.external_task_id,
      contractDigest: owned.contract_digest,
    });
    expect(stolen).toBeUndefined();
  }, 40_000);

  test('BETA reading with its OWN digest also finds nothing when it never submitted', async () => {
    const req = request();
    await submitCanaryRun(req, ALPHA, { now: () => NOW });
    await waitForTerminal(req, ALPHA);

    expect(await getCanaryReceiptForPrincipal(keyFor(req, BETA))).toBeUndefined();
  }, 40_000);

  test('each principal reads only its own record when both submitted', async () => {
    const req = request();
    await submitCanaryRun(req, ALPHA, { now: () => NOW });
    await submitCanaryRun(req, BETA, { now: () => NOW });

    const a = await getCanaryReceiptForPrincipal(keyFor(req, ALPHA));
    const b = await getCanaryReceiptForPrincipal(keyFor(req, BETA));

    expect(a?.principal).toBe(ALPHA);
    expect(b?.principal).toBe(BETA);
    expect(a?.request_id).not.toBe(b?.request_id);
  }, 40_000);
});

// ---------------------------------------------------------------------------
// 5 · Wrong version / unknown field → refused at the schema
// ---------------------------------------------------------------------------

describe('5 · wrong version and unknown field', () => {
  test.each(['archon.canary.v1', 'archon.canary.v3', 'canary.v2', 'v2'])(
    'refuses contract_version %p',
    version => {
      const body = { ...request(), contract_version: version };
      expect(canaryRequestSchema.safeParse(body).success).toBe(false);
    }
  );

  test.each([
    ['principal', { principal: 'beta' }],
    ['authenticated_principal', { authenticated_principal: 'beta' }],
    ['contract_digest', { contract_digest: 'f'.repeat(64) }],
    ['max_subagents', { max_subagents: 4 }],
    ['maxTurns (camelCase of a real field)', { maxTurns: 3 }],
  ])('refuses unknown field %s rather than ignoring it', (_label, extra) => {
    const body = { ...request(), ...extra };
    expect(canaryRequestSchema.safeParse(body).success).toBe(false);
  });

  test('a caller cannot smuggle a principal past the digest', () => {
    // Even if such a body were somehow accepted, the digest ignores the payload
    // entirely and uses the resolved principal — so a smuggled value could not
    // change which identity the request addresses.
    const req = request();
    const smuggled = { ...req, principal: BETA } as unknown as CanaryRequestType;
    expect(contractDigest(smuggled, ALPHA)).not.toBe(contractDigest(req, BETA));
  });
});

// ---------------------------------------------------------------------------
// 6 · No terminal result → pending only
// ---------------------------------------------------------------------------

describe('6 · no terminal result', () => {
  test('leaves the receipt pending with nothing that could settle a budget', async () => {
    process.env.FAKE_CLAUDE_SCENARIO = 'hang';
    // Short deadline so the deliberately-hung dispatch self-terminates instead
    // of leaving a five-minute timer running past the end of the suite.
    const req = request({ deadline_at: new Date(NOW.getTime() + 1500).toISOString() });

    const submitted = await submitCanaryRun(req, ALPHA, { now: () => NOW });
    expect(submitted.receipt.state).toBe('pending');

    const live = await getCanaryReceiptForPrincipal(keyFor(req, ALPHA));
    expect(live?.state).toBe('pending');
    for (const field of [
      'terminal_status',
      'reason',
      'terminal_at',
      'usage',
      'total_cost_usd',
      'actual_turns',
      'resolved_model',
    ] as const) {
      expect(live?.[field]).toBeUndefined();
    }
    // The reservation IS present — that is what stays held while pending.
    expect(live?.reservation.worst_case_usd).toBeGreaterThan(0);
    // And the declared ceiling is bound even before anything settles.
    expect(live?.declared_max_turns).toBe(3);
  }, 40_000);

  test('a dead subprocess settles as failed with no aggregate, never as succeeded', async () => {
    process.env.FAKE_CLAUDE_SCENARIO = 'crash';
    const req = request();
    await submitCanaryRun(req, ALPHA, { now: () => NOW });

    const terminal = await waitForTerminal(req, ALPHA);
    expect(terminal.terminal_status).toBe('failed');
    expect(terminal.reason).toBe('no_terminal_aggregate');
    expect(terminal.total_cost_usd).toBeUndefined();
    expect(terminal.actual_turns).toBeUndefined();
    expect(terminal.errors?.join(' ')).toContain('charge the full reservation');
  }, 40_000);
});

// ---------------------------------------------------------------------------
// 7 · Bounded CLI posture unchanged
// ---------------------------------------------------------------------------

describe('7 · bounded CLI posture is unchanged by v2', () => {
  test('every v1 bound still reaches the spawned subprocess', async () => {
    const req = request();
    await submitCanaryRun(req, ALPHA, { now: () => NOW });
    await waitForTerminal(req, ALPHA);

    const spawns = readFileSync(logPath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(l => JSON.parse(l) as { kind: string; argv?: string[]; env?: Record<string, string> })
      .filter(r => r.kind === 'spawn');

    // Zero subprocess retries: one dispatch, one spawn.
    expect(spawns).toHaveLength(1);
    const argv = spawns[0].argv ?? [];
    const valueOf = (flag: string): string | undefined => {
      const i = argv.indexOf(flag);
      return i >= 0 ? argv[i + 1] : undefined;
    };

    // Fixed model, turn ceiling, budget ceiling.
    expect(valueOf('--model')).toBe('claude-sonnet-5');
    expect(valueOf('--max-turns')).toBe('3');
    expect(valueOf('--max-budget-usd')).toBe('1');
    // No subagents.
    expect((valueOf('--disallowedTools') ?? '').split(',')).toContain('Task');
    // No forks, no fallback model, no custom agents.
    expect(argv).not.toContain('--fork-session');
    expect(argv).not.toContain('--fallback-model');
    expect(argv).not.toContain('--agents');
    // No filesystem prompt growth.
    expect(argv).toContain('--setting-sources=');
    // Output/context caps and no auto-compaction.
    expect(spawns[0].env?.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe('8000');
    expect(spawns[0].env?.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBe('120000');
    expect(spawns[0].env?.DISABLE_COMPACT).toBe('1');
  }, 40_000);

  test('a dead subprocess is still not retried under v2', async () => {
    process.env.FAKE_CLAUDE_SCENARIO = 'crash';
    const req = request();
    await submitCanaryRun(req, ALPHA, { now: () => NOW });
    await waitForTerminal(req, ALPHA);

    const spawns = readFileSync(logPath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(l => JSON.parse(l) as { kind: string })
      .filter(r => r.kind === 'spawn');
    expect(spawns).toHaveLength(1);
  }, 40_000);

  test('two principals produce two dispatches, each individually bounded', async () => {
    const req = request();
    await submitCanaryRun(req, ALPHA, { now: () => NOW });
    await submitCanaryRun(req, BETA, { now: () => NOW });
    await waitForTerminal(req, ALPHA);
    await waitForTerminal(req, BETA);

    const spawns = readFileSync(logPath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(l => JSON.parse(l) as { kind: string; argv?: string[] })
      .filter(r => r.kind === 'spawn');

    // Independent records mean independent spend — two spawns, not one shared
    // run silently serving both principals.
    expect(spawns).toHaveLength(2);
    for (const spawn of spawns) {
      const argv = spawn.argv ?? [];
      expect(argv[argv.indexOf('--max-turns') + 1]).toBe('3');
      expect(argv[argv.indexOf('--max-budget-usd') + 1]).toBe('1');
      expect((argv[argv.indexOf('--disallowedTools') + 1] ?? '').split(',')).toContain('Task');
    }
  }, 40_000);
});
