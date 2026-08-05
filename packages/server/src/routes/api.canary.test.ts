/**
 * HTTP surface of the bounded canary contract.
 *
 * Registers ONLY `registerCanaryRoutes` on a bare OpenAPIHono, so nothing here
 * depends on the rest of api.ts. The real contract schema and the real digest
 * are used (re-exported through the core mock) — a mocked schema would not
 * exercise the validation these routes rely on.
 *
 * The engine below the routes is mocked; the runner itself is covered
 * end-to-end against a fake SDK subprocess in
 * packages/core/src/canary/runner.test.ts. What is under test here is the HTTP
 * contract: default-off, identity enforcement, cross-principal isolation, and
 * that a submit acknowledgement is never a terminal receipt.
 *
 * NO PROVIDER CALL.
 */
import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { OpenAPIHono } from '@hono/zod-openapi';
import { validationErrorHook } from './openapi-defaults';
import {
  CANARY_CONTRACT_VERSION,
  canaryReceiptSchema,
  canaryRequestSchema,
  canaryReservationSchema,
  contractDigest,
} from '@archon/core/canary/contract';
import type { CanaryReceipt, CanaryRequest } from '@archon/core/canary/contract';

const noopLogger = () => ({
  fatal: mock(() => undefined),
  error: mock(() => undefined),
  warn: mock(() => undefined),
  info: mock(() => undefined),
  debug: mock(() => undefined),
  trace: mock(() => undefined),
  child: mock(function (this: unknown) {
    return this;
  }),
  bindings: mock(() => ({ module: 'test' })),
  isLevelEnabled: mock(() => true),
  level: 'info',
});

class CanaryRefusedError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly reservation?: unknown
  ) {
    super(message);
    this.name = 'CanaryRefusedError';
  }
}

const TOKEN_A = 'a'.repeat(40);
const TOKEN_B = 'b'.repeat(40);

let modeEnabled = true;
/** Receipts by `${principal}|${runId}|${taskId}|${digest}`. */
let receipts: Map<string, CanaryReceipt>;
let submitBehaviour: 'ok' | 'refuse' | 'conflict' | 'throw' = 'ok';

const RESERVATION = {
  measured_prompt_tokens: 120,
  measured_prompt_bytes: 400,
  model_max_output_tokens: 128_000,
  model_context_window: 1_000_000,
  full_turns_usd: 7.2,
  budget_plus_overshoot_usd: 3.784,
  worst_case_usd: 3.784,
  declared_bound_worst_case_usd: 0.72,
};

function pendingReceipt(req: CanaryRequest, principal: string): CanaryReceipt {
  return {
    contract_version: CANARY_CONTRACT_VERSION,
    principal,
    external_run_id: req.external_run_id,
    external_task_id: req.external_task_id,
    contract_digest: contractDigest(req, principal),
    request_id: `req-${principal}-${req.external_task_id}`,
    state: 'pending',
    requested_model: req.model,
    declared_max_turns: req.max_turns,
    reservation: RESERVATION,
    created_at: '2026-08-04T10:00:00.000Z',
    updated_at: '2026-08-04T10:00:00.000Z',
  };
}

const mockSubmit = mock(async (req: CanaryRequest, principal: string) => {
  if (submitBehaviour === 'refuse') {
    throw new CanaryRefusedError('reservation_over_cap', 'worst case exceeds cap', RESERVATION);
  }
  if (submitBehaviour === 'conflict') {
    throw new CanaryRefusedError('contract_conflict', 'different digest already recorded');
  }
  if (submitBehaviour === 'throw') {
    throw new Error('internal detail that must not leak: /opt/secret/path');
  }
  const receipt = pendingReceipt(req, principal);
  const key = `${principal}|${receipt.external_run_id}|${receipt.external_task_id}|${receipt.contract_digest}`;
  const already = receipts.has(key);
  if (!already) receipts.set(key, receipt);
  return { started: !already, receipt: receipts.get(key) as CanaryReceipt };
});

const mockGetReceipt = mock(
  async (key: {
    principal: string;
    externalRunId: string;
    externalTaskId: string;
    contractDigest: string;
  }) =>
    receipts.get(
      `${key.principal}|${key.externalRunId}|${key.externalTaskId}|${key.contractDigest}`
    )
);

// The REAL schemas are re-exported through the mock: route validation is part
// of what is under test, so a stubbed schema would test nothing.
mock.module('@archon/core', () => ({
  CanaryRefusedError,
  canaryReceiptSchema,
  canaryRequestSchema,
  canaryReservationSchema,
  contractDigest,
  isCanaryModeEnabled: () => modeEnabled,
  resolveCanaryPrincipal: (header: string | undefined) => {
    if (header === `Bearer ${TOKEN_A}`) return 'goviral';
    if (header === `Bearer ${TOKEN_B}`) return 'other';
    return undefined;
  },
  submitCanaryRun: mockSubmit,
  getCanaryReceiptForPrincipal: mockGetReceipt,
}));

mock.module('@archon/paths', () => ({ createLogger: noopLogger }));

const { registerCanaryRoutes } = await import('./canary');

function buildApp(): OpenAPIHono {
  const app = new OpenAPIHono({ defaultHook: validationErrorHook });
  registerCanaryRoutes(app);
  return app;
}

function validBody(overrides: Partial<CanaryRequest> = {}): Record<string, unknown> {
  return {
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
    deadline_at: '2026-08-04T12:00:00.000Z',
    prompt: 'build the bounded thing',
    system_prompt: 'You are a bounded canary worker.',
    cwd: '/tmp',
    ...overrides,
  };
}

async function submit(
  app: OpenAPIHono,
  body: Record<string, unknown>,
  token?: string
): Promise<Response> {
  return app.request('/api/canary/runs', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

async function readReceipt(
  app: OpenAPIHono,
  runId: string,
  taskId: string,
  digest: string,
  token?: string
): Promise<Response> {
  return app.request(`/api/canary/receipts/${runId}/${taskId}?contract_digest=${digest}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
}

beforeEach(() => {
  modeEnabled = true;
  submitBehaviour = 'ok';
  receipts = new Map();
  mockSubmit.mockClear();
  mockGetReceipt.mockClear();
});

describe('canary mode disabled by default', () => {
  test('submit 404s when the mode is off, without disclosing that it exists', async () => {
    modeEnabled = false;
    const res = await submit(buildApp(), validBody(), TOKEN_A);

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
    // Crucially, the engine was never called.
    expect(mockSubmit).not.toHaveBeenCalled();
  });

  test('read 404s when the mode is off', async () => {
    modeEnabled = false;
    const res = await readReceipt(buildApp(), 'canary-a', 'task-1', 'f'.repeat(64), TOKEN_A);
    expect(res.status).toBe(404);
    expect(mockGetReceipt).not.toHaveBeenCalled();
  });

  test('disabled mode is checked BEFORE auth, so a bad token still sees only 404', async () => {
    modeEnabled = false;
    const res = await submit(buildApp(), validBody(), 'wrong-token');
    expect(res.status).toBe(404);
  });
});

describe('request identity', () => {
  test('submit without a token is unauthorized and never runs anything', async () => {
    const res = await submit(buildApp(), validBody());
    expect(res.status).toBe(401);
    expect(mockSubmit).not.toHaveBeenCalled();
  });

  test('submit with an unknown token is unauthorized', async () => {
    const res = await submit(buildApp(), validBody(), 'z'.repeat(40));
    expect(res.status).toBe(401);
    expect(mockSubmit).not.toHaveBeenCalled();
  });

  test('read without a token is unauthorized', async () => {
    const res = await readReceipt(buildApp(), 'canary-a', 'task-1', 'f'.repeat(64));
    expect(res.status).toBe(401);
    expect(mockGetReceipt).not.toHaveBeenCalled();
  });

  test('the resolved principal — not anything in the body — is what the engine receives', async () => {
    await submit(buildApp(), validBody(), TOKEN_B);
    expect(mockSubmit.mock.calls[0][1]).toBe('other');
  });
});

describe('submit is an acknowledgement, never a settlement', () => {
  test('202 with a PENDING receipt and no aggregate', async () => {
    const res = await submit(buildApp(), validBody(), TOKEN_A);
    expect(res.status).toBe(202);

    const body = (await res.json()) as {
      accepted: boolean;
      started: boolean;
      receipt: CanaryReceipt;
      reservation: typeof RESERVATION;
    };
    expect(body.accepted).toBe(true);
    expect(body.started).toBe(true);
    expect(body.receipt.state).toBe('pending');
    // Nothing settleable is present. A caller cannot mistake this for a receipt.
    expect(body.receipt.total_cost_usd).toBeUndefined();
    expect(body.receipt.usage).toBeUndefined();
    expect(body.receipt.actual_turns).toBeUndefined();
    expect(body.receipt.reason).toBeUndefined();
    expect(body.receipt.terminal_status).toBeUndefined();
    expect(body.receipt.terminal_at).toBeUndefined();
    // The reservation IS returned, so the caller can hold it immediately.
    expect(body.reservation.worst_case_usd).toBe(3.784);
    expect(body.reservation.declared_bound_worst_case_usd).toBe(0.72);
  });

  test('a duplicate submit reports started:false and starts nothing new', async () => {
    const app = buildApp();
    const first = await submit(app, validBody(), TOKEN_A);
    expect(((await first.json()) as { started: boolean }).started).toBe(true);

    const second = await submit(app, validBody(), TOKEN_A);
    expect(second.status).toBe(202);
    expect(((await second.json()) as { started: boolean }).started).toBe(false);
    expect(receipts.size).toBe(1);
  });
});

describe('submit refusals', () => {
  test('a refusal is 422 and carries the code and the numbers', async () => {
    submitBehaviour = 'refuse';
    const res = await submit(buildApp(), validBody(), TOKEN_A);

    expect(res.status).toBe(422);
    const body = (await res.json()) as { code: string; reservation?: typeof RESERVATION };
    expect(body.code).toBe('reservation_over_cap');
    expect(body.reservation?.worst_case_usd).toBe(3.784);
  });

  test('a contract conflict is 409, distinguishing it from an unacceptable contract', async () => {
    submitBehaviour = 'conflict';
    const res = await submit(buildApp(), validBody(), TOKEN_A);

    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe('contract_conflict');
  });

  test('an internal failure is opaque — no paths or internals in the response', async () => {
    submitBehaviour = 'throw';
    const res = await submit(buildApp(), validBody(), TOKEN_A);

    expect(res.status).toBe(500);
    const text = JSON.stringify(await res.json());
    expect(text).not.toContain('/opt/secret/path');
    expect(text).toContain('Failed to submit canary dispatch');
  });

  test.each([
    ['a missing bound', { max_turns: undefined }],
    ['an unknown field', { max_subagents: 4 }],
    ['a wrong contract version', { contract_version: 'archon.canary.v99' }],
    ['a non-ISO deadline', { deadline_at: 'tomorrow' }],
  ])('%s is rejected by schema validation before the engine is reached', async (_l, override) => {
    const body = { ...validBody(), ...override };
    if ('max_turns' in override && override.max_turns === undefined) delete body.max_turns;

    const res = await submit(buildApp(), body, TOKEN_A);
    expect(res.status).toBe(400);
    expect(mockSubmit).not.toHaveBeenCalled();
  });
});

describe('governed read', () => {
  test("returns the caller's own receipt", async () => {
    const app = buildApp();
    await submit(app, validBody(), TOKEN_A);
    const digest = contractDigest(canaryRequestSchema.parse(validBody()), 'goviral');

    const res = await readReceipt(app, 'canary-a', 'task-1', digest, TOKEN_A);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { receipt: CanaryReceipt };
    expect(body.receipt.external_task_id).toBe('task-1');
    expect(body.receipt.state).toBe('pending');
  });

  test("one task cannot read another principal's receipt", async () => {
    const app = buildApp();
    await submit(app, validBody(), TOKEN_A);
    // Principal A's digest, presented by principal B.
    const digest = contractDigest(canaryRequestSchema.parse(validBody()), 'goviral');

    const res = await readReceipt(app, 'canary-a', 'task-1', digest, TOKEN_B);
    // Indistinguishable from a receipt that does not exist — no 403, which
    // would confirm that something is there to be denied.
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
  });

  test('the contract digest is part of the key — a wrong one does not fall back', async () => {
    const app = buildApp();
    await submit(app, validBody(), TOKEN_A);

    const res = await readReceipt(app, 'canary-a', 'task-1', 'f'.repeat(64), TOKEN_A);
    expect(res.status).toBe(404);
  });

  test('a missing contract_digest is a validation error, not a broad match', async () => {
    const app = buildApp();
    await submit(app, validBody(), TOKEN_A);

    const res = await app.request('/api/canary/receipts/canary-a/task-1', {
      headers: { Authorization: `Bearer ${TOKEN_A}` },
    });
    expect(res.status).toBe(400);
  });

  test('a terminal receipt exposes the full aggregate', async () => {
    const app = buildApp();
    await submit(app, validBody(), TOKEN_A);
    const digest = contractDigest(canaryRequestSchema.parse(validBody()), 'goviral');
    const key = `goviral|canary-a|task-1|${digest}`;

    receipts.set(key, {
      ...(receipts.get(key) as CanaryReceipt),
      state: 'terminal',
      terminal_status: 'failed',
      reason: 'max_budget_exhausted',
      terminal_at: '2026-08-04T10:00:05.000Z',
      resolved_model: 'claude-sonnet-5',
      session_id: 'fake-session',
      usage: { input_tokens: 4200, output_tokens: 900 },
      actual_turns: 2,
      total_cost_usd: 1.07,
      sdk_subtype: 'error_max_budget_usd',
    });

    const res = await readReceipt(app, 'canary-a', 'task-1', digest, TOKEN_A);
    const body = (await res.json()) as { receipt: CanaryReceipt };
    expect(body.receipt.state).toBe('terminal');
    expect(body.receipt.terminal_status).toBe('failed');
    expect(body.receipt.reason).toBe('max_budget_exhausted');
    expect(body.receipt.terminal_at).toBe('2026-08-04T10:00:05.000Z');
    expect(body.receipt.total_cost_usd).toBe(1.07);
    expect(body.receipt.actual_turns).toBe(2);
    expect(body.receipt.declared_max_turns).toBe(3);
  });
});
