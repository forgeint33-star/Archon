/**
 * Golden wire vectors for contract v2 — the shared definition of what GoViral
 * must send and what it will get back.
 *
 * WHY THEY LIVE IN CODE AND ON DISK. The JSON files under `__golden__/` are the
 * artifact another team reads; the builders here are what produce them. A test
 * (`golden-vectors.test.ts`) asserts that the builders still emit exactly the
 * committed files AND that the live schemas still accept them — so the files
 * cannot drift from the implementation, and the implementation cannot drift
 * from what was published, without CI failing.
 *
 * WHAT THEY PIN. Endpoint and method, header casing and auth scheme, every
 * field name and its casing, and the closed terminal vocabulary. They are not
 * documentation that happens to look like JSON; they are the contract surface.
 *
 * VOLATILE FIELDS. `request_id` is a server-generated UUID and the three
 * timestamps are wall-clock, so they cannot appear literally in a fixed file.
 * They are replaced by the sentinels below, which are what the test normalizes
 * a live receipt down to before comparing. Everything else — including
 * `contract_digest` — is fully deterministic and is pinned literally.
 */
import {
  CANARY_CONTRACT_VERSION,
  canaryReceiptSchema,
  canaryRequestSchema,
  contractDigest,
  type CanaryReceipt,
  type CanaryRequest,
} from './contract';

/** Placeholders standing in for values that cannot be deterministic. */
export const GOLDEN_SENTINELS = {
  requestId: '00000000-0000-0000-0000-000000000000',
  createdAt: '2026-08-04T10:00:00.000Z',
  updatedAt: '2026-08-04T10:00:00.000Z',
  terminalAt: '2026-08-04T10:00:05.000Z',
} as const;

/** The principal the vectors are cut for. Resolved from a token, never sent. */
export const GOLDEN_PRINCIPAL = 'goviral';

/** How a caller authenticates. Pinned because it is part of the wire contract. */
export const GOLDEN_AUTHENTICATION = {
  header: 'Authorization',
  scheme: 'Bearer',
  token_source: 'ARCHON_CANARY_PRINCIPALS entry for this principal',
  principal_resolution:
    'server-side, by constant-time comparison of the bearer token; a principal field in the request body is REJECTED',
} as const;

export const GOLDEN_ENDPOINTS = {
  submit: { method: 'POST', path: '/api/canary/runs', success_status: 202 },
  read: {
    method: 'GET',
    path: '/api/canary/receipts/{external_run_id}/{external_task_id}',
    query: { contract_digest: 'required, 64-char lowercase hex' },
    success_status: 200,
  },
} as const;

/** The canonical example request. Every vector below is cut from this one. */
export function goldenRequest(): CanaryRequest {
  return canaryRequestSchema.parse({
    contract_version: CANARY_CONTRACT_VERSION,
    external_run_id: 'canary-a',
    external_task_id: 'task-1',
    model: 'claude-sonnet-5',
    max_turns: 3,
    max_budget_usd: 1,
    max_prompt_tokens: 32000,
    max_output_tokens_per_turn: 8000,
    max_context_tokens: 120000,
    max_reservation_usd: 50,
    deadline_at: '2026-08-04T10:05:00.000Z',
    prompt: 'build the bounded thing',
    system_prompt: 'You are a bounded canary worker.',
    cwd: '/tmp',
  });
}

/** Digest of the golden request under the golden principal. Deterministic. */
export function goldenDigest(): string {
  return contractDigest(goldenRequest(), GOLDEN_PRINCIPAL);
}

/**
 * Reservation figures for the golden request. Hard-coded rather than computed
 * so the vector pins the ARITHMETIC too — if `computeWorstCase` ever changes
 * what it reports for this exact input, the golden test fails.
 */
const GOLDEN_RESERVATION = {
  measured_prompt_tokens: 16,
  measured_prompt_bytes: 56,
  model_max_output_tokens: 128000,
  model_context_window: 1000000,
  full_turns_usd: 6.912144,
  budget_plus_overshoot_usd: 3.688048,
  worst_case_usd: 3.688048,
  declared_bound_worst_case_usd: 0.432144,
};

function baseReceipt(): CanaryReceipt {
  const request = goldenRequest();
  return {
    contract_version: CANARY_CONTRACT_VERSION,
    principal: GOLDEN_PRINCIPAL,
    external_run_id: request.external_run_id,
    external_task_id: request.external_task_id,
    contract_digest: goldenDigest(),
    request_id: GOLDEN_SENTINELS.requestId,
    state: 'pending',
    requested_model: request.model,
    declared_max_turns: request.max_turns,
    reservation: GOLDEN_RESERVATION,
    created_at: GOLDEN_SENTINELS.createdAt,
    updated_at: GOLDEN_SENTINELS.updatedAt,
  };
}

/**
 * The submit acknowledgement.
 *
 * `state: "pending"` with NO aggregate is the whole point: a caller that
 * settled a budget from this body would be settling from nothing. Every
 * settleable field is absent, not zero.
 */
export function goldenPendingAcknowledgement(): {
  accepted: true;
  started: boolean;
  receipt: CanaryReceipt;
  reservation: typeof GOLDEN_RESERVATION;
} {
  return {
    accepted: true,
    started: true,
    receipt: canaryReceiptSchema.parse(baseReceipt()),
    reservation: GOLDEN_RESERVATION,
  };
}

/** A settled, successful terminal receipt. */
export function goldenTerminalSuccess(): CanaryReceipt {
  return canaryReceiptSchema.parse({
    ...baseReceipt(),
    state: 'terminal',
    terminal_status: 'succeeded',
    reason: 'completed',
    terminal_at: GOLDEN_SENTINELS.terminalAt,
    session_id: 'fake-session',
    resolved_model: 'claude-sonnet-5',
    actual_turns: 2,
    usage: {
      input_tokens: 1200,
      output_tokens: 340,
      cache_read_input_tokens: 64,
      cache_creation_input_tokens: 16,
    },
    model_usage: {
      'claude-sonnet-5': {
        inputTokens: 1200,
        outputTokens: 340,
        cacheReadInputTokens: 64,
        cacheCreationInputTokens: 16,
        webSearchRequests: 0,
        costUSD: 0.0087,
        contextWindow: 1000000,
        maxOutputTokens: 8000,
      },
    },
    total_cost_usd: 0.0087,
    sdk_subtype: 'success',
    stop_reason: 'end_turn',
    updated_at: GOLDEN_SENTINELS.terminalAt,
  });
}

/**
 * A settled, FAILED terminal receipt — budget exhaustion.
 *
 * Chosen deliberately over a generic error: hitting `--max-budget-usd` is the
 * failure a spend-reserving caller most needs to recognise, and it is the case
 * where the aggregate is both present and non-trivial. `terminal_status` is
 * `failed` even though the SDK produced a complete, well-formed result — the
 * run stopped at a bound instead of doing the work.
 */
export function goldenTerminalFailure(): CanaryReceipt {
  return canaryReceiptSchema.parse({
    ...baseReceipt(),
    state: 'terminal',
    terminal_status: 'failed',
    reason: 'max_budget_exhausted',
    terminal_at: GOLDEN_SENTINELS.terminalAt,
    session_id: 'fake-session',
    resolved_model: 'claude-sonnet-5',
    actual_turns: 2,
    usage: { input_tokens: 4200, output_tokens: 900 },
    model_usage: {
      'claude-sonnet-5': {
        inputTokens: 1200,
        outputTokens: 340,
        cacheReadInputTokens: 64,
        cacheCreationInputTokens: 16,
        webSearchRequests: 0,
        costUSD: 0.0087,
        contextWindow: 1000000,
        maxOutputTokens: 8000,
      },
    },
    total_cost_usd: 1.07,
    sdk_subtype: 'error_max_budget_usd',
    stop_reason: 'max_budget_usd',
    errors: ['Exceeded the maximum budget of $1.00'],
    updated_at: GOLDEN_SENTINELS.terminalAt,
  });
}

/**
 * The closed terminal vocabulary, published so a consumer can implement an
 * exhaustive switch and fail loudly on anything new rather than defaulting an
 * unknown value to success.
 */
export const GOLDEN_TERMINAL_VOCABULARY = {
  state: ['pending', 'terminal'],
  terminal_status: ['succeeded', 'failed'],
  reason: [
    'completed',
    'max_turns_exhausted',
    'max_budget_exhausted',
    'sdk_error',
    'no_terminal_aggregate',
    'deadline_exceeded',
    'refused',
  ],
  succeeded_iff: "reason === 'completed'",
  settle_only_when: "state === 'terminal'",
  charge_full_reservation_when: [
    'no_terminal_aggregate',
    'deadline_exceeded',
    'receipt unreadable or absent past the deadline',
  ],
} as const;
