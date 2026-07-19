/**
 * Transport layer for the GoViral Control Plane endpoints.
 *
 * These routes are hand-rolled `c.json()` handlers with no Zod schema, and
 * `requestJson<T>` performs no runtime validation — so a declared response
 * interface here would be an unchecked assertion, not a guarantee. An earlier
 * version of this file did exactly that, describing shapes the backend never
 * emitted, and the mismatch surfaced as an undefined-property crash during
 * render.
 *
 * Read endpoints therefore return `unknown` on purpose. Shape knowledge lives in
 * `goviral-normalize.ts`, which validates structurally and is unit-tested
 * against captured live payloads.
 */

import { requestJson } from '../lib/http';

/** Write actions do return a small, stable, server-controlled envelope. */
export interface GoviralActionResponse {
  ok?: boolean;
  error?: string;
  task_id?: string;
}

export async function fetchGoviralOverview(): Promise<unknown> {
  return requestJson<unknown>('/api/goviral/overview');
}

export async function fetchAgentReconciliation(): Promise<unknown> {
  return requestJson<unknown>('/api/goviral/agents/reconciliation');
}

export async function fetchModules(): Promise<unknown> {
  return requestJson<unknown>('/api/goviral/modules');
}

export async function fetchIntegrations(): Promise<unknown> {
  return requestJson<unknown>('/api/goviral/integrations');
}

export async function fetchApprovalAnalysis(): Promise<unknown> {
  return requestJson<unknown>('/api/goviral/approvals/analysis');
}

export async function fetchSemanticServices(): Promise<unknown> {
  return requestJson<unknown>('/api/goviral/services/semantic');
}

export async function fetchCanaryStatus(): Promise<unknown> {
  return requestJson<unknown>('/api/goviral/canary/status');
}

export async function fetchAccessMode(): Promise<unknown> {
  return requestJson<unknown>('/api/goviral/access');
}

/**
 * The only endpoint carrying an explicit `available` / `error` availability
 * contract. Consumed so the console can report systemd degradation truthfully
 * instead of rendering an empty unit list as if it were a healthy zero.
 */
export async function fetchRuntime(): Promise<unknown> {
  return requestJson<unknown>('/api/goviral/runtime');
}

export async function launchCanary(): Promise<GoviralActionResponse> {
  return requestJson<GoviralActionResponse>('/api/goviral/canary/launch', { method: 'POST' });
}

export async function cancelCanary(): Promise<GoviralActionResponse> {
  return requestJson<GoviralActionResponse>('/api/goviral/canary/cancel', { method: 'POST' });
}

export async function sendTelegramTest(): Promise<GoviralActionResponse> {
  return requestJson<GoviralActionResponse>('/api/goviral/integrations/telegram/test', {
    method: 'POST',
  });
}
