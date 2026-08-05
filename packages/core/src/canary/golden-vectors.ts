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
  CANARY_MAX_OUTPUT_BYTES,
  CANARY_OUTPUT_CONTENT_TYPE,
  canaryReceiptSchema,
  canaryRequestSchema,
  contractDigest,
  describeCanaryOutput,
  type CanaryReceipt,
  type CanaryRequest,
} from './contract';

/**
 * The deliverable the success vector attests to. Its byte length and hash are
 * DERIVED below rather than written by hand, so the published vector can never
 * disagree with the hashing function a consumer is told to verify against.
 */
export const GOLDEN_OUTPUT_TEXT = 'bounded canary output';

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

/**
 * A settled, successful terminal receipt — WITH its governed deliverable.
 *
 * `output_available: true` is what makes this receipt settleable as a success:
 * a terminal aggregate proves what the run cost, and the output block proves
 * what it produced. `output_sha256` is over exactly the UTF-8 bytes of
 * `output_text`, so a consumer can verify the deliverable it received is the
 * one the receipt attests to.
 */
export function goldenTerminalSuccess(): CanaryReceipt {
  const attestation = describeCanaryOutput(GOLDEN_OUTPUT_TEXT);
  return canaryReceiptSchema.parse({
    ...baseReceipt(),
    state: 'terminal',
    terminal_status: 'succeeded',
    reason: 'completed',
    terminal_at: GOLDEN_SENTINELS.terminalAt,
    session_id: 'fake-session',
    resolved_model: 'claude-sonnet-5',
    actual_turns: 2,
    output_available: true,
    output_text: GOLDEN_OUTPUT_TEXT,
    output_bytes: attestation.bytes,
    output_sha256: attestation.sha256,
    output_content_type: CANARY_OUTPUT_CONTENT_TYPE,
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
    // A ceiling hit publishes NO deliverable, even though the run was real and
    // billed. `output_text` is absent rather than empty: a caller must not be
    // able to read "nothing was produced" as "an empty result was produced".
    output_available: false,
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
    'missing_output',
    'output_too_large',
  ],
  succeeded_iff: "reason === 'completed'",
  settle_only_when: "state === 'terminal'",
  charge_full_reservation_when: [
    'no_terminal_aggregate',
    'deadline_exceeded',
    'receipt unreadable or absent past the deadline',
  ],
} as const;

/**
 * How a consumer must treat the governed deliverable.
 *
 * Published alongside the vocabulary because the failure modes here are the
 * ones a consumer is most likely to paper over: treating an absent output as an
 * empty one, or trusting a hash it never recomputed.
 */
export const GOLDEN_OUTPUT_CONTRACT = {
  content_type: CANARY_OUTPUT_CONTENT_TYPE,
  max_output_bytes: CANARY_MAX_OUTPUT_BYTES,
  output_bytes_is: 'UTF-8 byte length of output_text, NOT its UTF-16 string length',
  output_sha256_is: 'lowercase hex sha256 over exactly those UTF-8 bytes',
  available_only_when: "state === 'terminal' && terminal_status === 'succeeded'",
  absent_on: ['pending receipts (no output block at all)', 'every failed terminal receipt'],
  never_truncated:
    'output exceeding max_output_bytes FAILS the run with reason output_too_large; a truncated ' +
    'deliverable is never published',
  succeeded_requires_output:
    'a terminal receipt cannot be succeeded without an available output — an SDK success that ' +
    'produced no final text is downgraded to reason missing_output',
  verify:
    'recompute sha256 over the UTF-8 bytes of output_text and compare to output_sha256 before ' +
    'acting on the deliverable',
} as const;
