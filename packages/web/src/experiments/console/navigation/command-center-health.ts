/**
 * Command Center availability.
 *
 * One configurable base URL, one probe, one honest state. Navigation links are
 * feature-flagged OFF until the probe succeeds, so an unreachable Command
 * Center can never present a broken link — and a failed probe never degrades
 * into a fabricated zero.
 */

/**
 * Single configurable base URL, non-secret. The default is the value published
 * in the verified release handoff (2026-07-20): the Command Center is served by
 * `goviral-command-center.service` on this address, and it allow-lists exactly
 * the Archon origin `http://127.0.0.1:8180` for CORS. No credential or secret
 * is read here or sent with the probe.
 */
export const COMMAND_CENTER_BASE_URL: string =
  (import.meta.env.VITE_COMMAND_CENTER_URL as string | undefined) ?? 'http://127.0.0.1:8280';

/** Canonical health endpoint from the handoff. */
export const HEALTH_PATH = '/api/v1/health';

/**
 * Readiness endpoint. `/health` reports the process is up; `/ready` reports it
 * can actually serve (schema version, problems). Links are gated on readiness,
 * not mere liveness, so a booting Command Center is never linked to.
 */
export const READY_PATH = '/api/v1/ready';

export type Availability =
  | { kind: 'probing' }
  | { kind: 'available'; checkedAt: string }
  /** `reason` is the real failure, never a generic placeholder. */
  | { kind: 'unavailable'; reason: string; checkedAt: string };

export const PROBING: Availability = { kind: 'probing' };

/** Links may only be rendered as links in this state. */
export function linksEnabled(availability: Availability): boolean {
  return availability.kind === 'available';
}

export function healthUrl(baseUrl: string = COMMAND_CENTER_BASE_URL): string {
  return `${baseUrl.replace(/\/+$/, '')}${HEALTH_PATH}`;
}

export function readyUrl(baseUrl: string = COMMAND_CENTER_BASE_URL): string {
  return `${baseUrl.replace(/\/+$/, '')}${READY_PATH}`;
}

/**
 * Builds the absolute destination URL for a published route, optionally
 * narrowed by a validated query filter. Kept pure and separate from rendering
 * so the contract test can assert URL shape without a DOM, and so a trailing
 * slash on the base can never produce `//clients`.
 */
export function destinationUrl(
  route: string,
  baseUrl: string = COMMAND_CENTER_BASE_URL,
  query?: { name: string; value: string }
): string {
  const base = baseUrl.replace(/\/+$/, '');
  const path = route === '/' ? `${base}/` : `${base}${route}`;
  if (!query) return path;
  return `${path}?${encodeURIComponent(query.name)}=${encodeURIComponent(query.value)}`;
}

/**
 * Classifies a probe outcome. Split from the fetch so every branch is testable
 * without network access.
 *
 * A 2xx alone is NOT sufficient: the Command Center reports liveness and
 * readiness separately, and linking to a process that is up but cannot serve
 * would be exactly the kind of optimistic claim this bridge exists to avoid.
 * `ready` must be explicitly true.
 */
export function classifyProbe(
  outcome: { ok: true; status: number; ready?: unknown } | { ok: false; error: string },
  checkedAt: string
): Availability {
  if (!outcome.ok) {
    return { kind: 'unavailable', reason: outcome.error, checkedAt };
  }

  if (outcome.status < 200 || outcome.status >= 300) {
    return {
      kind: 'unavailable',
      reason: `Readiness check returned HTTP ${String(outcome.status)}`,
      checkedAt,
    };
  }

  if (outcome.ready !== true) {
    return {
      kind: 'unavailable',
      reason:
        outcome.ready === undefined
          ? 'Readiness check returned no `ready` field'
          : `Command Center reports ready=${JSON.stringify(outcome.ready)}`,
      checkedAt,
    };
  }

  return { kind: 'available', checkedAt };
}

/**
 * Turns a fetch rejection into something an operator can act on.
 *
 * The probe is CROSS-ORIGIN: Archon and the Command Center are different
 * origins, so the browser blocks the response unless the Command Center sends
 * `Access-Control-Allow-Origin` for Archon's origin. When it does not, fetch
 * rejects with a bare `TypeError: Failed to fetch` that is indistinguishable
 * from the server being down — so the message names both possibilities rather
 * than guessing. Serving CORS headers for the Archon origin is a prerequisite
 * for activating the bridge.
 */
export function describeFetchFailure(err: Error, timeoutMs: number): string {
  if (err.name === 'AbortError') {
    return `Health check timed out after ${String(timeoutMs)}ms`;
  }

  if (err.name === 'TypeError' || err.message === 'Failed to fetch' || err.message === '') {
    return 'Health check could not reach the Command Center — it is down, or it is not sending CORS headers for this origin';
  }

  return err.message;
}

/**
 * Probes the Command Center. Never throws and never returns `available` on a
 * failure path — a timeout, DNS failure, refused connection, CORS block or
 * non-2xx all resolve to `unavailable` carrying the real reason.
 */
export async function probeCommandCenter(
  baseUrl: string = COMMAND_CENTER_BASE_URL,
  timeoutMs = 4000
): Promise<Availability> {
  const checkedAt = new Date().toISOString();
  const controller = new AbortController();
  const timer = setTimeout((): void => {
    controller.abort();
  }, timeoutMs);

  try {
    const res = await fetch(readyUrl(baseUrl), {
      signal: controller.signal,
      // The Command Center is a different origin; this probe reads readiness
      // only and must never carry Archon credentials to it.
      credentials: 'omit',
    });

    // A non-2xx body is not worth parsing, and a malformed 2xx body must fail
    // closed rather than be treated as ready.
    let ready: unknown;
    if (res.ok) {
      try {
        const body: unknown = await res.json();
        ready =
          typeof body === 'object' && body !== null
            ? (body as Record<string, unknown>).ready
            : undefined;
      } catch {
        ready = undefined;
      }
    }

    return classifyProbe({ ok: true, status: res.status, ready }, checkedAt);
  } catch (e) {
    const err = e as Error;
    return classifyProbe({ ok: false, error: describeFetchFailure(err, timeoutMs) }, checkedAt);
  } finally {
    clearTimeout(timer);
  }
}
