/**
 * Route schemas for the bounded canary execution contract.
 *
 * The request/receipt shapes themselves live in `@archon/core` (canary/contract)
 * so the engine and the HTTP surface cannot drift; this module only wraps them
 * in the response envelopes the endpoints return.
 */
import { z } from '@hono/zod-openapi';
import { canaryReceiptSchema, canaryRequestSchema, canaryReservationSchema } from '@archon/core';

export const canarySubmitBodySchema = canaryRequestSchema.openapi('CanarySubmitRequest');

/**
 * Submit acknowledgement. Deliberately NOT a receipt-shaped success payload:
 * `accepted` says the run was admitted and started, and `receipt.state` is
 * always `pending` here. Settlement must come from the read endpoint.
 */
export const canarySubmitResponseSchema = z
  .object({
    accepted: z.literal(true),
    /**
     * False when this exact contract had already been submitted — the existing
     * run is reused and no second dispatch is started.
     */
    started: z.boolean(),
    /**
     * Always `pending` on this route. A submit acknowledgement is not a
     * terminal receipt; poll the read endpoint for the aggregate.
     */
    receipt: canaryReceiptSchema,
    /** The worst case the caller should hold a reservation against. */
    reservation: canaryReservationSchema,
  })
  .openapi('CanarySubmitResponse');

export const canaryReceiptResponseSchema = z
  .object({ receipt: canaryReceiptSchema })
  .openapi('CanaryReceiptResponse');

export const canaryReceiptParamsSchema = z.object({
  externalRunId: z.string().min(1),
  externalTaskId: z.string().min(1),
});

export const canaryReceiptQuerySchema = z.object({
  /**
   * The digest of the contract that was submitted. Required, because it is part
   * of the receipt key — a read that omitted it would have to guess which
   * contract the caller meant.
   */
  contract_digest: z.string().length(64),
});

/**
 * Refusal body. Carries the machine-readable code plus — when the refusal was
 * computable — the reservation figures that caused it, so a caller can see how
 * far over the line they were instead of re-deriving it.
 */
export const canaryRefusalSchema = z
  .object({
    error: z.string(),
    code: z.string(),
    reservation: canaryReservationSchema.optional(),
  })
  .openapi('CanaryRefusal');
