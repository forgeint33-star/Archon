/**
 * Command Center availability.
 *
 * One configurable base URL, one probe, one honest state. Navigation links are
 * feature-flagged OFF until the probe succeeds, so an unreachable Command
 * Center can never present a broken link — and a failed probe never degrades
 * into a fabricated zero.
 */

/**
 * Single configurable base URL. `127.0.0.1:8181` is the only value the Command
 * Center repo defines (apps/command-center/web/vite.config.ts:9); it has no
 * .env.example, docker-compose or systemd unit, so the deployed value must be
 * confirmed before activation.
 */
export const COMMAND_CENTER_BASE_URL: string =
  (import.meta.env.VITE_COMMAND_CENTER_URL as string | undefined) ?? 'http://127.0.0.1:8181';

/**
 * Implemented at apps/command-center/api/goviral_cc/app.py:45,278.
 * Note `/api/v1/health/runtime` is specified at PRD:655 but NOT implemented,
 * so it is deliberately not probed.
 */
export const HEALTH_PATH = '/api/v1/health';

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

/**
 * Builds the absolute destination URL for an approved route. Kept pure and
 * separate from rendering so the contract test can assert URL shape without a
 * DOM, and so a trailing slash on the base can never produce `//clients`.
 */
export function destinationUrl(route: string, baseUrl: string = COMMAND_CENTER_BASE_URL): string {
  const base = baseUrl.replace(/\/+$/, '');
  return route === '/' ? `${base}/` : `${base}${route}`;
}

/**
 * Classifies a probe outcome. Split from the fetch so every branch is testable
 * without network access.
 */
export function classifyProbe(
  outcome: { ok: true; status: number } | { ok: false; error: string },
  checkedAt: string
): Availability {
  if (!outcome.ok) {
    return { kind: 'unavailable', reason: outcome.error, checkedAt };
  }

  if (outcome.status < 200 || outcome.status >= 300) {
    return {
      kind: 'unavailable',
      reason: `Health check returned HTTP ${String(outcome.status)}`,
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
    const res = await fetch(healthUrl(baseUrl), {
      signal: controller.signal,
      // The Command Center is a different origin; this probe reads liveness
      // only and must never carry Archon credentials to it.
      credentials: 'omit',
    });
    return classifyProbe({ ok: true, status: res.status }, checkedAt);
  } catch (e) {
    const err = e as Error;
    return classifyProbe({ ok: false, error: describeFetchFailure(err, timeoutMs) }, checkedAt);
  } finally {
    clearTimeout(timer);
  }
}
