/**
 * Adversarial coverage for the governed terminal deliverable.
 *
 * A terminal receipt proved what a run COST but said nothing about what it
 * PRODUCED. These cases exercise the output half end to end: a REAL SQLite
 * database, the REAL @anthropic-ai/claude-agent-sdk, and a FAKE CLI subprocess
 * emitting the final assistant text — so the round-trip, the byte accounting
 * and the fail-closed refusals are all what the system actually does.
 *
 * The required cases, and where each lives:
 *   genuine output round-trip        → 'round-trip'
 *   exact UTF-8 length and hash      → 'byte accounting'
 *   pending / failed absence         → 'absence'
 *   success without output           → 'fails closed'
 *   oversized output                 → 'fails closed'
 *   cross-principal refusal          → 'principal scoping'
 *   duplicate retry                  → 'idempotent bytes'
 *   caller-supplied output refused   → 'authority'
 *
 * NO PROVIDER CALL.
 */
import { mock, describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { createHash } from 'node:crypto';
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

/** Stable across the file — see the note in reconciliation.test.ts. */
const RUN_CWD = mkdtempSync(join(tmpdir(), 'archon-canary-cwd-'));

let db: SqliteAdapter;
let workDir: string;

const proxyPool = {
  query: <T>(text: string, params?: unknown[]): Promise<{ rows: T[]; rowCount?: number | null }> =>
    db.query(text, params) as Promise<{ rows: T[]; rowCount?: number | null }>,
};
mock.module('../db/connection', () => ({ pool: proxyPool, getDialect: () => sqliteDialect }));

const {
  CANARY_CONTRACT_VERSION,
  CANARY_MAX_OUTPUT_BYTES,
  CANARY_OUTPUT_CONTENT_TYPE,
  canaryRequestSchema,
  contractDigest,
  describeCanaryOutput,
  findReceiptOutputViolations,
} = await import('./contract');
const { governSuccessOutput, submitCanaryRun } = await import('./runner');
const { getCanaryReceiptForPrincipal } = await import('../db/canary-receipts');
type CanaryRequestType = import('./contract').CanaryRequest;
type CanaryReceiptType = import('./contract').CanaryReceipt;

const ALPHA = 'alpha';
const BETA = 'beta';
const NOW = new Date('2026-08-04T10:00:00.000Z');

const ENV_KEYS = [
  'CLAUDE_BIN_PATH',
  'FAKE_CLAUDE_LOG',
  'FAKE_CLAUDE_SCENARIO',
  'FAKE_CLAUDE_OUTPUT',
  'FAKE_CLAUDE_OVERSIZE_BYTES',
  'ANTHROPIC_API_KEY',
  'IS_SANDBOX',
] as const;
const savedEnv: Record<string, string | undefined> = {};

function request(overrides: Partial<CanaryRequestType> = {}): CanaryRequestType {
  return canaryRequestSchema.parse({
    contract_version: CANARY_CONTRACT_VERSION,
    external_run_id: 'run-out',
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
  principal = ALPHA,
  timeoutMs = 20_000
): Promise<CanaryReceiptType> {
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
      return;
    }
    if (pending === 0 || Date.now() > deadline) return;
    await new Promise(res => setTimeout(res, 25));
  }
}

beforeEach(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  workDir = mkdtempSync(join(tmpdir(), 'archon-output-'));
  db = new SqliteAdapter(join(workDir, 'output.db'));
  process.env.CLAUDE_BIN_PATH = FIXTURE;
  process.env.FAKE_CLAUDE_LOG = join(workDir, 'fake.jsonl');
  process.env.FAKE_CLAUDE_SCENARIO = 'success';
  process.env.ANTHROPIC_API_KEY = 'test-not-a-real-key';
  process.env.IS_SANDBOX = '1';
  delete process.env.FAKE_CLAUDE_OUTPUT;
  delete process.env.FAKE_CLAUDE_OVERSIZE_BYTES;
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
// Genuine round-trip
// ---------------------------------------------------------------------------

describe('round-trip: the real SDK deliverable reaches the receipt', () => {
  test('the exact text the fake CLI emitted is what the receipt returns', async () => {
    const deliverable = 'The bounded canary finished. Result: 42 files scanned, 0 defects.';
    process.env.FAKE_CLAUDE_OUTPUT = deliverable;

    const req = request();
    await submitCanaryRun(req, ALPHA, { now: () => NOW });
    const receipt = await waitForTerminal(req);

    expect(receipt.terminal_status).toBe('succeeded');
    expect(receipt.reason).toBe('completed');
    expect(receipt.output_available).toBe(true);
    // Byte-for-byte, not "contains" — this is the deliverable, not a summary.
    expect(receipt.output_text).toBe(deliverable);
    expect(receipt.output_content_type).toBe(CANARY_OUTPUT_CONTENT_TYPE);
  }, 40_000);

  test('the deliverable is bound to the same principal/run/task/request/digest record', async () => {
    const req = request();
    await submitCanaryRun(req, ALPHA, { now: () => NOW });
    const receipt = await waitForTerminal(req);

    // The output is not a side table keyed by anything looser — it rides the
    // same governed identity a caller already authenticated to read.
    expect(receipt.principal).toBe(ALPHA);
    expect(receipt.external_run_id).toBe(req.external_run_id);
    expect(receipt.external_task_id).toBe(req.external_task_id);
    expect(receipt.contract_digest).toBe(contractDigest(req, ALPHA));
    expect(receipt.request_id).toBeDefined();
    expect(receipt.output_available).toBe(true);
  }, 40_000);

  test('output is NOT attached to a failed run that happened to leave text behind', async () => {
    // The fake emits a real `result` string alongside an error_max_turns.
    process.env.FAKE_CLAUDE_SCENARIO = 'failure_with_output';
    const req = request();
    await submitCanaryRun(req, ALPHA, { now: () => NOW });
    const receipt = await waitForTerminal(req);

    expect(receipt.terminal_status).toBe('failed');
    expect(receipt.reason).toBe('max_turns_exhausted');
    // Partial work from a run that hit a ceiling is not a deliverable, and
    // publishing it would invite settling as though the work were done.
    expect(receipt.output_available).toBe(false);
    expect(receipt.output_text).toBeUndefined();
    expect(receipt.output_sha256).toBeUndefined();
    // The cost aggregate is still there — the run was real and billed.
    expect(receipt.total_cost_usd).toBe(0.42);
  }, 40_000);
});

// ---------------------------------------------------------------------------
// Byte accounting
// ---------------------------------------------------------------------------

describe('byte accounting: UTF-8 length and hash over exactly those bytes', () => {
  test('ASCII output reports its UTF-8 length and a verifiable sha256', async () => {
    const text = 'bounded canary output';
    process.env.FAKE_CLAUDE_OUTPUT = text;
    const req = request();
    await submitCanaryRun(req, ALPHA, { now: () => NOW });
    const receipt = await waitForTerminal(req);

    // Recomputed here from first principles, not from the helper under test.
    const expectedBytes = Buffer.byteLength(text, 'utf8');
    const expectedHash = createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');

    expect(receipt.output_bytes).toBe(expectedBytes);
    expect(receipt.output_sha256).toBe(expectedHash);
    expect(receipt.output_sha256).toMatch(/^[0-9a-f]{64}$/);
  }, 40_000);

  test('multibyte output uses UTF-8 bytes, not UTF-16 string length', async () => {
    process.env.FAKE_CLAUDE_SCENARIO = 'unicode_output';
    const text = 'héllo → 世界';
    const req = request();
    await submitCanaryRun(req, ALPHA, { now: () => NOW });
    const receipt = await waitForTerminal(req);

    const utf8 = Buffer.byteLength(text, 'utf8');
    expect(receipt.output_text).toBe(text);
    expect(receipt.output_bytes).toBe(utf8);
    // The distinction that matters: a naive `.length` would report fewer.
    expect(utf8).toBeGreaterThan(text.length);
    expect(receipt.output_sha256).toBe(
      createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex')
    );
  }, 40_000);

  test('the hash covers the text verbatim — no trimming or normalisation', async () => {
    // Leading/trailing whitespace around real content must survive intact, or
    // the hash would attest to text the agent never produced.
    const text = '  indented deliverable  \n';
    process.env.FAKE_CLAUDE_OUTPUT = text;
    const req = request();
    await submitCanaryRun(req, ALPHA, { now: () => NOW });
    const receipt = await waitForTerminal(req);

    expect(receipt.output_text).toBe(text);
    expect(receipt.output_bytes).toBe(Buffer.byteLength(text, 'utf8'));
    expect(receipt.output_sha256).toBe(
      createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex')
    );
  }, 40_000);

  test('describeCanaryOutput agrees with an independent computation', () => {
    for (const text of ['', 'a', 'héllo → 世界', 'x'.repeat(5000), ' ']) {
      const d = describeCanaryOutput(text);
      expect(d.bytes).toBe(Buffer.byteLength(text, 'utf8'));
      expect(d.sha256).toBe(createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex'));
    }
  });
});

// ---------------------------------------------------------------------------
// Absence on pending and failed
// ---------------------------------------------------------------------------

describe('absence: pending and failed receipts expose no deliverable', () => {
  test('a pending acknowledgement has no output block at all', async () => {
    process.env.FAKE_CLAUDE_SCENARIO = 'hang';
    const req = request({ deadline_at: new Date(NOW.getTime() + 1500).toISOString() });

    const submitted = await submitCanaryRun(req, ALPHA, { now: () => NOW });
    expect(submitted.receipt.state).toBe('pending');

    // Not even output_available:false — that would read as a settled
    // "this produced nothing" rather than "not finished yet".
    for (const field of [
      'output_available',
      'output_text',
      'output_bytes',
      'output_sha256',
      'output_content_type',
    ] as const) {
      expect(submitted.receipt[field]).toBeUndefined();
    }

    const live = await getCanaryReceiptForPrincipal(keyFor(req, ALPHA));
    expect(live?.output_available).toBeUndefined();
  }, 40_000);

  test.each([
    ['budget exhaustion', 'max_budget', 'max_budget_exhausted'],
    ['turn exhaustion', 'max_turns', 'max_turns_exhausted'],
    ['sdk error', 'no_usage', 'sdk_error'],
    ['dead subprocess', 'crash', 'no_terminal_aggregate'],
  ])(
    '%s reports output_available:false with no text',
    async (_label, scenario, reason) => {
      process.env.FAKE_CLAUDE_SCENARIO = scenario;
      const req = request();
      await submitCanaryRun(req, ALPHA, { now: () => NOW });
      const receipt = await waitForTerminal(req);

      expect(receipt.reason).toBe(reason);
      expect(receipt.terminal_status).toBe('failed');
      expect(receipt.output_available).toBe(false);
      expect(receipt.output_text).toBeUndefined();
      expect(receipt.output_sha256).toBeUndefined();
      expect(receipt.output_bytes).toBeUndefined();
    },
    40_000
  );

  test('a timeout reports output_available:false', async () => {
    process.env.FAKE_CLAUDE_SCENARIO = 'hang';
    const req = request({ deadline_at: new Date(NOW.getTime() + 1500).toISOString() });
    await submitCanaryRun(req, ALPHA, { now: () => NOW });

    const receipt = await waitForTerminal(req, ALPHA, 30_000);
    expect(receipt.reason).toBe('deadline_exceeded');
    expect(receipt.output_available).toBe(false);
    expect(receipt.output_text).toBeUndefined();
  }, 40_000);
});

// ---------------------------------------------------------------------------
// Fail closed
// ---------------------------------------------------------------------------

describe('fails closed: success without a valid deliverable is not success', () => {
  test.each([
    ['an omitted result field', 'no_output_field'],
    ['an empty result string', 'empty_output'],
    ['a whitespace-only result', 'whitespace_output'],
  ])(
    '%s is downgraded to missing_output',
    async (_label, scenario) => {
      process.env.FAKE_CLAUDE_SCENARIO = scenario;
      const req = request();
      await submitCanaryRun(req, ALPHA, { now: () => NOW });
      const receipt = await waitForTerminal(req);

      // The SDK said success; Archon refuses to repeat the claim.
      expect(receipt.sdk_subtype).toBe('success');
      expect(receipt.terminal_status).toBe('failed');
      expect(receipt.reason).toBe('missing_output');
      expect(receipt.output_available).toBe(false);
      expect(receipt.output_text).toBeUndefined();
      // The run still executed and still cost money — that must not be erased.
      expect(receipt.total_cost_usd).toBe(0.0087);
      expect(receipt.actual_turns).toBe(2);
      expect(receipt.errors?.join(' ')).toContain('Failing closed');
    },
    40_000
  );

  test('oversized output fails closed and is never truncated', async () => {
    process.env.FAKE_CLAUDE_SCENARIO = 'oversized_output';
    const req = request();
    await submitCanaryRun(req, ALPHA, { now: () => NOW });
    const receipt = await waitForTerminal(req);

    expect(receipt.terminal_status).toBe('failed');
    expect(receipt.reason).toBe('output_too_large');
    expect(receipt.output_available).toBe(false);
    // Nothing was persisted — not a prefix, not a placeholder. A truncated
    // deliverable reported as success would be silently wrong.
    expect(receipt.output_text).toBeUndefined();
    expect(receipt.output_bytes).toBeUndefined();
    expect(receipt.output_sha256).toBeUndefined();
    expect(receipt.errors?.join(' ')).toContain('rather than truncating');
    // The cost aggregate survives: the run happened.
    expect(receipt.total_cost_usd).toBe(0.0087);
  }, 60_000);

  test('output exactly at the ceiling is accepted; one byte over is refused', () => {
    // The boundary itself, exercised directly — a run that produced exactly the
    // maximum is a legitimate deliverable and must not be lost to an off-by-one.
    const atLimit = 'x'.repeat(CANARY_MAX_OUTPUT_BYTES);
    const overLimit = 'x'.repeat(CANARY_MAX_OUTPUT_BYTES + 1);

    const ok = governSuccessOutput(atLimit);
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.output.bytes).toBe(CANARY_MAX_OUTPUT_BYTES);

    const refused = governSuccessOutput(overLimit);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.reason).toBe('output_too_large');
  });

  test('the ceiling is measured in UTF-8 bytes, not characters', () => {
    // Half as many characters, same byte count — a character-based check would
    // wrongly admit this.
    const multibyte = '世'.repeat(Math.ceil(CANARY_MAX_OUTPUT_BYTES / 3) + 1);
    expect(multibyte.length).toBeLessThan(CANARY_MAX_OUTPUT_BYTES);
    const refused = governSuccessOutput(multibyte);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.reason).toBe('output_too_large');
  });

  test('a succeeded receipt without output cannot even be represented', () => {
    const violations = findReceiptOutputViolations({
      contract_version: CANARY_CONTRACT_VERSION,
      principal: ALPHA,
      external_run_id: 'r',
      external_task_id: 't',
      contract_digest: 'a'.repeat(64),
      request_id: 'rq',
      state: 'terminal',
      terminal_status: 'succeeded',
      reason: 'completed',
      requested_model: 'claude-sonnet-5',
      declared_max_turns: 3,
      output_available: false,
      reservation: {
        measured_prompt_tokens: 1,
        measured_prompt_bytes: 1,
        model_max_output_tokens: 1,
        model_context_window: 1,
        full_turns_usd: 0,
        budget_plus_overshoot_usd: 0,
        worst_case_usd: 0,
        declared_bound_worst_case_usd: 0,
      },
      created_at: 'x',
      updated_at: 'x',
    });
    expect(violations.join(' ')).toContain('succeeded requires an available output');
  });

  test('a tampered hash is caught rather than served', () => {
    const text = 'deliverable';
    const good = describeCanaryOutput(text);
    const violations = findReceiptOutputViolations({
      contract_version: CANARY_CONTRACT_VERSION,
      principal: ALPHA,
      external_run_id: 'r',
      external_task_id: 't',
      contract_digest: 'a'.repeat(64),
      request_id: 'rq',
      state: 'terminal',
      terminal_status: 'succeeded',
      reason: 'completed',
      requested_model: 'claude-sonnet-5',
      declared_max_turns: 3,
      output_available: true,
      output_text: text,
      output_bytes: good.bytes,
      output_sha256: 'b'.repeat(64),
      output_content_type: CANARY_OUTPUT_CONTENT_TYPE,
      reservation: {
        measured_prompt_tokens: 1,
        measured_prompt_bytes: 1,
        model_max_output_tokens: 1,
        model_context_window: 1,
        full_turns_usd: 0,
        budget_plus_overshoot_usd: 0,
        worst_case_usd: 0,
        declared_bound_worst_case_usd: 0,
      },
      created_at: 'x',
      updated_at: 'x',
    });
    expect(violations.join(' ')).toContain('output_sha256 does not match');
  });
});

// ---------------------------------------------------------------------------
// Principal scoping and idempotency of the deliverable
// ---------------------------------------------------------------------------

describe('principal scoping: the deliverable is as scoped as the receipt', () => {
  test("another principal cannot read the output, even with the owner's digest", async () => {
    const req = request();
    await submitCanaryRun(req, ALPHA, { now: () => NOW });
    const owned = await waitForTerminal(req, ALPHA);
    expect(owned.output_available).toBe(true);

    const stolen = await getCanaryReceiptForPrincipal({
      principal: BETA,
      externalRunId: req.external_run_id,
      externalTaskId: req.external_task_id,
      contractDigest: owned.contract_digest,
    });
    // No receipt at all — so no deliverable, and no way to tell one exists.
    expect(stolen).toBeUndefined();
  }, 40_000);

  test('two principals on identical bodies get separate deliverables', async () => {
    process.env.FAKE_CLAUDE_OUTPUT = 'shared-shape deliverable';
    const req = request();
    await submitCanaryRun(req, ALPHA, { now: () => NOW });
    await submitCanaryRun(req, BETA, { now: () => NOW });

    const a = await waitForTerminal(req, ALPHA);
    const b = await waitForTerminal(req, BETA);

    expect(a.request_id).not.toBe(b.request_id);
    expect(a.output_available).toBe(true);
    expect(b.output_available).toBe(true);
    // Same fake, so the same text — but they are two independent records, each
    // readable only by its own principal.
    expect(a.output_sha256).toBe(b.output_sha256);
    expect(a.principal).toBe(ALPHA);
    expect(b.principal).toBe(BETA);
  }, 40_000);
});

describe('idempotent bytes: retries and repeated polls are stable', () => {
  test('an identical retry returns byte-identical output and hash', async () => {
    process.env.FAKE_CLAUDE_OUTPUT = 'stable deliverable';
    const req = request();

    await submitCanaryRun(req, ALPHA, { now: () => NOW });
    const first = await waitForTerminal(req);

    const retry = await submitCanaryRun(req, ALPHA, { now: () => NOW });
    expect(retry.started).toBe(false);
    expect(retry.receipt.output_text).toBe(first.output_text);
    expect(retry.receipt.output_sha256).toBe(first.output_sha256);
    expect(retry.receipt.output_bytes).toBe(first.output_bytes);
    expect(retry.receipt.request_id).toBe(first.request_id);
  }, 40_000);

  test('repeated receipt polls return identical bytes and hash', async () => {
    process.env.FAKE_CLAUDE_OUTPUT = 'poll me repeatedly';
    const req = request();
    await submitCanaryRun(req, ALPHA, { now: () => NOW });
    await waitForTerminal(req);

    const reads = await Promise.all(
      Array.from({ length: 5 }, () => getCanaryReceiptForPrincipal(keyFor(req, ALPHA)))
    );
    const texts = new Set(reads.map(r => r?.output_text));
    const hashes = new Set(reads.map(r => r?.output_sha256));
    expect(texts.size).toBe(1);
    expect(hashes.size).toBe(1);
    expect([...hashes][0]).toBe(
      createHash('sha256').update(Buffer.from('poll me repeatedly', 'utf8')).digest('hex')
    );
  }, 40_000);
});

// ---------------------------------------------------------------------------
// Authority: output is produced, never supplied
// ---------------------------------------------------------------------------

describe('authority: a caller cannot supply its own output', () => {
  test.each([
    'output_text',
    'output_available',
    'output_sha256',
    'output_bytes',
    'output_content_type',
  ])('a request carrying %s is refused', field => {
    const body = { ...request(), [field]: field === 'output_available' ? true : 'forged' };
    // The deliverable is an attestation about what the agent produced. A caller
    // that could supply it could manufacture a receipt for work never done.
    expect(canaryRequestSchema.safeParse(body).success).toBe(false);
  });

  test('a genuine run overwrites nothing the caller could have influenced', async () => {
    process.env.FAKE_CLAUDE_OUTPUT = 'produced, not supplied';
    const req = request();
    await submitCanaryRun(req, ALPHA, { now: () => NOW });
    const receipt = await waitForTerminal(req);

    // The only path to output_available:true is a real SDK success.
    expect(receipt.output_text).toBe('produced, not supplied');
    expect(findReceiptOutputViolations(receipt)).toEqual([]);
  }, 40_000);
});
