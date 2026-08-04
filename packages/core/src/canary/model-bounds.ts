/**
 * Authoritative per-model maxima and prices used to compute a bounded canary
 * reservation.
 *
 * PROVENANCE. Every figure below was read out of the Claude Code CLI binary
 * that this install actually spawns — the model catalog and pricing table
 * embedded in
 *   @anthropic-ai/claude-agent-sdk-linux-x64@0.3.209 → `claude`
 *   sha256 b882f4b8b27772f897540df50f24000206f43a9426e8f7d19bd065959b69e9dd
 * (which matches the package's own manifest checksum). They are NOT taken from
 * a public price page, and NOT estimated. Re-derive them after an SDK upgrade;
 * `model-bounds.test.ts` pins the values so a silent drift fails CI rather than
 * quietly repricing every reservation.
 *
 * WHY A TABLE AND NOT A PROBE. The SDK exposes `supportedModels()`, but only on
 * a live `query` object — i.e. only after a subprocess has spawned, which is
 * already too late for a pre-call reservation. `ModelUsage.contextWindow` and
 * `.maxOutputTokens` likewise arrive on the terminal result. So the pre-call
 * bound comes from this table, and the receipt records what the SDK reported so
 * the two can be reconciled afterwards.
 *
 * An unlisted model is REFUSED, never priced by a default. Pricing an unknown
 * model would produce a confident number with nothing behind it.
 */

export interface ModelBounds {
  /** USD per 1000 input tokens. Binary: `pricing` tier `input` (per million). */
  inputUsdPer1k: number;
  /** USD per 1000 output tokens. Binary: `pricing` tier `output` (per million). */
  outputUsdPer1k: number;
  /**
   * AUTHORITATIVE maximum output tokens per turn — the binary's
   * `max_output_tokens.upper` for this model. This is the ceiling the CLI will
   * clamp any request to, so no turn can exceed it no matter what else is set.
   */
  authoritativeMaxOutputTokens: number;
  /**
   * The CLI's default per-turn output cap (`max_output_tokens.default`), used
   * when `CLAUDE_CODE_MAX_OUTPUT_TOKENS` is unset. Recorded for reference; the
   * reservation never relies on it.
   */
  defaultMaxOutputTokens: number;
  /**
   * AUTHORITATIVE context window — the binary's `context.window`. Clamps input
   * growth: once the transcript fills the window it cannot grow further.
   */
  authoritativeContextWindow: number;
}

/**
 * Model id → bounds, keyed by exact SDK model id. Short aliases (`sonnet`,
 * `haiku`, `opus`) are deliberately NOT accepted: an alias resolves inside the
 * CLI and can point at a different model after an upgrade, which would price
 * the reservation for one model and bill it for another.
 */
export const MODEL_BOUNDS: Readonly<Record<string, ModelBounds>> = Object.freeze({
  // binary: pricing tier_3_15 {input:3, output:15};
  //         context.window 1e6; max_output_tokens {default:64000, upper:128000}
  'claude-sonnet-5': Object.freeze({
    inputUsdPer1k: 0.003,
    outputUsdPer1k: 0.015,
    authoritativeMaxOutputTokens: 128_000,
    defaultMaxOutputTokens: 64_000,
    authoritativeContextWindow: 1_000_000,
  }),
  // binary: pricing haiku_45 {input:1, output:5};
  //         context.window 200000; max_output_tokens {default:32000, upper:64000}
  'claude-haiku-4-5': Object.freeze({
    inputUsdPer1k: 0.001,
    outputUsdPer1k: 0.005,
    authoritativeMaxOutputTokens: 64_000,
    defaultMaxOutputTokens: 32_000,
    authoritativeContextWindow: 200_000,
  }),
  // binary: pricing tier_5_25 {input:5, output:25};
  //         context.window 1e6; max_output_tokens {default:64000, upper:128000}
  'claude-opus-4-8': Object.freeze({
    inputUsdPer1k: 0.005,
    outputUsdPer1k: 0.025,
    authoritativeMaxOutputTokens: 128_000,
    defaultMaxOutputTokens: 64_000,
    authoritativeContextWindow: 1_000_000,
  }),
});

/** Bounds for a model id, or undefined when the model is not priceable here. */
export function getModelBounds(model: string): ModelBounds | undefined {
  return MODEL_BOUNDS[model];
}

/** Every model id the canary contract accepts, for error messages. */
export function listPriceableModels(): string[] {
  return Object.keys(MODEL_BOUNDS).sort();
}

/**
 * Conservative token count for a UTF-8 string.
 *
 * Deliberately NOT a real tokenizer: bundling one adds a vocabulary that can
 * drift from the model's, and a reservation that under-counts is worse than one
 * that over-counts. 3.5 bytes/token sits below the ~4 bytes/token typical of
 * English prose and code, so the estimate errs high.
 *
 * Used only to (a) enforce the caller's declared prompt cap and (b) price the
 * reservation — both directions in which over-counting is the safe error. The
 * exact byte count is recorded next to it so a caller who wants a tighter
 * figure can recompute with a real tokenizer.
 */
export function estimateTokens(text: string): number {
  const bytes = Buffer.byteLength(text, 'utf8');
  return Math.ceil(bytes / 3.5);
}

export interface WorstCaseInput {
  bounds: ModelBounds;
  /** Measured effective prompt (system + task), in tokens. */
  promptTokens: number;
  /** Declared turn ceiling (`--max-turns`). */
  maxTurns: number;
  /** Declared spend ceiling (`--max-budget-usd`). */
  maxBudgetUsd: number;
  /**
   * Declared per-turn output cap, delivered as `CLAUDE_CODE_MAX_OUTPUT_TOKENS`.
   * Used only for the ADVISORY figure — never for the guaranteed ceiling.
   */
  declaredMaxOutputTokens: number;
  /**
   * Declared context cap, delivered as `CLAUDE_CODE_MAX_CONTEXT_TOKENS` (with
   * `DISABLE_COMPACT`). Advisory only, same reason.
   */
  declaredMaxContextTokens: number;
}

export interface WorstCaseResult {
  /** Cost if every turn runs to the model's AUTHORITATIVE maxima. */
  fullTurnsUsd: number;
  /** `maxBudgetUsd` + one authoritative worst-case turn (stop-after overshoot). */
  budgetPlusOvershootUsd: number;
  /**
   * THE RESERVATION. The stricter of the two figures above, both computed from
   * authoritative maxima — so it holds regardless of whether the declared
   * output/context caps are honored by the binary that ends up running.
   */
  worstCaseUsd: number;
  /**
   * ADVISORY ONLY: the same computation using the DECLARED output/context caps.
   * This is what the run should actually cost when the CLI honors
   * `CLAUDE_CODE_MAX_OUTPUT_TOKENS` / `CLAUDE_CODE_MAX_CONTEXT_TOKENS`, which
   * the installed 0.3.209 binary does. It is reported so the gap between
   * "expected" and "guaranteed" is visible instead of hidden — but it must
   * NEVER be the number a caller reserves against, because nothing outside this
   * process guarantees a future binary keeps reading those variables.
   */
  declaredBoundWorstCaseUsd: number;
}

interface TurnCostInput {
  promptTokens: number;
  maxTurns: number;
  perTurnOutputTokens: number;
  contextWindow: number;
  inputUsdPer1k: number;
  outputUsdPer1k: number;
}

interface TurnCostResult {
  totalUsd: number;
  /** Cost of the single most expensive turn (always the last one). */
  worstTurnUsd: number;
}

/**
 * Cost of running `maxTurns` turns to completion.
 *
 * MODEL. Each agentic turn re-sends the accumulated transcript, so input grows
 * by one full per-turn output, clamped at the context window:
 *
 *     input(i)  = min(promptTokens + (i-1) * perTurnOutputTokens, contextWindow)
 *     output(i) = perTurnOutputTokens
 *
 * Tool results also enter the transcript, but they enter the SAME window — the
 * clamp bounds them too, which is precisely why the context window rather than
 * a guess about tool volume is the honest ceiling.
 *
 * The last turn is always the most expensive: input has grown the most (or is
 * pinned at the window) and output is always the maximum.
 */
function turnCost(input: TurnCostInput): TurnCostResult {
  const { promptTokens, maxTurns, perTurnOutputTokens, contextWindow } = input;
  const { inputUsdPer1k, outputUsdPer1k } = input;

  let totalInput = 0;
  let lastTurnInput = 0;
  for (let i = 1; i <= maxTurns; i++) {
    const turnInput = Math.min(promptTokens + (i - 1) * perTurnOutputTokens, contextWindow);
    totalInput += turnInput;
    lastTurnInput = turnInput;
  }
  const totalOutput = maxTurns * perTurnOutputTokens;

  return {
    totalUsd: (totalInput / 1000) * inputUsdPer1k + (totalOutput / 1000) * outputUsdPer1k,
    worstTurnUsd:
      (lastTurnInput / 1000) * inputUsdPer1k + (perTurnOutputTokens / 1000) * outputUsdPer1k,
  };
}

/**
 * Compute the worst-case spend for one bounded dispatch.
 *
 * TWO INDEPENDENT CEILINGS, BOTH FROM AUTHORITATIVE MAXIMA:
 *
 *  1. `--max-turns` guarantees at most `maxTurns` turns, hence `fullTurnsUsd`.
 *  2. `--max-budget-usd` guarantees the run stops once the budget is exceeded —
 *     but STOP-AFTER, so the call that crosses the line is already billed.
 *     Hence `maxBudgetUsd + one worst-case turn`.
 *
 * Both hold simultaneously, so the real ceiling is the smaller of the two, and
 * reserving the smaller is safe precisely because the larger also holds.
 *
 * The declared output/context caps deliberately do NOT enter this number. They
 * are enforced by environment variables that the installed CLI reads today but
 * that no interface contract obliges a future CLI to keep reading; a ceiling
 * that silently depends on them would be a ceiling on a hope. Their effect is
 * reported separately as {@link WorstCaseResult.declaredBoundWorstCaseUsd}.
 */
export function computeWorstCase(input: WorstCaseInput): WorstCaseResult {
  const { bounds, promptTokens, maxTurns, maxBudgetUsd } = input;
  const { inputUsdPer1k, outputUsdPer1k } = bounds;

  const authoritative = turnCost({
    promptTokens,
    maxTurns,
    perTurnOutputTokens: bounds.authoritativeMaxOutputTokens,
    contextWindow: bounds.authoritativeContextWindow,
    inputUsdPer1k,
    outputUsdPer1k,
  });

  // The declared caps can only ever tighten: a caller asking for MORE output or
  // MORE context than the model allows gets the model's ceiling, not theirs.
  const declared = turnCost({
    promptTokens,
    maxTurns,
    perTurnOutputTokens: Math.min(
      input.declaredMaxOutputTokens,
      bounds.authoritativeMaxOutputTokens
    ),
    contextWindow: Math.min(input.declaredMaxContextTokens, bounds.authoritativeContextWindow),
    inputUsdPer1k,
    outputUsdPer1k,
  });

  const fullTurnsUsd = authoritative.totalUsd;
  const budgetPlusOvershootUsd = maxBudgetUsd + authoritative.worstTurnUsd;

  return {
    fullTurnsUsd: round6(fullTurnsUsd),
    budgetPlusOvershootUsd: round6(budgetPlusOvershootUsd),
    worstCaseUsd: round6(Math.min(fullTurnsUsd, budgetPlusOvershootUsd)),
    declaredBoundWorstCaseUsd: round6(
      Math.min(declared.totalUsd, maxBudgetUsd + declared.worstTurnUsd)
    ),
  };
}

/** Round to 6dp so JSON figures compare exactly instead of drifting on float noise. */
function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}
