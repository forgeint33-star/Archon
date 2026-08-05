/**
 * Enablement and request identity for bounded canary mode.
 *
 * The properties under test are security properties, so each is asserted
 * directly rather than inferred: default-off, closed-on-misconfiguration, and
 * no principal resolving from a token that was not configured.
 */
import { describe, test, expect } from 'bun:test';
import { isCanaryModeEnabled, loadCanaryPrincipals, resolveCanaryPrincipal } from './config';

const TOKEN_A = 'a'.repeat(40);
const TOKEN_B = 'b'.repeat(40);
const PRINCIPALS = `goviral:${TOKEN_A},other:${TOKEN_B}`;

function env(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    ARCHON_CANARY_MODE_ENABLED: 'true',
    ARCHON_CANARY_PRINCIPALS: PRINCIPALS,
    ...overrides,
  } as NodeJS.ProcessEnv;
}

describe('isCanaryModeEnabled — disabled by default', () => {
  test('an install with no canary configuration at all is disabled', () => {
    expect(isCanaryModeEnabled({} as NodeJS.ProcessEnv)).toBe(false);
  });

  test('the flag alone is not enough — no principals means a closed door', () => {
    expect(isCanaryModeEnabled(env({ ARCHON_CANARY_PRINCIPALS: undefined }))).toBe(false);
  });

  test('principals alone are not enough — the flag must be explicit', () => {
    expect(isCanaryModeEnabled(env({ ARCHON_CANARY_MODE_ENABLED: undefined }))).toBe(false);
  });

  test.each(['1', 'yes', 'TRUE', 'on', ''])('the flag value %p does not enable it', value => {
    // Only the exact string 'true'. Anything else is a typo, and a typo must
    // not open a spend-bearing endpoint.
    expect(isCanaryModeEnabled(env({ ARCHON_CANARY_MODE_ENABLED: value }))).toBe(false);
  });

  test('both switches set correctly enables it', () => {
    expect(isCanaryModeEnabled(env())).toBe(true);
  });

  test('principals that are all unusable leave it disabled', () => {
    // Every entry is too short, so nothing loads and the mode stays closed
    // rather than opening with a guessable token.
    expect(isCanaryModeEnabled(env({ ARCHON_CANARY_PRINCIPALS: 'a:short,b:alsoshort' }))).toBe(
      false
    );
  });
});

describe('loadCanaryPrincipals', () => {
  test('parses well-formed entries', () => {
    const principals = loadCanaryPrincipals(PRINCIPALS);
    expect([...principals.keys()].sort()).toEqual(['goviral', 'other']);
  });

  test('drops a token shorter than the minimum rather than accepting it', () => {
    const principals = loadCanaryPrincipals(`weak:short,strong:${TOKEN_A}`);
    expect([...principals.keys()]).toEqual(['strong']);
  });

  test.each([
    ['no separator', 'justaname'],
    ['empty name', `:${TOKEN_A}`],
    ['empty token', 'name:'],
  ])('drops a malformed entry (%s)', (_label, entry) => {
    expect(loadCanaryPrincipals(entry).size).toBe(0);
  });

  test('a duplicate principal name keeps the first and ignores the rest', () => {
    const principals = loadCanaryPrincipals(`dup:${TOKEN_A},dup:${TOKEN_B}`);
    expect(principals.size).toBe(1);
    expect(principals.get('dup')).toBe(TOKEN_A);
  });

  test('an unset variable yields no principals', () => {
    expect(loadCanaryPrincipals(undefined).size).toBe(0);
  });
});

describe('resolveCanaryPrincipal', () => {
  test('resolves a configured bearer token to its principal', () => {
    expect(resolveCanaryPrincipal(`Bearer ${TOKEN_A}`, env())).toBe('goviral');
    expect(resolveCanaryPrincipal(`Bearer ${TOKEN_B}`, env())).toBe('other');
  });

  test('the scheme is case-insensitive but the token is not', () => {
    expect(resolveCanaryPrincipal(`bearer ${TOKEN_A}`, env())).toBe('goviral');
    expect(resolveCanaryPrincipal(`Bearer ${TOKEN_A.toUpperCase()}`, env())).toBeUndefined();
  });

  test.each([
    ['missing header', undefined],
    ['wrong scheme', `Basic ${TOKEN_A}`],
    ['no scheme', TOKEN_A],
    ['empty token', 'Bearer '],
    ['unknown token', `Bearer ${'z'.repeat(40)}`],
    ['a prefix of a real token', `Bearer ${TOKEN_A.slice(0, 20)}`],
    ['a real token with a suffix', `Bearer ${TOKEN_A}extra`],
  ])('does not resolve a principal for %s', (_label, header) => {
    expect(resolveCanaryPrincipal(header, env())).toBeUndefined();
  });

  test('resolves nothing when no principals are configured', () => {
    expect(
      resolveCanaryPrincipal(`Bearer ${TOKEN_A}`, env({ ARCHON_CANARY_PRINCIPALS: undefined }))
    ).toBeUndefined();
  });

  test('a principal whose token was dropped for being weak cannot authenticate', () => {
    expect(
      resolveCanaryPrincipal('Bearer short', env({ ARCHON_CANARY_PRINCIPALS: 'weak:short' }))
    ).toBeUndefined();
  });
});
