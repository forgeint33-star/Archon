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
 */
export const CANARY_CONTRACT_VERSION = 'archon.canary.v1' as const;

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
 * Stable digest of a VALIDATED contract. Half of the receipt key, so the same
 * contract always addresses the same receipt and a changed contract never
 * silently reuses one.
 */
export function contractDigest(request: CanaryRequest): string {
  return createHash('sha256').update(canonicalJson(request), 'utf8').digest('hex');
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
]);
export type CanaryTerminalReason = z.infer<typeof canaryTerminalReasonSchema>;

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
 * The governed receipt. This is what a caller settles against.
 *
 * Aggregate fields are absent on a `pending` receipt and on a terminal receipt
 * whose reason is `no_terminal_aggregate` / `deadline_exceeded` / `refused` —
 * absent, never zero. A zero would read as "this run cost nothing", which is
 * exactly the lie the whole contract exists to avoid.
 */
export const canaryReceiptSchema = z.object({
  contract_version: z.literal(CANARY_CONTRACT_VERSION),
  external_run_id: z.string(),
  external_task_id: z.string(),
  contract_digest: z.string(),

  state: canaryReceiptStateSchema,
  /** Absent while `pending`. */
  reason: canaryTerminalReasonSchema.optional(),

  /** Model requested by the contract. */
  requested_model: z.string(),
  /** Model the SDK reported it actually ran. Absent if the run never started. */
  model: z.string().optional(),

  usage: canaryUsageSchema.optional(),
  /** Raw per-model usage map exactly as the SDK reported it. */
  model_usage: z.record(z.string(), z.unknown()).optional(),
  num_turns: z.number().int().nonnegative().optional(),
  total_cost_usd: z.number().nonnegative().optional(),
  /** SDK result subtype (`success`, `error_max_turns`, …), verbatim. */
  sdk_subtype: z.string().optional(),
  /** SDK `stop_reason`, verbatim. */
  stop_reason: z.string().optional(),
  /** SDK-reported error strings, or the refusal reasons. Never contains secrets. */
  errors: z.array(z.string()).optional(),

  reservation: canaryReservationSchema,

  created_at: z.string(),
  updated_at: z.string(),
});
export type CanaryReceipt = z.infer<typeof canaryReceiptSchema>;
