/**
 * The bounded canary execution contract — request shape, digest, and the
 * receipt shape it settles into.
 *
 * WHY THIS EXISTS. Archon's normal dispatch path is fire-and-forget and
 * unbounded: the HTTP response returns before any model work happens, agentic
 * turns have no ceiling, subagents fork their own sessions, and Archon's own
 * subprocess retry loop can re-run a whole billed session up to four times
 * invisibly to the caller. A caller that wants to hold a spend RESERVATION
 * against an Archon run therefore has nothing honest to reserve against.
 *
 * This contract is the narrow, opt-in alternative. The caller declares every
 * bound up front; Archon refuses anything it cannot bound; and the run settles
 * against a single terminal aggregate that the SDK reports on success AND on
 * every error subtype alike.
 *
 * WHAT IT IS NOT. This is NOT per-model-call accounting. SDK 0.3.209 reports
 * one aggregate per `sendQuery`, never one entry per outward model attempt, and
 * an attempt that dies without a terminal result reports nothing at all. Every
 * figure here is labelled per-DISPATCH for that reason. See
 * {@link CANARY_CONTRACT_VERSION}.
 */
import { z } from '@hono/zod-openapi';
import { createHash } from 'node:crypto';

/**
 * Contract version. Part of the digest, so a version bump necessarily produces
 * a different receipt key and can never be confused with an older run.
 *
 * v2 (this version) closes a cross-principal collision in v1. v1 keyed receipts
 * by `(external_run_id, external_task_id, contract_digest)` with the principal
 * absent from BOTH the digest and the uniqueness key. Two principals submitting
 * the same external ids with identical bodies therefore produced one row: the
 * second principal's insert was suppressed by ON CONFLICT, its principal-scoped
 * read-back found nothing, and the submit failed. Worse than the error was the
 * shape of the bug — external ids are the CALLER's namespace, so two unrelated
 * callers colliding on `run-1/task-1` is ordinary, not exotic.
 *
 * v2 makes the authenticated principal part of the canonical identity, the
 * digest, and the uniqueness key. There is no v1→v2 upgrade path because v1 was
 * never deployed; a v1 payload is refused outright by the version literal.
 */
export const CANARY_CONTRACT_VERSION = 'archon.canary.v2' as const;

/**
 * External identifier: the caller's own run/task id. Kept deliberately narrow
 * — it lands in a URL path and a receipt key, so no slashes, no whitespace, no
 * ambiguity between two spellings of "the same" id.
 */
const externalIdSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, 'must be alphanumeric with . _ : - separators');

/**
 * The request contract. Every bound is REQUIRED: a partially-declared bound is
 * not a bound, and defaulting a missing one would invent a ceiling the caller
 * never agreed to.
 */
export const canaryRequestSchema = z
  .object({
    /** Must match {@link CANARY_CONTRACT_VERSION} exactly. */
    contract_version: z.literal(CANARY_CONTRACT_VERSION),

    /** Caller's run id. Half of the receipt key. */
    external_run_id: externalIdSchema,
    /** Caller's task id, unique within the run. Other half of the receipt key. */
    external_task_id: externalIdSchema,

    /**
     * Exact model id. Not a tier keyword, not an alias, not "inherit": the
     * reservation is priced for one specific model, so anything that could
     * resolve differently later would invalidate it. Must be present in the
     * model-bounds table (see `model-bounds.ts`) or the request is refused —
     * an unpriceable model cannot be reserved against.
     */
    model: z.string().min(1),

    /** Hard ceiling on agentic turns. With subagents denied, this is the exact
     *  ceiling on outward model calls for the dispatch. */
    max_turns: z.number().int().min(1).max(100),

    /**
     * Hard ceiling passed to the SDK as `--max-budget-usd`.
     *
     * STOP-AFTER, not refuse-before: the SDK aborts once the budget is
     * exceeded, so the call that crosses the line is already billed. The
     * guaranteed ceiling is this plus one worst-case turn, which is what the
     * reservation reports.
     */
    max_budget_usd: z.number().positive().max(1000),

    /**
     * Ceiling on the COMPLETE effective prompt (system prompt + task prompt),
     * measured — not assumed — before anything spawns. Over the cap the request
     * is refused with no spend. This is the operational answer to "bound or
     * refuse every source of prompt/context growth".
     */
    max_prompt_tokens: z.number().int().min(1).max(1_000_000),

    /**
     * Per-turn output cap, delivered to the CLI as
     * `CLAUDE_CODE_MAX_OUTPUT_TOKENS` (verified read by the installed 0.3.209
     * binary, which clamps it to the model's `max_output_tokens.upper`).
     *
     * ADVISORY for the reservation, not load-bearing: the guaranteed ceiling is
     * always computed from the model's authoritative maximum, because nothing
     * obliges a future CLI to keep reading this variable. Its effect is
     * reported separately as `reservation.declared_bound_worst_case_usd`.
     */
    max_output_tokens_per_turn: z.number().int().min(1).max(200_000),

    /**
     * Context cap, delivered as `CLAUDE_CODE_MAX_CONTEXT_TOKENS` together with
     * `DISABLE_COMPACT=1`.
     *
     * Disabling auto-compaction is deliberate and is itself a bound: each
     * compaction is an extra summarization call that `--max-turns` does not
     * count. A bounded run should fail at its context limit loudly rather than
     * spend unbudgeted calls to squeeze past it.
     *
     * Advisory for the reservation, same reasoning as the output cap.
     */
    max_context_tokens: z.number().int().min(1).max(1_000_000),

    /**
     * The caller's own ceiling on the computed WORST CASE. Archon computes the
     * worst case from the measured prompt and the model's authoritative maxima,
     * and refuses before spawning if it exceeds this. Without it the caller
     * would have to reserve blind, because the true worst case is not knowable
     * until Archon has measured the prompt.
     */
    max_reservation_usd: z.number().positive().max(10_000),

    /**
     * Absolute wall-clock deadline (ISO-8601). Enforced twice: refused at
     * submit if already past, and aborted mid-run when reached. Absolute rather
     * than a duration so queueing time cannot silently extend it.
     */
    deadline_at: z.string().datetime(),

    /** The task text. Counted into the measured effective prompt. */
    prompt: z.string().min(1),

    /**
     * Explicit system prompt. A plain string, never the `claude_code` preset:
     * the preset is expanded inside the CLI, so its size is not knowable here
     * and the effective prompt could not be measured honestly.
     */
    system_prompt: z.string().min(1),

    /** Absolute working directory. Must exist; validated at submit. */
    cwd: z.string().min(1),

    /** Tool names denied on top of the mandatory bounded-mode set. */
    extra_disallowed_tools: z.array(z.string().min(1)).max(100).optional(),

    // NOTE: there is deliberately no `principal` field. The principal is
    // AUTHORITY, and authority is never taken from the payload — it is derived
    // server-side from the validated bearer token (see `resolveCanaryPrincipal`)
    // and folded into the canonical identity by `contractDigest`. `.strict()`
    // below turns a caller-supplied `principal` into a 400 rather than letting
    // it sit ignored in a body the caller believes was honoured.
  })
  .strict();

export type CanaryRequest = z.infer<typeof canaryRequestSchema>;

/**
 * Canonical JSON: object keys sorted at every depth, no incidental whitespace.
 *
 * The digest must depend on the contract's MEANING, not on how the caller
 * happened to serialize it — otherwise a re-submit with reordered keys would
 * look like a different contract and start a second billed run.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

/**
 * The canonical request identity: the AUTHENTICATED principal plus the
 * validated request, and nothing else.
 *
 * The principal is the first key on purpose. External run/task ids belong to
 * the caller's own namespace, so two unrelated callers using `run-1/task-1` is
 * ordinary. Identity that omits who is asking is therefore not an identity at
 * all — which is exactly how v1 collided.
 */
export interface CanaryCanonicalIdentity {
  /** Resolved from the bearer token server-side. Never read from the body. */
  authenticated_principal: string;
  request: CanaryRequest;
}

export function canonicalRequestIdentity(
  request: CanaryRequest,
  authenticatedPrincipal: string
): CanaryCanonicalIdentity {
  return { authenticated_principal: authenticatedPrincipal, request };
}

/**
 * Stable digest over the canonical identity. Part of the receipt key, so the
 * same principal re-submitting the same contract always addresses the same
 * receipt, a changed contract never silently reuses one, and a DIFFERENT
 * principal never addresses another's receipt at all.
 *
 * `authenticatedPrincipal` must come from token resolution. Passing a
 * caller-supplied value here would reintroduce the v1 flaw in a new place.
 */
export function contractDigest(request: CanaryRequest, authenticatedPrincipal: string): string {
  if (!authenticatedPrincipal) {
    // Fail loudly rather than digest an empty principal, which would make every
    // unauthenticated submission share one identity.
    throw new Error('contractDigest requires a resolved authenticated principal');
  }
  const identity = canonicalRequestIdentity(request, authenticatedPrincipal);
  return createHash('sha256').update(canonicalJson(identity), 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// Receipt
// ---------------------------------------------------------------------------

/**
 * Lifecycle state of a receipt.
 *
 * `pending` exists precisely so a submit acknowledgement can never be mistaken
 * for a settlement: submit creates a `pending` row and returns, and only the
 * terminal write flips it. A caller settling on anything but `terminal` is
 * settling on nothing.
 */
export const canaryReceiptStateSchema = z.enum(['pending', 'terminal']);
export type CanaryReceiptState = z.infer<typeof canaryReceiptStateSchema>;

/**
 * Why the dispatch ended. Distinguishes the cases a reservation must price
 * differently, and — importantly — records budget and turn exhaustion honestly
 * rather than reporting them as ordinary completion.
 */
export const canaryTerminalReasonSchema = z.enum([
  /** SDK returned subtype `success`. */
  'completed',
  /** SDK returned `error_max_turns` — the turn ceiling was hit. */
  'max_turns_exhausted',
  /** SDK returned `error_max_budget_usd` — the budget ceiling was hit. */
  'max_budget_exhausted',
  /** SDK returned some other error subtype but still carried its aggregate. */
  'sdk_error',
  /**
   * The dispatch ended with NO terminal aggregate — a subprocess that died, or
   * a stream that ended without a result. Nothing is recoverable about its
   * spend, so settlement must charge the full reservation.
   */
  'no_terminal_aggregate',
  /** The wall-clock deadline was reached and the run was aborted. */
  'deadline_exceeded',
  /** Refused before any subprocess spawned. Zero spend. */
  'refused',
  /**
   * The SDK reported success but produced no usable final text.
   *
   * FAILS CLOSED: a receipt that says "succeeded" while carrying no deliverable
   * would let a caller settle spend for an outcome nobody can inspect. The run
   * still happened and still cost money, so its aggregate is persisted — only
   * the success claim is withheld.
   */
  'missing_output',
  /**
   * The final text exceeded {@link CANARY_MAX_OUTPUT_BYTES}.
   *
   * FAILS CLOSED and is NEVER truncated: a truncated deliverable that still
   * reported success would be silently wrong, and its hash would attest to
   * bytes the agent did not produce. As above, the cost aggregate is kept.
   */
  'output_too_large',
]);
export type CanaryTerminalReason = z.infer<typeof canaryTerminalReasonSchema>;

/**
 * Coarse terminal outcome, present only on a `terminal` receipt.
 *
 * Deliberately separate from `reason`: a consumer deciding "did this work?"
 * must not have to enumerate every reason value, and a reason added in a later
 * version must not silently read as success to an older consumer. `reason`
 * remains the precise answer; this is the safe one.
 *
 * `succeeded` means exactly `reason === 'completed'`. Every ceiling hit —
 * turns, budget, deadline — is `failed`, because a run that stopped at a bound
 * did not do the work it was asked to do.
 */
export const canaryTerminalStatusSchema = z.enum(['succeeded', 'failed']);
export type CanaryTerminalStatus = z.infer<typeof canaryTerminalStatusSchema>;

/** The single place the reason → status mapping is decided. */
export function terminalStatusForReason(reason: CanaryTerminalReason): CanaryTerminalStatus {
  return reason === 'completed' ? 'succeeded' : 'failed';
}

/** Per-dispatch usage aggregate. NEVER per model attempt — see file header. */
export const canaryUsageSchema = z.object({
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
  cache_read_input_tokens: z.number().int().nonnegative().optional(),
  cache_creation_input_tokens: z.number().int().nonnegative().optional(),
});
export type CanaryUsage = z.infer<typeof canaryUsageSchema>;

/** The computed worst case the caller reserves against. */
export const canaryReservationSchema = z.object({
  /** Effective prompt tokens actually measured (system + task). */
  measured_prompt_tokens: z.number().int().nonnegative(),
  /** Bytes of that same effective prompt — exact, unlike the token estimate. */
  measured_prompt_bytes: z.number().int().nonnegative(),
  /** Model's AUTHORITATIVE max output tokens per turn (from the CLI catalog). */
  model_max_output_tokens: z.number().int().positive(),
  /** Model's AUTHORITATIVE context window (from the CLI catalog). */
  model_context_window: z.number().int().positive(),
  /** Cost if every turn runs to the model's authoritative maxima. */
  full_turns_usd: z.number().nonnegative(),
  /** `max_budget_usd` plus one authoritative worst-case turn (stop-after overshoot). */
  budget_plus_overshoot_usd: z.number().nonnegative(),
  /**
   * THE FIGURE TO RESERVE. Stricter of the two above, both from authoritative
   * maxima — so it holds whether or not the declared output/context caps are
   * honored by whichever CLI binary runs.
   */
  worst_case_usd: z.number().nonnegative(),
  /**
   * ADVISORY: the same worst case under the DECLARED output/context caps —
   * what the run should actually cost on the installed 0.3.209 binary, which
   * does read those env vars. Reported so the gap between expected and
   * guaranteed is visible. Never reserve against this.
   */
  declared_bound_worst_case_usd: z.number().nonnegative(),
});
export type CanaryReservation = z.infer<typeof canaryReservationSchema>;

/**
 * The ONE canonical media type for a governed output.
 *
 * A single literal rather than a negotiated set: the deliverable is the agent's
 * final assistant text, always, and letting it vary would make every consumer
 * branch on a value that never actually changes. If a future contract carries
 * a second representation it gets a version bump, not a widened enum.
 */
export const CANARY_OUTPUT_CONTENT_TYPE = 'text/plain; charset=utf-8' as const;

/**
 * Hard ceiling on persisted output, in UTF-8 bytes (1 MiB).
 *
 * Explicit rather than implicit-by-column-type: the limit is part of the
 * contract a caller plans against, and a database that silently accepted more
 * on one dialect than another would make the contract dialect-dependent.
 * Exceeding it is a FAILURE, never a truncation — see `output_too_large`.
 */
export const CANARY_MAX_OUTPUT_BYTES = 1_048_576;

/**
 * The governed deliverable attached to a terminal receipt.
 *
 * Present as a block only on `terminal` receipts. `output_available` is the
 * single field a consumer branches on; when it is false the remaining fields
 * are absent rather than empty, so "no deliverable" cannot be misread as "an
 * empty deliverable".
 */
export const canaryOutputSchema = z.object({
  /** True iff a valid deliverable was captured and persisted. */
  output_available: z.boolean(),
  /** The agent's final assistant text, byte-for-byte as the SDK produced it. */
  output_text: z.string().optional(),
  /** UTF-8 byte length of `output_text` — not its UTF-16 `.length`. */
  output_bytes: z.number().int().nonnegative().optional(),
  /** Lowercase hex sha256 over exactly those UTF-8 bytes. */
  output_sha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
  /** Always {@link CANARY_OUTPUT_CONTENT_TYPE} when output is available. */
  output_content_type: z.literal(CANARY_OUTPUT_CONTENT_TYPE).optional(),
});
export type CanaryOutput = z.infer<typeof canaryOutputSchema>;

/**
 * Compute the governed attestation over a deliverable.
 *
 * The bytes are taken verbatim: no trimming, no normalisation, no redaction.
 * The hash must attest to exactly what is persisted and returned, so any
 * transformation here would make `output_sha256` a claim about text that was
 * never delivered.
 */
export function describeCanaryOutput(text: string): {
  bytes: number;
  sha256: string;
} {
  const buf = Buffer.from(text, 'utf8');
  return { bytes: buf.byteLength, sha256: createHash('sha256').update(buf).digest('hex') };
}

/**
 * The governed receipt. This is what a caller settles against.
 *
 * Aggregate fields are absent on a `pending` receipt and on a terminal receipt
 * whose reason is `no_terminal_aggregate` / `deadline_exceeded` / `refused` —
 * absent, never zero. A zero would read as "this run cost nothing", which is
 * exactly the lie the whole contract exists to avoid.
 */
export const canaryReceiptSchema = z.object({
  // ─── Identity ──────────────────────────────────────────────────────────
  contract_version: z.literal(CANARY_CONTRACT_VERSION),
  /**
   * The AUTHENTICATED principal that submitted this run, echoed back so a
   * settling caller can verify the receipt is theirs rather than inferring it
   * from the fact that a read succeeded.
   */
  principal: z.string(),
  external_run_id: z.string(),
  external_task_id: z.string(),
  /** sha256 over `{authenticated_principal, request}` — see `contractDigest`. */
  contract_digest: z.string(),
  /**
   * Archon-side identity of this submission, stable for the life of the
   * receipt. Distinct from the caller's external ids: it identifies the record
   * in Archon regardless of what the caller called it.
   */
  request_id: z.string(),
  /**
   * Provider conversation identity — the SDK session the dispatch ran in.
   * Absent when the run never reached a session (refusal, dead subprocess
   * before init). This is the handle for correlating with provider-side logs.
   */
  session_id: z.string().optional(),

  // ─── Lifecycle ─────────────────────────────────────────────────────────
  state: canaryReceiptStateSchema,
  /** Coarse outcome. Absent while `pending`. */
  terminal_status: canaryTerminalStatusSchema.optional(),
  /** Precise outcome. Absent while `pending`. */
  reason: canaryTerminalReasonSchema.optional(),
  /** ISO-8601 instant of settlement. Absent while `pending`. */
  terminal_at: z.string().optional(),

  // ─── Model ─────────────────────────────────────────────────────────────
  /** Model the contract asked for. */
  requested_model: z.string(),
  /**
   * Model the SDK reported it actually RAN. Absent if the run never started.
   * A settling caller must price this one, not `requested_model` — they differ
   * exactly when something went wrong enough to matter.
   */
  resolved_model: z.string().optional(),

  // ─── Turns ─────────────────────────────────────────────────────────────
  /** The ceiling the contract declared (`max_turns`). Always present. */
  declared_max_turns: z.number().int().positive(),
  /**
   * Turns the SDK reported it actually used. Absent when no terminal aggregate
   * arrived — absent, never 0, since 0 would read as "it did nothing".
   */
  actual_turns: z.number().int().nonnegative().optional(),

  // ─── Aggregate (per-DISPATCH, never per model attempt) ─────────────────
  usage: canaryUsageSchema.optional(),
  /** Raw per-model usage map exactly as the SDK reported it. */
  model_usage: z.record(z.string(), z.unknown()).optional(),
  total_cost_usd: z.number().nonnegative().optional(),

  // ─── Governed output ───────────────────────────────────────────────────
  // Present only on a `terminal` receipt. See canaryOutputSchema.
  output_available: z.boolean().optional(),
  output_text: z.string().optional(),
  output_bytes: z.number().int().nonnegative().optional(),
  output_sha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
  output_content_type: z.literal(CANARY_OUTPUT_CONTENT_TYPE).optional(),

  // ─── Failure details ───────────────────────────────────────────────────
  /** SDK result subtype (`success`, `error_max_turns`, …), verbatim. */
  sdk_subtype: z.string().optional(),
  /** SDK `stop_reason`, verbatim. */
  stop_reason: z.string().optional(),
  /** SDK error strings or refusal reasons, credential-redacted and truncated. */
  errors: z.array(z.string()).optional(),

  reservation: canaryReservationSchema,

  created_at: z.string(),
  updated_at: z.string(),
});
export type CanaryReceipt = z.infer<typeof canaryReceiptSchema>;

/**
 * Structural invariants the output block must satisfy. Returns the violations;
 * empty means the receipt is coherent.
 *
 * This is the fail-closed check required by the contract: it is impossible for
 * a coherent receipt to claim `succeeded` while carrying no deliverable. The
 * schema alone cannot express that — it is a cross-field rule — so it lives
 * here and is enforced at BOTH ends: the runner refuses to write a violating
 * receipt, and `rowToReceipt` refuses to return one.
 *
 * Returning violations rather than throwing keeps it usable as a plain
 * assertion in tests and as a guard at each boundary.
 */
export function findReceiptOutputViolations(receipt: CanaryReceipt): string[] {
  const v: string[] = [];
  const hasAnyOutputField =
    receipt.output_text !== undefined ||
    receipt.output_bytes !== undefined ||
    receipt.output_sha256 !== undefined ||
    receipt.output_content_type !== undefined;

  if (receipt.state === 'pending') {
    // A pending acknowledgement exposes NO output at all — not even
    // `output_available: false`, which a caller could mistake for a settled
    // "this produced nothing".
    if (receipt.output_available !== undefined) {
      v.push('pending receipt must not carry output_available');
    }
    if (hasAnyOutputField) v.push('pending receipt must not carry output fields');
    return v;
  }

  if (receipt.output_available === undefined) {
    v.push('terminal receipt must state output_available');
    return v;
  }

  if (receipt.output_available) {
    if (receipt.output_text === undefined) v.push('output_available requires output_text');
    if (receipt.output_bytes === undefined) v.push('output_available requires output_bytes');
    if (receipt.output_sha256 === undefined) v.push('output_available requires output_sha256');
    if (receipt.output_content_type === undefined) {
      v.push('output_available requires output_content_type');
    }
    if (receipt.output_text !== undefined) {
      // Re-derive rather than trust the stored numbers: these are the two
      // fields a consumer verifies against, so a mismatch between them and the
      // text is a corrupt receipt, not a cosmetic drift.
      const actual = describeCanaryOutput(receipt.output_text);
      if (receipt.output_bytes !== undefined && receipt.output_bytes !== actual.bytes) {
        v.push(`output_bytes ${receipt.output_bytes} does not match text (${actual.bytes})`);
      }
      if (receipt.output_sha256 !== undefined && receipt.output_sha256 !== actual.sha256) {
        v.push('output_sha256 does not match output_text');
      }
      if (actual.bytes > CANARY_MAX_OUTPUT_BYTES) {
        v.push(`output_bytes ${actual.bytes} exceeds the ${CANARY_MAX_OUTPUT_BYTES}-byte ceiling`);
      }
    }
  } else {
    // Unavailable means absent, never empty — an empty string would read as a
    // real deliverable that happened to say nothing.
    if (receipt.output_text !== undefined) {
      v.push('output_available:false must not carry output_text');
    }
    if (receipt.output_sha256 !== undefined) {
      v.push('output_available:false must not carry output_sha256');
    }
  }

  // THE fail-closed rule: success is a claim about a deliverable.
  // (`output_available` is narrowed to boolean by the undefined guard above.)
  if (receipt.terminal_status === 'succeeded' && !receipt.output_available) {
    v.push('terminal_status succeeded requires an available output');
  }
  // ...and its converse: only a completed run may carry one.
  if (receipt.output_available && receipt.terminal_status !== 'succeeded') {
    v.push('output_available:true requires terminal_status succeeded');
  }

  return v;
}
