/**
 * Contract validation, canonical digest, and the reservation arithmetic.
 *
 * The model-bounds figures are PINNED here on purpose. They were read out of
 * the Claude CLI binary this install spawns, and every reservation is priced
 * from them — so a silent drift after an SDK upgrade must fail CI rather than
 * quietly reprice every canary run.
 */
import { describe, test, expect } from 'bun:test';
import {
  CANARY_CONTRACT_VERSION,
  canaryRequestSchema,
  canonicalJson,
  canonicalRequestIdentity,
  contractDigest,
  terminalStatusForReason,
  type CanaryRequest,
} from './contract';
import { MODEL_BOUNDS, computeWorstCase, estimateTokens, getModelBounds } from './model-bounds';

function validRequest(overrides: Partial<CanaryRequest> = {}): CanaryRequest {
  return canaryRequestSchema.parse({
    contract_version: CANARY_CONTRACT_VERSION,
    external_run_id: 'canary-a',
    external_task_id: 'task-1',
    model: 'claude-sonnet-5',
    max_turns: 3,
    max_budget_usd: 1.0,
    max_prompt_tokens: 32_000,
    max_output_tokens_per_turn: 8_000,
    max_context_tokens: 120_000,
    max_reservation_usd: 5.0,
    deadline_at: '2026-08-04T12:00:00.000Z',
    prompt: 'build the thing',
    system_prompt: 'You are a bounded canary worker.',
    cwd: '/tmp',
    ...overrides,
  });
}

describe('canaryRequestSchema', () => {
  test('accepts a fully-declared contract', () => {
    expect(() => validRequest()).not.toThrow();
  });

  test.each([
    'contract_version',
    'external_run_id',
    'external_task_id',
    'model',
    'max_turns',
    'max_budget_usd',
    'max_prompt_tokens',
    'max_output_tokens_per_turn',
    'max_context_tokens',
    'max_reservation_usd',
    'deadline_at',
    'prompt',
    'system_prompt',
    'cwd',
  ])('rejects a contract missing %s — a partial bound is not a bound', field => {
    const body = validRequest() as unknown as Record<string, unknown>;
    delete body[field];
    expect(canaryRequestSchema.safeParse(body).success).toBe(false);
  });

  test('rejects an unknown field rather than ignoring it', () => {
    const body = { ...validRequest(), max_subagents: 4 };
    // `.strict()`: a caller who thinks they declared a bound Archon does not
    // implement must be told, not silently disregarded.
    expect(canaryRequestSchema.safeParse(body).success).toBe(false);
  });

  test.each(['archon.canary.v1', 'archon.canary.v3', 'v2', ''])(
    'rejects contract version %p — only the current literal is accepted',
    version => {
      expect(
        canaryRequestSchema.safeParse({ ...validRequest(), contract_version: version }).success
      ).toBe(false);
    }
  );

  test('rejects a caller-supplied principal — authority is never payload', () => {
    // The principal is resolved from the bearer token. A body that carries one
    // must be REFUSED rather than have it silently ignored, or a caller could
    // believe they scoped a request they did not.
    expect(
      canaryRequestSchema.safeParse({ ...validRequest(), principal: 'someone-else' }).success
    ).toBe(false);
  });

  test.each([
    ['max_turns', 0],
    ['max_budget_usd', 0],
    ['max_prompt_tokens', 0],
    ['max_reservation_usd', -1],
  ])('rejects a non-positive %s', (field, value) => {
    expect(canaryRequestSchema.safeParse({ ...validRequest(), [field]: value }).success).toBe(
      false
    );
  });

  test('rejects external ids containing path separators', () => {
    expect(
      canaryRequestSchema.safeParse({ ...validRequest(), external_task_id: '../other' }).success
    ).toBe(false);
  });
});

const PRINCIPAL = 'goviral';

describe('canonicalJson and contractDigest', () => {
  test('key order does not change the digest', () => {
    const a = validRequest();
    // Same contract, different serialization order. A digest that changed here
    // would start a second billed run for a re-submit of the same work.
    const reordered = Object.fromEntries(
      Object.entries(a as unknown as Record<string, unknown>).reverse()
    ) as unknown as CanaryRequest;

    expect(canonicalJson(a)).toBe(canonicalJson(reordered));
    expect(contractDigest(a, PRINCIPAL)).toBe(contractDigest(reordered, PRINCIPAL));
  });

  test('any meaningful change produces a different digest', () => {
    const base = contractDigest(validRequest(), PRINCIPAL);
    expect(contractDigest(validRequest({ max_turns: 4 }), PRINCIPAL)).not.toBe(base);
    expect(contractDigest(validRequest({ prompt: 'build a different thing' }), PRINCIPAL)).not.toBe(
      base
    );
    expect(contractDigest(validRequest({ model: 'claude-haiku-4-5' }), PRINCIPAL)).not.toBe(base);
    expect(contractDigest(validRequest({ system_prompt: 'other' }), PRINCIPAL)).not.toBe(base);
  });

  test('a DIFFERENT principal digests the SAME body differently', () => {
    // This is the v1 collision, closed at the digest layer. Two principals
    // sending byte-identical bodies must not address one identity.
    const body = validRequest();
    expect(contractDigest(body, 'alpha')).not.toBe(contractDigest(body, 'beta'));
  });

  test('the principal is part of the canonical identity, not appended to it', () => {
    const body = validRequest();
    expect(canonicalRequestIdentity(body, PRINCIPAL)).toEqual({
      authenticated_principal: PRINCIPAL,
      request: body,
    });
  });

  test('an empty principal is refused rather than digested', () => {
    // Digesting '' would give every unauthenticated submission one identity.
    expect(() => contractDigest(validRequest(), '')).toThrow(/authenticated principal/);
  });

  test('the digest is a stable 64-char hex sha256', () => {
    const d = contractDigest(validRequest(), PRINCIPAL);
    expect(d).toMatch(/^[0-9a-f]{64}$/);
    expect(contractDigest(validRequest(), PRINCIPAL)).toBe(d);
  });

  test('canonicalJson sorts nested keys and drops undefined', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 }, e: undefined })).toBe(
      '{"a":{"c":3,"d":2},"b":1}'
    );
  });
});

describe('model bounds — pinned to the installed CLI binary', () => {
  test('claude-sonnet-5 matches the binary catalog', () => {
    // binary: pricing tier_3_15 {input:3, output:15} per million;
    //         context.window 1e6; max_output_tokens {default:64000, upper:128000}
    expect(MODEL_BOUNDS['claude-sonnet-5']).toEqual({
      inputUsdPer1k: 0.003,
      outputUsdPer1k: 0.015,
      authoritativeMaxOutputTokens: 128_000,
      defaultMaxOutputTokens: 64_000,
      authoritativeContextWindow: 1_000_000,
    });
  });

  test('claude-haiku-4-5 matches the binary catalog', () => {
    // binary: pricing haiku_45 {input:1, output:5} per million;
    //         context.window 200000; max_output_tokens {default:32000, upper:64000}
    expect(MODEL_BOUNDS['claude-haiku-4-5']).toEqual({
      inputUsdPer1k: 0.001,
      outputUsdPer1k: 0.005,
      authoritativeMaxOutputTokens: 64_000,
      defaultMaxOutputTokens: 32_000,
      authoritativeContextWindow: 200_000,
    });
  });

  test('short aliases are not priceable — they can silently repoint after an upgrade', () => {
    expect(getModelBounds('sonnet')).toBeUndefined();
    expect(getModelBounds('haiku')).toBeUndefined();
    expect(getModelBounds('claude-does-not-exist')).toBeUndefined();
  });
});

describe('estimateTokens', () => {
  test('errs high relative to the ~4 bytes/token rule of thumb', () => {
    const text = 'a'.repeat(3500);
    // 3500 bytes / 3.5 = 1000, versus ~875 at 4 bytes/token. Over-counting is
    // the safe direction for both the prompt cap and the reservation.
    expect(estimateTokens(text)).toBe(1000);
    expect(estimateTokens(text)).toBeGreaterThan(3500 / 4);
  });

  test('counts UTF-8 bytes, not code units', () => {
    expect(estimateTokens('é')).toBe(Math.ceil(2 / 3.5));
  });
});

describe('computeWorstCase', () => {
  const bounds = MODEL_BOUNDS['claude-sonnet-5'];

  test('sums the growing transcript across turns at authoritative maxima', () => {
    const result = computeWorstCase({
      bounds,
      promptTokens: 32_000,
      maxTurns: 3,
      maxBudgetUsd: 1000, // deliberately huge so the turn ceiling is the binding one
      declaredMaxOutputTokens: 8_000,
      declaredMaxContextTokens: 120_000,
    });

    // in : 32k + 160k + 288k = 480k  ->  480 * 0.003 = $1.44
    // out: 3 * 128k = 384k           ->  384 * 0.015 = $5.76
    expect(result.fullTurnsUsd).toBeCloseTo(7.2, 6);
    expect(result.worstCaseUsd).toBeCloseTo(7.2, 6);
  });

  test('the budget ceiling includes one worst-case turn of stop-after overshoot', () => {
    const result = computeWorstCase({
      bounds,
      promptTokens: 32_000,
      maxTurns: 3,
      maxBudgetUsd: 1.0,
      declaredMaxOutputTokens: 8_000,
      declaredMaxContextTokens: 120_000,
    });

    // Worst turn is the last: in 288k -> $0.864, out 128k -> $1.92, total $2.784.
    // maxBudgetUsd stops the run AFTER the call that crosses it, so the
    // guaranteed ceiling is 1.00 + 2.784 = $3.784, which is stricter than $7.20.
    expect(result.budgetPlusOvershootUsd).toBeCloseTo(3.784, 6);
    expect(result.worstCaseUsd).toBeCloseTo(3.784, 6);
  });

  test('the reservation never relies on the declared caps', () => {
    const withCaps = computeWorstCase({
      bounds,
      promptTokens: 32_000,
      maxTurns: 3,
      maxBudgetUsd: 1000,
      declaredMaxOutputTokens: 8_000,
      declaredMaxContextTokens: 120_000,
    });
    const withoutCaps = computeWorstCase({
      bounds,
      promptTokens: 32_000,
      maxTurns: 3,
      maxBudgetUsd: 1000,
      declaredMaxOutputTokens: bounds.authoritativeMaxOutputTokens,
      declaredMaxContextTokens: bounds.authoritativeContextWindow,
    });

    // Tightening the declared caps must NOT move the guaranteed figure — that
    // is the whole point of pricing from authoritative maxima.
    expect(withCaps.worstCaseUsd).toBe(withoutCaps.worstCaseUsd);
    // It does move the advisory figure, and by a lot.
    expect(withCaps.declaredBoundWorstCaseUsd).toBeLessThan(withCaps.worstCaseUsd);
  });

  test('the advisory figure reproduces the tight per-task bound', () => {
    const result = computeWorstCase({
      bounds,
      promptTokens: 32_000,
      maxTurns: 3,
      maxBudgetUsd: 1000,
      declaredMaxOutputTokens: 8_000,
      declaredMaxContextTokens: 120_000,
    });

    // in : 32k + 40k + 48k = 120k -> $0.36 ; out: 24k -> $0.36 ; total $0.72
    expect(result.declaredBoundWorstCaseUsd).toBeCloseTo(0.72, 6);
  });

  test('input growth is clamped at the context window', () => {
    const haiku = MODEL_BOUNDS['claude-haiku-4-5'];
    const result = computeWorstCase({
      bounds: haiku,
      promptTokens: 190_000,
      maxTurns: 4,
      maxBudgetUsd: 1000,
      declaredMaxOutputTokens: haiku.authoritativeMaxOutputTokens,
      declaredMaxContextTokens: haiku.authoritativeContextWindow,
    });

    // in : 190k, then min(254k,200k)=200k, 200k, 200k = 790k -> $0.79
    // out: 4 * 64k = 256k -> $1.28
    expect(result.fullTurnsUsd).toBeCloseTo(2.07, 6);
  });

  test('a declared cap above the model maximum cannot widen the advisory figure', () => {
    const clamped = computeWorstCase({
      bounds,
      promptTokens: 1000,
      maxTurns: 2,
      maxBudgetUsd: 1000,
      declaredMaxOutputTokens: 10_000_000,
      declaredMaxContextTokens: 10_000_000,
    });
    expect(clamped.declaredBoundWorstCaseUsd).toBe(clamped.fullTurnsUsd);
  });

  test('one turn costs exactly one prompt plus one max output', () => {
    const result = computeWorstCase({
      bounds,
      promptTokens: 10_000,
      maxTurns: 1,
      maxBudgetUsd: 1000,
      declaredMaxOutputTokens: 128_000,
      declaredMaxContextTokens: 1_000_000,
    });
    // 10 * 0.003 + 128 * 0.015 = 0.03 + 1.92
    expect(result.fullTurnsUsd).toBeCloseTo(1.95, 6);
  });
});

describe('terminal vocabulary', () => {
  test('the current wire version is v2', () => {
    expect(CANARY_CONTRACT_VERSION).toBe('archon.canary.v2');
  });

  test('succeeded means exactly "completed"; every ceiling hit is failed', () => {
    expect(terminalStatusForReason('completed')).toBe('succeeded');
    for (const reason of [
      'max_turns_exhausted',
      'max_budget_exhausted',
      'sdk_error',
      'no_terminal_aggregate',
      'deadline_exceeded',
      'refused',
    ] as const) {
      expect(terminalStatusForReason(reason)).toBe('failed');
    }
  });
});
