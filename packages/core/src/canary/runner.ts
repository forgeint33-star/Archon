/**
 * The bounded canary execution path.
 *
 * WHY THIS IS NOT THE ORCHESTRATOR. Archon's normal chat path grows its prompt
 * from sources this contract cannot bound: conversation history, resumed
 * sessions, the `claude_code` system-prompt preset (expanded inside the CLI, so
 * its size is not knowable here), filesystem CLAUDE.md / skills / commands /
 * agents, and injected native tools. Rather than try to cap each of those in a
 * shared path — which would risk changing normal behaviour and would still
 * leave the preset unmeasurable — the canary uses a separate path that never
 * has them. Everything the model sees is a string this module holds, so
 * "measure the complete effective prompt" is a fact rather than an estimate.
 *
 * WHAT THIS PATH DOES NOT TOUCH. No conversation, no session, no message rows,
 * no isolation environment, no workflow run. It reads nothing from the database
 * except its own receipt. Normal Archon behaviour is unchanged by construction.
 */
import { existsSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { createLogger } from '@archon/paths';
import { ClaudeProvider, BoundedModeViolationError } from '@archon/providers';
import type { BoundedModeOptions, MessageChunk } from '@archon/providers';
import {
  createPendingCanaryReceipt,
  listCanaryDigestsForTask,
  settleCanaryReceipt,
} from '../db/canary-receipts';
import type { CanaryReceiptKey, CanaryTerminalWrite } from '../db/canary-receipts';
import {
  CANARY_CONTRACT_VERSION,
  CANARY_MAX_OUTPUT_BYTES,
  CANARY_OUTPUT_CONTENT_TYPE,
  contractDigest,
  describeCanaryOutput,
  type CanaryReceipt,
  type CanaryRequest,
  type CanaryReservation,
  type CanaryTerminalReason,
  type CanaryUsage,
} from './contract';
import {
  computeWorstCase,
  estimateTokens,
  getModelBounds,
  listPriceableModels,
} from './model-bounds';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('canary.runner');
  return cachedLog;
}

/**
 * Subprocess retries for a bounded dispatch. Zero, always: each retry is a
 * fresh billed model session invisible to the caller, and a reservation cannot
 * price a multiplier it cannot see. Not configurable — a canary that allowed
 * retries would not be the bounded mode this contract describes.
 */
const CANARY_SUBPROCESS_RETRIES = 0;

/** Refusal — nothing spawned, nothing billed. */
export class CanaryRefusedError extends Error {
  constructor(
    public readonly code:
      | 'unknown_model'
      | 'prompt_over_cap'
      | 'reservation_over_cap'
      | 'deadline_passed'
      | 'bad_cwd'
      | 'contract_conflict',
    message: string,
    /** Present when the refusal was computable — lets the caller see the numbers. */
    public readonly reservation?: CanaryReservation
  ) {
    super(message);
    this.name = 'CanaryRefusedError';
  }
}

/** Outcome of a submit: either a fresh run was started, or one already existed. */
export interface CanarySubmitResult {
  /** False when this exact contract had already been submitted. */
  started: boolean;
  receipt: CanaryReceipt;
}

/**
 * The complete effective prompt, exactly as it will reach the SDK.
 *
 * Two parts and no more: the explicit system prompt (delivered verbatim in the
 * SDK's `initialize` control request) and the task prompt (delivered as the
 * single user message). With `settingSources: []` nothing else is loaded from
 * disk, and bounded mode refuses history, resume and native tools — so this
 * really is everything Archon contributes.
 *
 * NOT INCLUDED, and deliberately so: the CLI's own built-in tool schemas, which
 * are a function of the enabled tool set rather than of anything the caller
 * sent. They are bounded by the context window and therefore already priced by
 * the reservation's window clamp; they are not measurable from this process.
 */
export interface EffectivePrompt {
  systemPrompt: string;
  taskPrompt: string;
  bytes: number;
  tokens: number;
}

export function measureEffectivePrompt(request: CanaryRequest): EffectivePrompt {
  const systemPrompt = request.system_prompt;
  const taskPrompt = request.prompt;
  const combined = `${systemPrompt}\n${taskPrompt}`;
  return {
    systemPrompt,
    taskPrompt,
    bytes: Buffer.byteLength(combined, 'utf8'),
    tokens: estimateTokens(combined),
  };
}

/**
 * Everything that must hold before a subprocess may spawn.
 *
 * Ordered cheapest-first, and every failure is a refusal with zero spend. This
 * is the pre-call gate the contract requires; it is a gate on the DISPATCH, not
 * on individual model calls — no such per-call hook exists in SDK 0.3.209, and
 * claiming one would be a lie.
 */
export function admitCanaryRequest(
  request: CanaryRequest,
  now: Date
): { prompt: EffectivePrompt; reservation: CanaryReservation } {
  const bounds = getModelBounds(request.model);
  if (!bounds) {
    throw new CanaryRefusedError(
      'unknown_model',
      `Model '${request.model}' has no authoritative bounds, so its worst case cannot be priced. ` +
        `Priceable models: ${listPriceableModels().join(', ')}`
    );
  }

  const deadline = new Date(request.deadline_at);
  if (deadline.getTime() <= now.getTime()) {
    throw new CanaryRefusedError(
      'deadline_passed',
      `deadline_at ${request.deadline_at} is already in the past`
    );
  }

  if (!isAbsolute(request.cwd)) {
    throw new CanaryRefusedError('bad_cwd', `cwd must be an absolute path (got '${request.cwd}')`);
  }
  if (!existsSync(request.cwd) || !statSync(request.cwd).isDirectory()) {
    throw new CanaryRefusedError('bad_cwd', `cwd '${request.cwd}' is not an existing directory`);
  }

  const prompt = measureEffectivePrompt(request);
  if (prompt.tokens > request.max_prompt_tokens) {
    throw new CanaryRefusedError(
      'prompt_over_cap',
      `Effective prompt is ${prompt.tokens} tokens (${prompt.bytes} bytes), over the declared ` +
        `max_prompt_tokens of ${request.max_prompt_tokens}. Measured, not assumed.`
    );
  }

  const worstCase = computeWorstCase({
    bounds,
    promptTokens: prompt.tokens,
    maxTurns: request.max_turns,
    maxBudgetUsd: request.max_budget_usd,
    declaredMaxOutputTokens: request.max_output_tokens_per_turn,
    declaredMaxContextTokens: request.max_context_tokens,
  });

  const reservation: CanaryReservation = {
    measured_prompt_tokens: prompt.tokens,
    measured_prompt_bytes: prompt.bytes,
    model_max_output_tokens: bounds.authoritativeMaxOutputTokens,
    model_context_window: bounds.authoritativeContextWindow,
    full_turns_usd: worstCase.fullTurnsUsd,
    budget_plus_overshoot_usd: worstCase.budgetPlusOvershootUsd,
    worst_case_usd: worstCase.worstCaseUsd,
    declared_bound_worst_case_usd: worstCase.declaredBoundWorstCaseUsd,
  };

  if (reservation.worst_case_usd > request.max_reservation_usd) {
    throw new CanaryRefusedError(
      'reservation_over_cap',
      `Guaranteed worst case is $${reservation.worst_case_usd.toFixed(4)}, over the declared ` +
        `max_reservation_usd of $${request.max_reservation_usd.toFixed(4)}. ` +
        `Computed from ${request.model}'s authoritative maxima ` +
        `(${bounds.authoritativeMaxOutputTokens} output tokens/turn, ` +
        `${bounds.authoritativeContextWindow} context window), not from the declared caps.`,
      reservation
    );
  }

  return { prompt, reservation };
}

/**
 * Strip anything credential-shaped from text destined for a receipt.
 *
 * Receipts are readable over HTTP, and SDK error strings can quote environment
 * contents or an Authorization header. Redaction is by PATTERN rather than by
 * comparison against known secrets, so a credential this process never saw is
 * still caught. Truncation bounds the row as well.
 */
export function redactForReceipt(text: string): string {
  const redacted = text
    // Anthropic / OpenAI style keys, OAuth tokens, and bearer headers.
    .replace(/\b(sk-[A-Za-z0-9_-]{8,}|sk-ant-[A-Za-z0-9_-]{8,})\b/g, '[redacted-key]')
    .replace(/\bghp_[A-Za-z0-9]{8,}\b/g, '[redacted-token]')
    .replace(/\bgithub_pat_[A-Za-z0-9_]{8,}\b/g, '[redacted-token]')
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [redacted]')
    // Any KEY=value / KEY: value where the key name looks secret-bearing.
    .replace(
      /\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|APIKEY|CREDENTIAL)[A-Z0-9_]*)\s*[:=]\s*\S+/gi,
      '$1=[redacted]'
    );
  const MAX = 2000;
  return redacted.length > MAX ? `${redacted.slice(0, MAX)}…[truncated]` : redacted;
}

/**
 * Map an SDK result chunk to a terminal reason.
 *
 * Budget and turn exhaustion get their OWN reasons rather than folding into a
 * generic error: a caller reconciling a reservation needs to know it hit a
 * ceiling, and reporting either as ordinary completion — or as an unspecified
 * failure — would misstate what happened.
 */
export function classifyTerminalReason(chunk: {
  isError?: boolean;
  errorSubtype?: string;
}): CanaryTerminalReason {
  if (!chunk.isError) return 'completed';
  switch (chunk.errorSubtype) {
    case 'error_max_turns':
      return 'max_turns_exhausted';
    case 'error_max_budget_usd':
      return 'max_budget_exhausted';
    default:
      return 'sdk_error';
  }
}

function toCanaryUsage(tokens: MessageChunk & { type: 'result' }): CanaryUsage | undefined {
  const t = tokens.tokens;
  if (!t) return undefined;
  return {
    input_tokens: t.input,
    output_tokens: t.output,
    ...(t.cacheRead !== undefined ? { cache_read_input_tokens: t.cacheRead } : {}),
    ...(t.cacheCreation !== undefined ? { cache_creation_input_tokens: t.cacheCreation } : {}),
  };
}

/** Build the provider-level bounded posture from a validated contract. */
export function buildBoundedOptions(request: CanaryRequest): BoundedModeOptions {
  return {
    maxTurns: request.max_turns,
    maxBudgetUsd: request.max_budget_usd,
    maxSubprocessRetries: CANARY_SUBPROCESS_RETRIES,
    // No filesystem setting sources: no CLAUDE.md, no skills, no commands, no
    // filesystem-defined agents. This is what makes the prompt measurable.
    settingSources: [],
    maxOutputTokens: request.max_output_tokens_per_turn,
    maxContextTokens: request.max_context_tokens,
    ...(request.extra_disallowed_tools
      ? { extraDisallowedTools: request.extra_disallowed_tools }
      : {}),
  };
}

/**
 * Decide the governed output for a dispatch that the SDK reported as success.
 *
 * Returns either the attested deliverable, or a REPLACEMENT terminal reason
 * that fails the run closed. It never returns "success with nothing", and it
 * never truncates: a shortened deliverable carrying a hash of the shortened
 * bytes would attest to text the agent never produced.
 *
 * Whitespace-only counts as absent — a run whose entire deliverable is a
 * newline produced nothing a caller can act on. The emptiness TEST trims; the
 * persisted bytes never do, so `output_sha256` always covers exactly what is
 * returned.
 */
export function governSuccessOutput(
  resultText: string | undefined
):
  | { ok: true; output: { text: string; bytes: number; sha256: string; contentType: string } }
  | { ok: false; reason: CanaryTerminalReason; error: string } {
  if (resultText === undefined || resultText.trim() === '') {
    return {
      ok: false,
      reason: 'missing_output',
      error:
        'The SDK reported success but produced no final assistant text. Failing closed: a ' +
        'succeeded receipt must carry a deliverable. The run still executed and its cost ' +
        'aggregate is recorded below.',
    };
  }

  const { bytes, sha256 } = describeCanaryOutput(resultText);
  if (bytes > CANARY_MAX_OUTPUT_BYTES) {
    return {
      ok: false,
      reason: 'output_too_large',
      error:
        `The final assistant text is ${bytes} UTF-8 bytes, over the ${CANARY_MAX_OUTPUT_BYTES}-byte ` +
        'ceiling. Failing closed rather than truncating: a truncated deliverable reported as ' +
        'success would be silently wrong. The run still executed and its cost aggregate is ' +
        'recorded below.',
    };
  }

  return {
    ok: true,
    output: { text: resultText, bytes, sha256, contentType: CANARY_OUTPUT_CONTENT_TYPE },
  };
}

/** Injected so tests can drive a fake provider without a real subprocess. */
export interface CanaryRunnerDeps {
  /** Provider factory. Defaults to a fresh ClaudeProvider. */
  createProvider?: () => Pick<ClaudeProvider, 'sendQuery'>;
  /** Clock, for deterministic deadline tests. */
  now?: () => Date;
}

/**
 * Run one bounded dispatch to completion and settle its receipt.
 *
 * Always settles, on every path — success, SDK error, dead subprocess, deadline,
 * or an unexpected throw. A `pending` receipt that never becomes `terminal`
 * would leave the caller's reservation held open forever, so the terminal write
 * lives in a `finally`-equivalent position rather than on the happy path.
 */
export async function executeCanaryRun(
  request: CanaryRequest,
  key: CanaryReceiptKey,
  reservationPrompt: EffectivePrompt,
  deps: CanaryRunnerDeps = {}
): Promise<void> {
  const now = deps.now ?? ((): Date => new Date());
  const provider = deps.createProvider ? deps.createProvider() : new ClaudeProvider();

  const controller = new AbortController();
  const deadlineMs = new Date(request.deadline_at).getTime() - now().getTime();
  let deadlineFired = false;
  const deadlineTimer = setTimeout(
    () => {
      deadlineFired = true;
      controller.abort();
    },
    Math.max(0, deadlineMs)
  );

  let terminal: CanaryTerminalWrite | undefined;

  try {
    const events = provider.sendQuery(reservationPrompt.taskPrompt, request.cwd, undefined, {
      model: request.model,
      systemPrompt: reservationPrompt.systemPrompt,
      abortSignal: controller.signal,
      bounded: buildBoundedOptions(request),
      // Never persist a transcript: a bounded run is a one-shot with nothing to
      // resume, and a transcript on disk is a context source for some later run.
      persistSession: false,
    });

    for await (const chunk of events) {
      if (chunk.type !== 'result') continue;
      // The FIRST terminal result wins. A provider that somehow emitted two
      // would otherwise have its later, possibly-emptier aggregate overwrite
      // the real one.
      if (terminal) continue;
      const sdkReason = classifyTerminalReason(chunk);

      // Output is governed ONLY on the success path. A run that hit a ceiling
      // or errored is a failure regardless of what text it happened to leave
      // behind, and attaching a deliverable to it would invite settling on a
      // partial result as though the work were done.
      const governed = sdkReason === 'completed' ? governSuccessOutput(chunk.result) : undefined;
      const reason = governed && !governed.ok ? governed.reason : sdkReason;
      const outputErrors = governed && !governed.ok ? [governed.error] : [];
      const sdkErrors = chunk.errors?.length ? chunk.errors.map(redactForReceipt) : [];
      const errors = [...outputErrors, ...sdkErrors];

      terminal = {
        reason,
        ...(chunk.model !== undefined ? { resolvedModel: chunk.model } : {}),
        ...(chunk.sessionId !== undefined ? { sessionId: chunk.sessionId } : {}),
        ...(toCanaryUsage(chunk) ? { usage: toCanaryUsage(chunk) } : {}),
        ...(chunk.modelUsage ? { modelUsage: chunk.modelUsage } : {}),
        ...(chunk.numTurns !== undefined ? { actualTurns: chunk.numTurns } : {}),
        ...(chunk.cost !== undefined ? { totalCostUsd: chunk.cost } : {}),
        ...(governed?.ok ? { output: governed.output } : {}),
        // The SDK's own subtype is reported verbatim even when Archon
        // downgrades the outcome: the caller needs to see that the SDK said
        // `success` AND that Archon refused it, not just the refusal.
        ...(chunk.errorSubtype !== undefined ? { sdkSubtype: chunk.errorSubtype } : {}),
        ...(chunk.isError ? {} : { sdkSubtype: 'success' }),
        ...(chunk.stopReason !== undefined ? { stopReason: chunk.stopReason } : {}),
        ...(errors.length ? { errors } : {}),
      };
    }

    if (!terminal) {
      // The stream ended with no terminal result. Its spend is unrecoverable —
      // the SDK reports nothing for a run it never finished — so this must be
      // recorded as such and settled at the FULL reservation, never as $0.
      terminal = {
        reason: deadlineFired ? 'deadline_exceeded' : 'no_terminal_aggregate',
        errors: [
          deadlineFired
            ? 'Deadline reached before the SDK produced a terminal result; spend for this dispatch is unrecoverable — charge the full reservation.'
            : 'Stream ended with no terminal result; spend for this dispatch is unrecoverable — charge the full reservation.',
        ],
      };
    }
  } catch (err) {
    const e = err as Error;
    const isDeadline = deadlineFired;
    getLog().error(
      { err: e, key, deadline: isDeadline },
      isDeadline ? 'canary.run_deadline_exceeded' : 'canary.run_failed'
    );
    // A throw means no terminal aggregate reached us. Same rule as above: the
    // spend is unknown and therefore charged in full.
    terminal = {
      reason: isDeadline ? 'deadline_exceeded' : 'no_terminal_aggregate',
      errors: [
        redactForReceipt(
          `${isDeadline ? 'Deadline reached' : 'Dispatch failed'} with no terminal aggregate: ` +
            `${e.message}. Spend for this dispatch is unrecoverable — charge the full reservation.`
        ),
      ],
    };
  } finally {
    clearTimeout(deadlineTimer);
  }

  await settleCanaryReceipt(key, terminal, now());
}

/**
 * Admit, record, and start one bounded dispatch.
 *
 * Returns as soon as the `pending` receipt exists — the model work continues in
 * the background. That acknowledgement is explicitly NOT a settlement: it
 * carries `state: 'pending'` and no aggregate, and a caller must poll the read
 * endpoint for the terminal receipt.
 */
export async function submitCanaryRun(
  request: CanaryRequest,
  principal: string,
  deps: CanaryRunnerDeps = {}
): Promise<CanarySubmitResult> {
  const now = (deps.now ?? ((): Date => new Date()))();
  // The digest covers the AUTHENTICATED principal, so two principals sending
  // byte-identical bodies produce different digests — and the key carries the
  // principal explicitly as well, so neither defence stands alone.
  const digest = contractDigest(request, principal);
  const key: CanaryReceiptKey = {
    principal,
    externalRunId: request.external_run_id,
    externalTaskId: request.external_task_id,
    contractDigest: digest,
  };

  // A DIFFERENT contract for a task that already has one is refused. Allowing
  // it would give one task id two receipts and two charges, and a caller
  // settling on either would settle on half the spend.
  const existingDigests = await listCanaryDigestsForTask(
    request.external_run_id,
    request.external_task_id,
    principal
  );
  const conflicting = existingDigests.filter(d => d !== digest);
  if (conflicting.length > 0) {
    throw new CanaryRefusedError(
      'contract_conflict',
      `Task ${request.external_run_id}/${request.external_task_id} already has a receipt under a ` +
        `different contract digest (${conflicting.join(', ')}). Submit under a new task id, or ` +
        're-submit the identical contract to read the existing receipt.'
    );
  }

  const { prompt, reservation } = admitCanaryRequest(request, now);

  const { created, receipt } = await createPendingCanaryReceipt({
    key,
    requestedModel: request.model,
    declaredMaxTurns: request.max_turns,
    reservation,
  });

  if (!created) {
    // Idempotent re-submit: the contract is byte-identical, so the caller is
    // asking about a run that already exists. Do NOT start a second one.
    getLog().info({ key, principal }, 'canary.submit_deduplicated');
    return { started: false, receipt };
  }

  getLog().info(
    {
      key,
      principal,
      model: request.model,
      maxTurns: request.max_turns,
      maxBudgetUsd: request.max_budget_usd,
      worstCaseUsd: reservation.worst_case_usd,
      declaredBoundWorstCaseUsd: reservation.declared_bound_worst_case_usd,
      measuredPromptTokens: reservation.measured_prompt_tokens,
    },
    'canary.submit_accepted'
  );

  // Fire-and-forget by design: the model work outlives the HTTP response. The
  // catch is a last-resort net — `executeCanaryRun` already settles on every
  // internal path, so reaching here means the settle write itself failed, and
  // the receipt stays `pending` (visibly unsettled) rather than silently wrong.
  void executeCanaryRun(request, key, prompt, deps).catch((err: unknown) => {
    getLog().error({ err: err as Error, key }, 'canary.settle_failed_receipt_left_pending');
  });

  return { started: true, receipt };
}

/** Re-exported so callers do not need to reach into the providers package. */
export { BoundedModeViolationError, CANARY_CONTRACT_VERSION };
