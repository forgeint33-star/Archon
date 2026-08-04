/**
 * Canary receipt store, exercised against a REAL SQLite database.
 *
 * A mocked `pool.query` would not test the thing that matters most here: the
 * UNIQUE(external_run_id, external_task_id, contract_digest) constraint and the
 * ON CONFLICT DO NOTHING that makes submission idempotent. Those are database
 * behaviours, so the test uses a database.
 */
import { mock, describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { SqliteAdapter, sqliteDialect } from './adapters/sqlite';

let db: SqliteAdapter;
let dbPath: string;

// Delegates to whichever adapter the current test created. Declared before the
// mock so the module factory closes over a stable reference.
const proxyPool = {
  query: <T>(text: string, params?: unknown[]): Promise<{ rows: T[]; rowCount?: number | null }> =>
    db.query(text, params) as Promise<{ rows: T[]; rowCount?: number | null }>,
};

mock.module('./connection', () => ({
  pool: proxyPool,
  getDialect: () => sqliteDialect,
}));

const {
  createPendingCanaryReceipt,
  getCanaryReceiptForPrincipal,
  listCanaryDigestsForTask,
  settleCanaryReceipt,
} = await import('./canary-receipts');

const RESERVATION = {
  measured_prompt_tokens: 1000,
  measured_prompt_bytes: 3500,
  model_max_output_tokens: 128_000,
  model_context_window: 1_000_000,
  full_turns_usd: 7.5,
  budget_plus_overshoot_usd: 2.3,
  worst_case_usd: 2.3,
  declared_bound_worst_case_usd: 0.72,
};

const KEY = {
  externalRunId: 'run-a',
  externalTaskId: 'task-1',
  contractDigest: 'a'.repeat(64),
};

const PRINCIPAL = 'goviral';

async function seedPending(
  overrides: Partial<{ key: typeof KEY; principal: string }> = {}
): Promise<{ created: boolean }> {
  const result = await createPendingCanaryReceipt({
    key: overrides.key ?? KEY,
    principal: overrides.principal ?? PRINCIPAL,
    requestedModel: 'claude-sonnet-5',
    reservation: RESERVATION,
  });
  return { created: result.created };
}

beforeEach(() => {
  dbPath = join(
    import.meta.dir,
    `.test-canary-receipts-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
  );
  db = new SqliteAdapter(dbPath);
});

afterEach(() => {
  db.close?.();
  for (const suffix of ['', '-wal', '-shm']) {
    if (existsSync(dbPath + suffix)) rmSync(dbPath + suffix, { force: true });
  }
});

describe('createPendingCanaryReceipt', () => {
  test('creates a pending receipt carrying the reservation but no aggregate', async () => {
    const { created } = await seedPending();
    expect(created).toBe(true);

    const receipt = await getCanaryReceiptForPrincipal(KEY, PRINCIPAL);
    expect(receipt?.state).toBe('pending');
    expect(receipt?.requested_model).toBe('claude-sonnet-5');
    expect(receipt?.reservation).toEqual(RESERVATION);

    // A pending receipt must expose NOTHING settleable. If any of these were
    // present (or zero), a caller could mistake the acknowledgement for a
    // settlement — the exact failure the contract forbids.
    expect(receipt?.reason).toBeUndefined();
    expect(receipt?.usage).toBeUndefined();
    expect(receipt?.total_cost_usd).toBeUndefined();
    expect(receipt?.num_turns).toBeUndefined();
    expect(receipt?.model).toBeUndefined();
  });

  test('a duplicate submit of the identical contract does not create a second receipt', async () => {
    expect((await seedPending()).created).toBe(true);
    // Second call with the same key: the DB constraint suppresses the insert,
    // so `created` is false and the caller knows not to start another run.
    expect((await seedPending()).created).toBe(false);

    const rows = await db.query<{ n: number }>(
      'SELECT COUNT(*) AS n FROM remote_agent_canary_receipts'
    );
    expect(rows.rows[0].n).toBe(1);
  });

  test('a different contract digest for the same task is a separate row', async () => {
    await seedPending();
    const other = { ...KEY, contractDigest: 'b'.repeat(64) };
    expect((await seedPending({ key: other })).created).toBe(true);

    const digests = await listCanaryDigestsForTask(
      KEY.externalRunId,
      KEY.externalTaskId,
      PRINCIPAL
    );
    expect(digests.sort()).toEqual(['a'.repeat(64), 'b'.repeat(64)]);
  });
});

describe('principal scoping', () => {
  test('another principal cannot read the receipt, and cannot tell it exists', async () => {
    await seedPending();

    const asOwner = await getCanaryReceiptForPrincipal(KEY, PRINCIPAL);
    expect(asOwner).toBeDefined();

    // Indistinguishable from "no such receipt": same undefined, no error, no
    // partial data. A caller cannot probe for another task's existence.
    const asStranger = await getCanaryReceiptForPrincipal(KEY, 'someone-else');
    expect(asStranger).toBeUndefined();

    const missing = await getCanaryReceiptForPrincipal(
      { ...KEY, externalTaskId: 'does-not-exist' },
      PRINCIPAL
    );
    expect(missing).toBeUndefined();
  });

  test('a wrong contract digest does not fall back to another digest of the same task', async () => {
    await seedPending();
    const wrongDigest = await getCanaryReceiptForPrincipal(
      { ...KEY, contractDigest: 'c'.repeat(64) },
      PRINCIPAL
    );
    expect(wrongDigest).toBeUndefined();
  });

  test('listCanaryDigestsForTask is scoped to the principal', async () => {
    await seedPending();
    expect(await listCanaryDigestsForTask('run-a', 'task-1', 'someone-else')).toEqual([]);
  });
});

describe('settleCanaryReceipt', () => {
  test('writes the full terminal aggregate and flips state to terminal', async () => {
    await seedPending();

    const settled = await settleCanaryReceipt(KEY, {
      reason: 'completed',
      model: 'claude-sonnet-5',
      usage: { input_tokens: 1200, output_tokens: 340, cache_read_input_tokens: 64 },
      modelUsage: { 'claude-sonnet-5': { inputTokens: 1200, outputTokens: 340 } },
      numTurns: 2,
      totalCostUsd: 0.0087,
      sdkSubtype: 'success',
      stopReason: 'end_turn',
    });
    expect(settled).toBe(true);

    const receipt = await getCanaryReceiptForPrincipal(KEY, PRINCIPAL);
    expect(receipt?.state).toBe('terminal');
    expect(receipt?.reason).toBe('completed');
    expect(receipt?.model).toBe('claude-sonnet-5');
    expect(receipt?.usage).toEqual({
      input_tokens: 1200,
      output_tokens: 340,
      cache_read_input_tokens: 64,
    });
    expect(receipt?.model_usage).toEqual({
      'claude-sonnet-5': { inputTokens: 1200, outputTokens: 340 },
    });
    expect(receipt?.num_turns).toBe(2);
    expect(receipt?.total_cost_usd).toBe(0.0087);
    expect(receipt?.sdk_subtype).toBe('success');
    expect(receipt?.stop_reason).toBe('end_turn');
  });

  test.each([
    ['max_turns_exhausted', 'error_max_turns'],
    ['max_budget_exhausted', 'error_max_budget_usd'],
    ['sdk_error', 'error_during_execution'],
  ] as const)('records %s honestly rather than as completion', async (reason, subtype) => {
    await seedPending();
    await settleCanaryReceipt(KEY, {
      reason,
      sdkSubtype: subtype,
      numTurns: 3,
      totalCostUsd: 0.42,
      usage: { input_tokens: 100, output_tokens: 20 },
    });

    const receipt = await getCanaryReceiptForPrincipal(KEY, PRINCIPAL);
    expect(receipt?.reason).toBe(reason);
    expect(receipt?.sdk_subtype).toBe(subtype);
    // Exhaustion still carries the aggregate — that is what makes settling on
    // a ceiling-hit possible instead of guessing.
    expect(receipt?.total_cost_usd).toBe(0.42);
  });

  test('a missing aggregate leaves the cost columns NULL, never zero', async () => {
    await seedPending();
    await settleCanaryReceipt(KEY, {
      reason: 'no_terminal_aggregate',
      errors: ['Stream ended with no terminal result'],
    });

    const receipt = await getCanaryReceiptForPrincipal(KEY, PRINCIPAL);
    expect(receipt?.state).toBe('terminal');
    expect(receipt?.reason).toBe('no_terminal_aggregate');
    // Absent, not 0. A zero would read as "this run cost nothing" and would let
    // a caller release a reservation for spend that actually happened.
    expect(receipt?.total_cost_usd).toBeUndefined();
    expect(receipt?.usage).toBeUndefined();
    expect(receipt?.num_turns).toBeUndefined();
    expect(receipt?.errors).toEqual(['Stream ended with no terminal result']);
  });

  test('settling twice does not overwrite the first terminal aggregate', async () => {
    await seedPending();
    expect(
      await settleCanaryReceipt(KEY, { reason: 'completed', totalCostUsd: 0.5, numTurns: 2 })
    ).toBe(true);

    // A late deadline-abort racing the real result must lose.
    expect(await settleCanaryReceipt(KEY, { reason: 'deadline_exceeded' })).toBe(false);

    const receipt = await getCanaryReceiptForPrincipal(KEY, PRINCIPAL);
    expect(receipt?.reason).toBe('completed');
    expect(receipt?.total_cost_usd).toBe(0.5);
  });

  test('settling a receipt that does not exist reports false rather than throwing', async () => {
    expect(await settleCanaryReceipt(KEY, { reason: 'completed' })).toBe(false);
  });
});
