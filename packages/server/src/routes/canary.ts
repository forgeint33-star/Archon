/**
 * HTTP surface for the bounded canary execution contract.
 *
 * TWO ROUTES, ONE ASYMMETRY. `POST /api/canary/runs` admits and starts a
 * dispatch and returns a PENDING receipt; `GET /api/canary/receipts/...`
 * returns whatever state the receipt is in. A caller settles only on a
 * `terminal` receipt — the submit acknowledgement returns before any model work
 * happens and can never be a settlement.
 *
 * DISABLED BY DEFAULT. Every route 404s unless `ARCHON_CANARY_MODE_ENABLED` is
 * `true` AND `ARCHON_CANARY_PRINCIPALS` configures at least one usable token.
 * A 404 rather than a 403 so a disabled install does not advertise the feature.
 *
 * IDENTITY. Bearer token → named principal, compared in constant time. Every
 * receipt records its creating principal and every read filters on it, so one
 * task cannot read another principal's receipt. This is intentionally NOT the
 * web-auth seam: the caller is a machine, not a user row.
 */
import { createRoute } from '@hono/zod-openapi';
import type { OpenAPIHono } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { createLogger } from '@archon/paths';
import {
  CanaryRefusedError,
  canaryRequestSchema,
  contractDigest,
  getCanaryReceiptForPrincipal,
  isCanaryModeEnabled,
  resolveCanaryPrincipal,
  submitCanaryRun,
} from '@archon/core';
import type { CanaryRequest } from '@archon/core';
import { errorSchema } from './schemas/common.schemas';
import {
  canaryReceiptParamsSchema,
  canaryReceiptQuerySchema,
  canaryReceiptResponseSchema,
  canaryRefusalSchema,
  canarySubmitBodySchema,
  canarySubmitResponseSchema,
} from './schemas/canary.schemas';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('routes.canary');
  return cachedLog;
}

/**
 * Local mirror of api.ts's wrapper: `app.openapi` types the handler against the
 * route's declared responses, which the shared `Context`-returning handler
 * signature does not satisfy. Same TypedResponse bypass, same reason.
 */
function registerOpenApiRoute(
  app: OpenAPIHono,
  route: ReturnType<typeof createRoute>,
  handler: (c: Context) => Response | Promise<Response>
): void {
  app.openapi(route, handler as never);
}

/**
 * Resolve the caller's principal, or the Response to return verbatim.
 *
 * Mode-disabled is checked FIRST and answered with 404: a disabled install must
 * look like one with no such endpoint, not one guarding a secret.
 */
function requirePrincipal(c: Context): { principal: string } | { error: Response } {
  if (!isCanaryModeEnabled()) {
    return { error: c.json({ error: 'Not found' }, 404) };
  }
  const principal = resolveCanaryPrincipal(c.req.header('authorization'));
  if (!principal) {
    // No WWW-Authenticate challenge: this is a machine contract, and the header
    // would only tell an unauthenticated prober that the endpoint exists.
    return { error: c.json({ error: 'Unauthorized' }, 401) };
  }
  return { principal };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const submitCanaryRoute = createRoute({
  method: 'post',
  path: '/api/canary/runs',
  tags: ['Canary'],
  summary: 'Submit a bounded canary dispatch',
  description:
    'Admits a dispatch under the bounded canary contract and starts it. Returns a PENDING ' +
    'receipt plus the worst-case reservation. This acknowledgement is NOT a settlement — ' +
    'poll GET /api/canary/receipts/... for the terminal aggregate. Idempotent on ' +
    '(external_run_id, external_task_id, contract digest).',
  request: {
    body: { content: { 'application/json': { schema: canarySubmitBodySchema } }, required: true },
  },
  responses: {
    202: {
      content: { 'application/json': { schema: canarySubmitResponseSchema } },
      description: 'Dispatch admitted (or already existed). Receipt is pending.',
    },
    401: { content: { 'application/json': { schema: errorSchema } }, description: 'Unauthorized' },
    404: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Canary mode is disabled on this install',
    },
    409: {
      content: { 'application/json': { schema: canaryRefusalSchema } },
      description: 'The task already has a receipt under a different contract digest',
    },
    422: {
      content: { 'application/json': { schema: canaryRefusalSchema } },
      description: 'Refused before any spend (unknown model, prompt or reservation over cap, …)',
    },
    500: { content: { 'application/json': { schema: errorSchema } }, description: 'Server error' },
  },
});

const getCanaryReceiptRoute = createRoute({
  method: 'get',
  path: '/api/canary/receipts/{externalRunId}/{externalTaskId}',
  tags: ['Canary'],
  summary: 'Read the governed receipt for a bounded dispatch',
  description:
    "Returns the receipt for this caller's (run, task, contract digest). A `terminal` " +
    'receipt carries the per-DISPATCH aggregate — never per model attempt. Receipts ' +
    'belonging to another principal are indistinguishable from receipts that do not exist.',
  request: { params: canaryReceiptParamsSchema, query: canaryReceiptQuerySchema },
  responses: {
    200: {
      content: { 'application/json': { schema: canaryReceiptResponseSchema } },
      description: 'The receipt, pending or terminal',
    },
    401: { content: { 'application/json': { schema: errorSchema } }, description: 'Unauthorized' },
    404: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Canary mode disabled, or no such receipt for this principal',
    },
  },
});

/**
 * Refusal → HTTP status. All of these happen BEFORE anything spawns, so none of
 * them cost money; the status distinguishes "your contract is unacceptable"
 * (422) from "this task already has a different contract" (409).
 */
function refusalStatus(code: CanaryRefusedError['code']): 409 | 422 {
  return code === 'contract_conflict' ? 409 : 422;
}

export function registerCanaryRoutes(app: OpenAPIHono): void {
  registerOpenApiRoute(app, submitCanaryRoute, async c => {
    const auth = requirePrincipal(c);
    if ('error' in auth) return auth.error;
    const { principal } = auth;

    const request = (c.req as unknown as { valid(k: 'json'): CanaryRequest }).valid('json');

    try {
      const result = await submitCanaryRun(request, principal);
      return c.json(
        {
          accepted: true as const,
          started: result.started,
          receipt: result.receipt,
          reservation: result.receipt.reservation,
        },
        202
      );
    } catch (err) {
      if (err instanceof CanaryRefusedError) {
        getLog().warn(
          {
            principal,
            externalRunId: request.external_run_id,
            externalTaskId: request.external_task_id,
            code: err.code,
          },
          'canary.submit_refused'
        );
        return c.json(
          {
            error: err.message,
            code: err.code,
            ...(err.reservation ? { reservation: err.reservation } : {}),
          },
          refusalStatus(err.code)
        );
      }
      // Opaque to the caller: an internal failure message can quote paths,
      // config, or SDK output. The detail goes to the log, not the response.
      getLog().error(
        {
          err: err as Error,
          principal,
          externalRunId: request.external_run_id,
          externalTaskId: request.external_task_id,
        },
        'canary.submit_failed'
      );
      return c.json({ error: 'Failed to submit canary dispatch' }, 500);
    }
  });

  registerOpenApiRoute(app, getCanaryReceiptRoute, async c => {
    const auth = requirePrincipal(c);
    if ('error' in auth) return auth.error;
    const { principal } = auth;

    // Params are non-optional in the route definition, but Hono types them as
    // possibly-undefined; default to '' so a malformed path misses the lookup
    // rather than widening it.
    const externalRunId = c.req.param('externalRunId') ?? '';
    const externalTaskId = c.req.param('externalTaskId') ?? '';
    const digest = c.req.query('contract_digest') ?? '';

    // The principal is part of the LOOKUP KEY, not a post-filter: a receipt
    // belonging to anyone else is never selected in the first place.
    const receipt = await getCanaryReceiptForPrincipal({
      principal,
      externalRunId,
      externalTaskId,
      contractDigest: digest,
    });

    if (!receipt) {
      // Identical response whether the receipt does not exist or belongs to
      // another principal — a caller must not be able to probe for the
      // existence of another task's run.
      getLog().debug(
        { principal, externalRunId, externalTaskId },
        'canary.receipt_not_found_for_principal'
      );
      return c.json({ error: 'Not found' }, 404);
    }

    return c.json({ receipt }, 200);
  });
}

/**
 * Digest helper re-exported so a caller computing a receipt key does not have
 * to reach past this module into @archon/core.
 */
export { contractDigest, canaryRequestSchema };
export type { CanaryRequest };
