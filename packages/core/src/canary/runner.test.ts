/**
 * End-to-end coverage of the bounded canary runner.
 *
 * REAL SQLite, REAL @anthropic-ai/claude-agent-sdk, REAL ClaudeProvider, and a
 * FAKE CLI SUBPROCESS standing in for the model. Nothing is mocked between the
 * contract and the process boundary, so what these tests assert about bounds,
 * receipts and refusals is what the system genuinely does.
 *
 * NO PROVIDER CALL: the fake needs no credentials and contacts nothing.
 */
import { mock, describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
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
let dbPath: string;
let workDir: string;

const proxyPool = {
  query: <T>(text: string, params?: unknown[]): Promise<{ rows: T[]; rowCount?: number | null }> =>
    db.query(text, params) as Promise<{ rows: T[]; rowCount?: number | null }>,
};

mock.module('../db/connection', () => ({
  pool: proxyPool,
  getDialect: () => sqliteDialect,
}));

const { CANARY_CONTRACT_VERSION, canaryRequestSchema, contractDigest } = await import('./contract');
const {
  CanaryRefusedError,
  admitCanaryRequest,
  buildBoundedOptions,
  classifyTerminalReason,
  measureEffectivePrompt,
  redactForReceipt,
  submitCanaryRun,
} = await import('./runner');
const { getCanaryReceiptForPrincipal } = await import('../db/canary-receipts');
type CanaryRequestType = import('./contract').CanaryRequest;

const PRINCIPAL = 'goviral';
const OTHER_PRINCIPAL = 'someone-else';
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
    external_run_id: 'canary-a',
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

/** Poll until the receipt reaches `terminal`, or fail loudly. */
async function waitForTerminal(
  req: CanaryRequestType,
  principal = PRINCIPAL,
  timeoutMs = 20_000
): Promise<NonNullable<Awaited<ReturnType<typeof getCanaryReceiptForPrincipal>>>> {
  const key = {
    principal,
    externalRunId: req.external_run_id,
    externalTaskId: req.external_task_id,
    contractDigest: contractDigest(req, principal),
  };
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const receipt = await getCanaryReceiptForPrincipal(key);
    if (receipt?.state === 'terminal') return receipt;
    if (Date.now() > deadline) {
      throw new Error(`receipt never became terminal (last state: ${receipt?.state ?? 'missing'})`);
    }
    await new Promise(r => setTimeout(r, 25));
  }
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
  workDir = mkdtempSync(join(tmpdir(), 'archon-canary-'));
  dbPath = join(workDir, 'canary.db');
  db = new SqliteAdapter(dbPath);
  process.env.CLAUDE_BIN_PATH = FIXTURE;
  process.env.FAKE_CLAUDE_LOG = join(workDir, 'fake.jsonl');
  process.env.FAKE_CLAUDE_SCENARIO = 'success';
  process.env.ANTHROPIC_API_KEY = 'test-not-a-real-key';
  // The ClaudeProvider constructor refuses bypassPermissions under UID 0
  // without this; pinned so the suite behaves the same as root or as a user.
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

describe('measureEffectivePrompt', () => {
  test('measures exactly the system prompt plus the task prompt', () => {
    const req = request({ system_prompt: 'SYS', prompt: 'TASK' });
    const measured = measureEffectivePrompt(req);

    // 'SYS' + '\n' + 'TASK' = 8 bytes. Measured, never assumed at 32k.
    expect(measured.bytes).toBe(8);
    expect(measured.systemPrompt).toBe('SYS');
    expect(measured.taskPrompt).toBe('TASK');
    expect(measured.tokens).toBe(Math.ceil(8 / 3.5));
  });
});

describe('admitCanaryRequest — refusals cost nothing', () => {
  test('admits a well-formed contract and returns the reservation', () => {
    const { reservation } = admitCanaryRequest(request(), NOW);
    expect(reservation.worst_case_usd).toBeGreaterThan(0);
    // Authoritative maxima from the CLI catalog, not the declared caps.
    expect(reservation.model_max_output_tokens).toBe(128_000);
    expect(reservation.model_context_window).toBe(1_000_000);
    // The declared caps buy a much cheaper expected case.
    expect(reservation.declared_bound_worst_case_usd).toBeLessThan(reservation.worst_case_usd);
  });

  test('refuses an unpriceable model instead of guessing a default price', () => {
    expect(() => admitCanaryRequest(request({ model: 'claude-mystery-9' }), NOW)).toThrow(
      CanaryRefusedError
    );
    try {
      admitCanaryRequest(request({ model: 'claude-mystery-9' }), NOW);
    } catch (err) {
      expect((err as InstanceType<typeof CanaryRefusedError>).code).toBe('unknown_model');
    }
  });

  test('refuses a prompt over the declared cap, reporting the measured size', () => {
    const big = 'x'.repeat(20_000);
    try {
      admitCanaryRequest(request({ prompt: big, max_prompt_tokens: 100 }), NOW);
      throw new Error('should have refused');
    } catch (err) {
      const e = err as InstanceType<typeof CanaryRefusedError>;
      expect(e.code).toBe('prompt_over_cap');
      expect(e.message).toContain('Measured, not assumed');
    }
  });

  test('refuses when the guaranteed worst case exceeds the declared reservation cap', () => {
    try {
      admitCanaryRequest(request({ max_reservation_usd: 0.01 }), NOW);
      throw new Error('should have refused');
    } catch (err) {
      const e = err as InstanceType<typeof CanaryRefusedError>;
      expect(e.code).toBe('reservation_over_cap');
      // The refusal carries the numbers so the caller can see how far over.
      expect(e.reservation?.worst_case_usd).toBeGreaterThan(0.01);
      expect(e.message).toContain('authoritative maxima');
    }
  });

  test('refuses a deadline that has already passed', () => {
    const past = new Date('2026-08-04T11:00:00.000Z');
    try {
      admitCanaryRequest(request(), past);
      throw new Error('should have refused');
    } catch (err) {
      expect((err as InstanceType<typeof CanaryRefusedError>).code).toBe('deadline_passed');
    }
  });

  test.each([
    ['relative', 'not/absolute'],
    ['nonexistent', '/definitely/not/a/real/directory/xyzzy'],
  ])('refuses a %s cwd', (_label, cwd) => {
    try {
      admitCanaryRequest(request({ cwd }), NOW);
      throw new Error('should have refused');
    } catch (err) {
      expect((err as InstanceType<typeof CanaryRefusedError>).code).toBe('bad_cwd');
    }
  });
});

describe('buildBoundedOptions', () => {
  test('always pins subprocess retries to zero and setting sources to empty', () => {
    const bounded = buildBoundedOptions(request());
    // Zero is not configurable: a retry is a fresh billed session the caller
    // cannot see, so a reservation could never price it.
    expect(bounded.maxSubprocessRetries).toBe(0);
    expect(bounded.settingSources).toEqual([]);
    expect(bounded.maxTurns).toBe(3);
    expect(bounded.maxBudgetUsd).toBe(1.0);
    expect(bounded.maxOutputTokens).toBe(8_000);
    expect(bounded.maxContextTokens).toBe(120_000);
  });
});

describe('classifyTerminalReason', () => {
  test.each([
    [{ isError: false }, 'completed'],
    [{ isError: true, errorSubtype: 'error_max_turns' }, 'max_turns_exhausted'],
    [{ isError: true, errorSubtype: 'error_max_budget_usd' }, 'max_budget_exhausted'],
    [{ isError: true, errorSubtype: 'error_during_execution' }, 'sdk_error'],
    [{ isError: true, errorSubtype: 'error_max_structured_output_retries' }, 'sdk_error'],
  ])('%o classifies as %s', (chunk, expected) => {
    expect(classifyTerminalReason(chunk)).toBe(expected);
  });
});

describe('redactForReceipt', () => {
  test.each([
    ['sk-ant-abcdef1234567890', '[redacted-key]'],
    ['ghp_abcdefghij1234567890', '[redacted-token]'],
    ['github_pat_abcdefghij123', '[redacted-token]'],
  ])('redacts %s', (secret, marker) => {
    const out = redactForReceipt(`failure near ${secret} while running`);
    expect(out).not.toContain(secret);
    expect(out).toContain(marker);
  });

  test('redacts bearer headers and secret-named assignments', () => {
    expect(redactForReceipt('Authorization: Bearer abcdefghijklmnop')).not.toContain(
      'abcdefghijklmnop'
    );
    const out = redactForReceipt('ANTHROPIC_API_KEY=hunter2hunter2hunter2');
    expect(out).not.toContain('hunter2hunter2hunter2');
  });

  test('truncates so one error cannot bloat the receipt row', () => {
    expect(redactForReceipt('y'.repeat(9000)).length).toBeLessThan(2100);
  });
});

describe('submitCanaryRun — end to end through the fake SDK subprocess', () => {
  test('submit returns a PENDING receipt; the terminal aggregate arrives later', async () => {
    const req = request();
    const submitted = await submitCanaryRun(req, PRINCIPAL, { now: () => NOW });

    // The acknowledgement is explicitly not a settlement.
    expect(submitted.started).toBe(true);
    expect(submitted.receipt.state).toBe('pending');
    expect(submitted.receipt.total_cost_usd).toBeUndefined();
    expect(submitted.receipt.usage).toBeUndefined();

    const terminal = await waitForTerminal(req);
    expect(terminal.reason).toBe('completed');
    expect(terminal.terminal_status).toBe('succeeded');
    expect(terminal.terminal_at).toBeDefined();
    expect(terminal.sdk_subtype).toBe('success');
    expect(terminal.resolved_model).toBe('claude-sonnet-5');
    expect(terminal.session_id).toBe('fake-session');
    expect(terminal.principal).toBe(PRINCIPAL);
    expect(terminal.declared_max_turns).toBe(3);
    expect(terminal.actual_turns).toBe(2);
    expect(terminal.total_cost_usd).toBe(0.0087);
    expect(terminal.usage).toEqual({
      input_tokens: 1200,
      output_tokens: 340,
      cache_read_input_tokens: 64,
      cache_creation_input_tokens: 16,
    });
    expect(terminal.model_usage).toBeDefined();
    // The reservation stays on the receipt so settlement can compare against it.
    expect(terminal.reservation.worst_case_usd).toBeGreaterThan(0);
  });

  test('max-turn exhaustion is recorded as such, with its aggregate intact', async () => {
    process.env.FAKE_CLAUDE_SCENARIO = 'max_turns';
    const req = request({ external_task_id: 'task-turns' });
    await submitCanaryRun(req, PRINCIPAL, { now: () => NOW });

    const terminal = await waitForTerminal(req);
    expect(terminal.reason).toBe('max_turns_exhausted');
    expect(terminal.terminal_status).toBe('failed');
    expect(terminal.sdk_subtype).toBe('error_max_turns');
    expect(terminal.declared_max_turns).toBe(3);
    expect(terminal.actual_turns).toBe(3);
    expect(terminal.total_cost_usd).toBe(0.42);
    expect(terminal.errors?.join(' ')).toContain('maximum number of turns');
  });

  test('budget exhaustion is recorded as such, with its aggregate intact', async () => {
    process.env.FAKE_CLAUDE_SCENARIO = 'max_budget';
    const req = request({ external_task_id: 'task-budget' });
    await submitCanaryRun(req, PRINCIPAL, { now: () => NOW });

    const terminal = await waitForTerminal(req);
    expect(terminal.reason).toBe('max_budget_exhausted');
    expect(terminal.terminal_status).toBe('failed');
    expect(terminal.sdk_subtype).toBe('error_max_budget_usd');
    expect(terminal.total_cost_usd).toBe(1.07);
  });

  test('a terminal result without usage keeps the reason but invents no cost', async () => {
    process.env.FAKE_CLAUDE_SCENARIO = 'no_usage';
    const req = request({ external_task_id: 'task-nousage' });
    await submitCanaryRun(req, PRINCIPAL, { now: () => NOW });

    const terminal = await waitForTerminal(req);
    expect(terminal.reason).toBe('sdk_error');
    expect(terminal.terminal_status).toBe('failed');
    expect(terminal.sdk_subtype).toBe('error_during_execution');
    expect(terminal.actual_turns).toBe(1);
    // Absent, not zero — settlement must charge the reservation, not $0.
    expect(terminal.usage).toBeUndefined();
    expect(terminal.total_cost_usd).toBeUndefined();
  });

  test('a subprocess that dies settles as no_terminal_aggregate, never as success', async () => {
    process.env.FAKE_CLAUDE_SCENARIO = 'crash';
    const req = request({ external_task_id: 'task-crash' });
    await submitCanaryRun(req, PRINCIPAL, { now: () => NOW });

    const terminal = await waitForTerminal(req);
    expect(terminal.reason).toBe('no_terminal_aggregate');
    expect(terminal.total_cost_usd).toBeUndefined();
    expect(terminal.errors?.join(' ')).toContain('charge the full reservation');
  });

  test('a stream that ends with no result also settles as no_terminal_aggregate', async () => {
    process.env.FAKE_CLAUDE_SCENARIO = 'no_result';
    const req = request({ external_task_id: 'task-noresult' });
    await submitCanaryRun(req, PRINCIPAL, { now: () => NOW });

    const terminal = await waitForTerminal(req);
    expect(terminal.reason).toBe('no_terminal_aggregate');
    expect(terminal.total_cost_usd).toBeUndefined();
  });

  test('a hung subprocess is aborted at the deadline and settled honestly', async () => {
    process.env.FAKE_CLAUDE_SCENARIO = 'hang';
    const req = request({
      external_task_id: 'task-deadline',
      // Two seconds from the injected clock: long enough to spawn, short enough
      // to keep the test quick.
      deadline_at: new Date(NOW.getTime() + 2000).toISOString(),
    });
    await submitCanaryRun(req, PRINCIPAL, { now: () => NOW });

    const terminal = await waitForTerminal(req, PRINCIPAL, 30_000);
    expect(terminal.reason).toBe('deadline_exceeded');
    // The run was aborted mid-flight, so nothing about its spend is knowable.
    expect(terminal.total_cost_usd).toBeUndefined();
    expect(terminal.errors?.join(' ')).toContain('charge the full reservation');
  }, 40_000);
});

describe('submitCanaryRun — identity and idempotency', () => {
  test('re-submitting the identical contract does not start a second run', async () => {
    const req = request({ external_task_id: 'task-dup' });
    const first = await submitCanaryRun(req, PRINCIPAL, { now: () => NOW });
    expect(first.started).toBe(true);
    await waitForTerminal(req);

    const second = await submitCanaryRun(req, PRINCIPAL, { now: () => NOW });
    // No second dispatch, and the caller gets the existing (now terminal) row.
    expect(second.started).toBe(false);
    expect(second.receipt.state).toBe('terminal');

    const count = await db.query<{ n: number }>(
      'SELECT COUNT(*) AS n FROM remote_agent_canary_receipts'
    );
    expect(count.rows[0].n).toBe(1);
  });

  test('a DIFFERENT contract for the same task is refused, not silently re-run', async () => {
    const req = request({ external_task_id: 'task-conflict' });
    await submitCanaryRun(req, PRINCIPAL, { now: () => NOW });
    await waitForTerminal(req);

    const changed = request({ external_task_id: 'task-conflict', max_turns: 5 });
    try {
      await submitCanaryRun(changed, PRINCIPAL, { now: () => NOW });
      throw new Error('should have refused');
    } catch (err) {
      const e = err as InstanceType<typeof CanaryRefusedError>;
      expect(e.code).toBe('contract_conflict');
    }

    const count = await db.query<{ n: number }>(
      'SELECT COUNT(*) AS n FROM remote_agent_canary_receipts'
    );
    expect(count.rows[0].n).toBe(1);
  });

  test('a mismatched identity cannot read the receipt', async () => {
    const req = request({ external_task_id: 'task-identity' });
    await submitCanaryRun(req, PRINCIPAL, { now: () => NOW });
    const terminal = await waitForTerminal(req);
    expect(terminal.state).toBe('terminal');

    // Same external identity, wrong principal: indistinguishable from "no such
    // receipt" — and note the digest itself differs too, so a cross-principal
    // read cannot even be addressed, let alone answered.
    expect(
      await getCanaryReceiptForPrincipal({
        principal: OTHER_PRINCIPAL,
        externalRunId: req.external_run_id,
        externalTaskId: req.external_task_id,
        contractDigest: contractDigest(req, PRINCIPAL),
      })
    ).toBeUndefined();
  });

  test('two principals submitting identical bodies get INDEPENDENT records', async () => {
    // This is the v1 collision, end to end. Under v1 the second submit threw
    // ("receipt vanished immediately after insert") because the conflict target
    // omitted the principal while the read-back included it.
    const req = request({ external_task_id: 'task-shared-id' });

    const mine = await submitCanaryRun(req, PRINCIPAL, { now: () => NOW });
    expect(mine.started).toBe(true);
    const theirs = await submitCanaryRun(req, OTHER_PRINCIPAL, { now: () => NOW });
    expect(theirs.started).toBe(true);

    // Two rows, two digests, two independent runs.
    expect(theirs.receipt.contract_digest).not.toBe(mine.receipt.contract_digest);
    expect(mine.receipt.principal).toBe(PRINCIPAL);
    expect(theirs.receipt.principal).toBe(OTHER_PRINCIPAL);

    const count = await db.query<{ n: number }>(
      'SELECT COUNT(*) AS n FROM remote_agent_canary_receipts'
    );
    expect(count.rows[0].n).toBe(2);

    // Each settles on its own, and neither can read the other.
    const a = await waitForTerminal(req, PRINCIPAL);
    const b = await waitForTerminal(req, OTHER_PRINCIPAL);
    expect(a.request_id).not.toBe(b.request_id);
    expect(
      await getCanaryReceiptForPrincipal({
        principal: OTHER_PRINCIPAL,
        externalRunId: req.external_run_id,
        externalTaskId: req.external_task_id,
        contractDigest: a.contract_digest,
      })
    ).toBeUndefined();
  }, 40_000);
});
