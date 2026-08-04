/**
 * The golden vectors are a cross-team contract surface, so this suite checks
 * three separate things — a file can be committed, be schema-valid, and still
 * not match what the server actually produces.
 *
 *  1. The committed JSON matches what the generator emits (no stale files).
 *  2. Every vector still parses under the LIVE schemas (no drifted shape).
 *  3. A REAL bounded run, driven end to end against a fake SDK subprocess,
 *     normalizes to exactly the committed terminal vector (no drifted values).
 *
 * (3) is the one that matters most: it is the only check that can catch the
 * server emitting a field the published vector never mentioned.
 *
 * NO PROVIDER CALL.
 */
import { mock, describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SqliteAdapter, sqliteDialect } from '../db/adapters/sqlite';

const GOLDEN_DIR = resolve(import.meta.dir, '__golden__');
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

const proxyPool = {
  query: <T>(text: string, params?: unknown[]): Promise<{ rows: T[]; rowCount?: number | null }> =>
    db.query(text, params) as Promise<{ rows: T[]; rowCount?: number | null }>,
};
mock.module('../db/connection', () => ({ pool: proxyPool, getDialect: () => sqliteDialect }));

const {
  GOLDEN_PRINCIPAL,
  GOLDEN_SENTINELS,
  goldenDigest,
  goldenPendingAcknowledgement,
  goldenRequest,
  goldenTerminalFailure,
  goldenTerminalSuccess,
} = await import('./golden-vectors');
const { canaryReceiptSchema, canaryRequestSchema } = await import('./contract');
const { submitCanaryRun } = await import('./runner');
const { getCanaryReceiptForPrincipal } = await import('../db/canary-receipts');
const { GOLDEN_FILES } = await import('../../../../scripts/generate-canary-golden-vectors');

type Json = Record<string, unknown>;

function readGolden(name: string): Json {
  return JSON.parse(readFileSync(join(GOLDEN_DIR, name), 'utf8')) as Json;
}

const ENV_KEYS = [
  'CLAUDE_BIN_PATH',
  'FAKE_CLAUDE_LOG',
  'FAKE_CLAUDE_SCENARIO',
  'ANTHROPIC_API_KEY',
  'IS_SANDBOX',
] as const;
const savedEnv: Record<string, string | undefined> = {};

/** Replace the four inherently non-deterministic values with their sentinels. */
function normalizeVolatile(receipt: Json): Json {
  const out: Json = { ...receipt, request_id: GOLDEN_SENTINELS.requestId };
  out.created_at = GOLDEN_SENTINELS.createdAt;
  out.updated_at =
    receipt.state === 'terminal' ? GOLDEN_SENTINELS.terminalAt : GOLDEN_SENTINELS.updatedAt;
  if (receipt.terminal_at !== undefined) out.terminal_at = GOLDEN_SENTINELS.terminalAt;
  return out;
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
  workDir = mkdtempSync(join(tmpdir(), 'archon-golden-'));
  db = new SqliteAdapter(join(workDir, 'golden.db'));
  process.env.CLAUDE_BIN_PATH = FIXTURE;
  process.env.FAKE_CLAUDE_LOG = join(workDir, 'fake.jsonl');
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

describe('committed vectors are not stale', () => {
  test.each(Object.keys(GOLDEN_FILES))('%s matches the generator output', name => {
    const rendered = `${JSON.stringify(GOLDEN_FILES[name], null, 2)}\n`;
    expect(readFileSync(join(GOLDEN_DIR, name), 'utf8')).toBe(rendered);
  });

  test('exactly the four required vectors are published', () => {
    expect(Object.keys(GOLDEN_FILES).sort()).toEqual([
      'pending-acknowledgement.json',
      'request.json',
      'terminal-receipt-failed.json',
      'terminal-receipt-success.json',
    ]);
  });
});

describe('vectors pin the wire contract', () => {
  test('every vector declares endpoint, auth and contract version', () => {
    for (const name of Object.keys(GOLDEN_FILES)) {
      const v = readGolden(name);
      expect(v.contract_version).toBe('archon.canary.v2');
      expect(v.authentication).toMatchObject({ header: 'Authorization', scheme: 'Bearer' });
      expect(v.endpoint).toBeDefined();
    }
  });

  test('the request vector carries no principal field — authority is not payload', () => {
    const request = readGolden('request.json').request as Json;
    expect(request.principal).toBeUndefined();
    // And the live schema agrees: adding one is a rejection, not a silent drop.
    expect(canaryRequestSchema.safeParse({ ...request, principal: 'goviral' }).success).toBe(false);
  });

  test('the published digest is what the live digest function computes', () => {
    expect(readGolden('request.json').contract_digest).toBe(goldenDigest());
  });

  test('the request vector still parses under the live schema', () => {
    expect(canaryRequestSchema.parse(readGolden('request.json').request)).toEqual(goldenRequest());
  });

  test.each([
    ['terminal-receipt-success.json', 'succeeded', 'completed'],
    ['terminal-receipt-failed.json', 'failed', 'max_budget_exhausted'],
  ])('%s parses live and states its terminal vocabulary', (name, status, reason) => {
    const receipt = (readGolden(name).response as Json).receipt as Json;
    expect(canaryReceiptSchema.parse(receipt)).toEqual(
      name.includes('success') ? goldenTerminalSuccess() : goldenTerminalFailure()
    );
    expect(receipt.state).toBe('terminal');
    expect(receipt.terminal_status).toBe(status);
    expect(receipt.reason).toBe(reason);
    expect(receipt.terminal_at).toBeDefined();
  });

  test('the pending vector carries nothing a caller could settle a budget from', () => {
    const ack = readGolden('pending-acknowledgement.json').response as Json;
    const receipt = ack.receipt as Json;
    expect(receipt.state).toBe('pending');
    for (const field of [
      'terminal_status',
      'reason',
      'terminal_at',
      'usage',
      'total_cost_usd',
      'actual_turns',
      'resolved_model',
      'model_usage',
    ]) {
      expect(receipt[field]).toBeUndefined();
    }
    // The reservation IS present — that is what the caller holds meanwhile.
    expect((receipt.reservation as Json).worst_case_usd).toBeGreaterThan(0);
  });

  test('every terminal receipt binds the full requirement-8 field set', () => {
    for (const name of ['terminal-receipt-success.json', 'terminal-receipt-failed.json']) {
      const r = (readGolden(name).response as Json).receipt as Json;
      for (const field of [
        'contract_version',
        'principal',
        'external_run_id',
        'external_task_id',
        'request_id',
        'session_id',
        'requested_model',
        'resolved_model',
        'declared_max_turns',
        'actual_turns',
        'usage',
        'total_cost_usd',
        'terminal_status',
        'terminal_at',
        'sdk_subtype',
      ]) {
        expect(r[field]).toBeDefined();
      }
    }
  });
});

describe('a real bounded run reproduces the published terminal vector', () => {
  test('success path matches terminal-receipt-success.json exactly', async () => {
    const request = goldenRequest();
    // Deadline is in the request, so the clock must sit before it.
    const now = new Date('2026-08-04T10:00:00.000Z');
    const req = { ...request, cwd: RUN_CWD };

    await submitCanaryRun(req, GOLDEN_PRINCIPAL, { now: () => now });

    const key = {
      principal: GOLDEN_PRINCIPAL,
      externalRunId: req.external_run_id,
      externalTaskId: req.external_task_id,
      contractDigest: (await import('./contract')).contractDigest(req, GOLDEN_PRINCIPAL),
    };

    const deadline = Date.now() + 20_000;
    let live = await getCanaryReceiptForPrincipal(key);
    while (live?.state !== 'terminal' && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 25));
      live = await getCanaryReceiptForPrincipal(key);
    }
    expect(live?.state).toBe('terminal');

    const expected = goldenTerminalSuccess();
    const actual = normalizeVolatile(live as unknown as Json);

    // `cwd` and therefore the digest/reservation differ from the published
    // vector only because the vector fixes cwd at /tmp; align those two so the
    // comparison is about SHAPE AND VALUES, not about the temp directory.
    const comparable = {
      ...actual,
      contract_digest: expected.contract_digest,
      reservation: expected.reservation,
    };
    expect(comparable).toEqual(expected as unknown as Json);
  }, 40_000);

  test('budget-exhaustion path matches terminal-receipt-failed.json exactly', async () => {
    process.env.FAKE_CLAUDE_SCENARIO = 'max_budget';
    const request = goldenRequest();
    const now = new Date('2026-08-04T10:00:00.000Z');
    const req = { ...request, cwd: RUN_CWD };

    await submitCanaryRun(req, GOLDEN_PRINCIPAL, { now: () => now });

    const key = {
      principal: GOLDEN_PRINCIPAL,
      externalRunId: req.external_run_id,
      externalTaskId: req.external_task_id,
      contractDigest: (await import('./contract')).contractDigest(req, GOLDEN_PRINCIPAL),
    };

    const deadline = Date.now() + 20_000;
    let live = await getCanaryReceiptForPrincipal(key);
    while (live?.state !== 'terminal' && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 25));
      live = await getCanaryReceiptForPrincipal(key);
    }

    const expected = goldenTerminalFailure();
    const comparable = {
      ...normalizeVolatile(live as unknown as Json),
      contract_digest: expected.contract_digest,
      reservation: expected.reservation,
    };
    expect(comparable).toEqual(expected as unknown as Json);
  }, 40_000);

  test('the submit acknowledgement matches pending-acknowledgement.json exactly', async () => {
    // `hang` so the run never settles while the acknowledgement is inspected —
    // otherwise the receipt could turn terminal mid-assertion.
    process.env.FAKE_CLAUDE_SCENARIO = 'hang';
    const request = goldenRequest();
    const now = new Date('2026-08-04T10:00:00.000Z');
    // Short deadline so the hung dispatch self-terminates rather than leaving a
    // five-minute timer alive past the end of the suite. The deadline is not
    // part of what this vector pins, and the acknowledgement is captured
    // synchronously from the submit call before anything can settle.
    const req = {
      ...request,
      cwd: RUN_CWD,
      deadline_at: new Date(now.getTime() + 1500).toISOString(),
    };

    const result = await submitCanaryRun(req, GOLDEN_PRINCIPAL, { now: () => now });
    const expected = goldenPendingAcknowledgement();

    const comparable = {
      accepted: true as const,
      started: result.started,
      receipt: {
        ...normalizeVolatile(result.receipt as unknown as Json),
        contract_digest: expected.receipt.contract_digest,
        reservation: expected.receipt.reservation,
      },
      reservation: expected.reservation,
    };
    expect(comparable).toEqual(expected as unknown as Json);
  }, 40_000);
});
