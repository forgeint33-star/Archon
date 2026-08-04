/**
 * Enablement and request identity for bounded canary mode.
 *
 * DISABLED BY DEFAULT. Both an explicit enable flag AND at least one configured
 * principal are required; either one missing means the endpoints refuse
 * everything. Two independent switches rather than one because an operator who
 * sets the flag while forgetting the tokens must get a closed door, not an open
 * one.
 *
 * IDENTITY. Canary mode does not use Better Auth or the `X-Archon-User` header:
 * its caller is a machine on loopback, and the web identity seam resolves to
 * user rows that mean nothing here. Instead each client presents a bearer token
 * that maps to a named principal, and every receipt records the principal that
 * created it. Reads are filtered on it, so one task cannot read another
 * principal's receipt.
 */
import { timingSafeEqual } from 'node:crypto';
import { createLogger } from '@archon/paths';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('canary.config');
  return cachedLog;
}

/** Minimum token length. Short tokens are rejected at load, not at use. */
const MIN_TOKEN_LENGTH = 32;

/**
 * Parse `ARCHON_CANARY_PRINCIPALS`, formatted `principal:token,principal:token`.
 *
 * Malformed or too-short entries are DROPPED with a warning rather than
 * accepted: a principal whose token is guessable is worse than a principal that
 * does not exist, because it looks configured.
 *
 * The token itself is never logged, only the principal name and the reason.
 */
export function loadCanaryPrincipals(
  raw: string | undefined = process.env.ARCHON_CANARY_PRINCIPALS
): ReadonlyMap<string, string> {
  const principals = new Map<string, string>();
  if (!raw) return principals;

  for (const entry of raw.split(',')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const sep = trimmed.indexOf(':');
    if (sep <= 0 || sep === trimmed.length - 1) {
      getLog().warn(
        { entry: trimmed.slice(0, sep > 0 ? sep : 8) },
        'canary.principal_entry_malformed'
      );
      continue;
    }
    const name = trimmed.slice(0, sep).trim();
    const token = trimmed.slice(sep + 1).trim();
    if (!name || token.length < MIN_TOKEN_LENGTH) {
      getLog().warn(
        { principal: name, minLength: MIN_TOKEN_LENGTH },
        'canary.principal_token_too_short'
      );
      continue;
    }
    if (principals.has(name)) {
      getLog().warn({ principal: name }, 'canary.principal_duplicate_ignored');
      continue;
    }
    principals.set(name, token);
  }
  return principals;
}

/**
 * Whether bounded canary mode is available on this install.
 *
 * Requires the explicit opt-in flag AND at least one usable principal.
 */
export function isCanaryModeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.ARCHON_CANARY_MODE_ENABLED !== 'true') return false;
  const principals = loadCanaryPrincipals(env.ARCHON_CANARY_PRINCIPALS);
  if (principals.size === 0) {
    getLog().warn({}, 'canary.enabled_but_no_principals_configured');
    return false;
  }
  return true;
}

/** Constant-time comparison that does not leak length through early return. */
function tokensMatch(presented: string, expected: string): boolean {
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  // timingSafeEqual throws on length mismatch, which would itself be a timing
  // signal. Hash-free fix: compare against a same-length buffer and AND in the
  // length check, so every call does the same work.
  const maxLen = Math.max(a.length, b.length);
  const padA = Buffer.alloc(maxLen);
  const padB = Buffer.alloc(maxLen);
  a.copy(padA);
  b.copy(padB);
  return timingSafeEqual(padA, padB) && a.length === b.length;
}

/**
 * Resolve a bearer token to its principal, or undefined.
 *
 * Every configured principal is checked even after a match, so the number of
 * comparisons does not depend on which principal presented the token.
 */
export function resolveCanaryPrincipal(
  authorizationHeader: string | undefined,
  env: NodeJS.ProcessEnv = process.env
): string | undefined {
  if (!authorizationHeader) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(authorizationHeader.trim());
  if (!match) return undefined;
  const presented = match[1].trim();
  if (!presented) return undefined;

  const principals = loadCanaryPrincipals(env.ARCHON_CANARY_PRINCIPALS);
  let resolved: string | undefined;
  for (const [name, token] of principals) {
    if (tokensMatch(presented, token)) resolved = resolved ?? name;
  }
  return resolved;
}
