import { requestJson } from '../lib/http';

export type GoviralScalar = string | number | boolean;

export interface GoviralModule {
  id: string;
  label: string;
  run_id: string | null;
  updated_at: string | null;
  summary: Record<string, GoviralScalar>;
}

export interface GoviralThread {
  id: GoviralScalar | null;
  status: GoviralScalar | null;
  lane: GoviralScalar | null;
  lead_agent: GoviralScalar | null;
  agent_type: GoviralScalar | null;
  created_at: GoviralScalar | null;
}

// ─── Snapshot Freshness (v3.1) ──────────────────────────────────────────────

export type SnapshotFreshness = 'fresh' | 'delayed' | 'stale' | 'unavailable';

export interface SnapshotFreshnessData {
  generated_at: string | null;
  age_seconds: number | null;
  freshness: SnapshotFreshness;
  producer_status: string | null;
  last_success_at: string | null;
  last_error_at: string | null;
  last_error_summary: string | null;
  threshold_seconds: number | null;
}

export interface GoviralOverview {
  generated_at: string;
  brain_root: string;
  brain?: {
    snapshot_freshness?: SnapshotFreshnessData;
  };
  doctor: {
    status: string;
    source: string;
    modified_at: string | null;
  };
  approvals: {
    pending: number;
    approved: number;
    rejected: number;
    executed: number;
    modified_at: string | null;
  };
  modules: GoviralModule[];
  recent_threads: GoviralThread[];
  latest_prd: {
    run_id: string | null;
    title: string | null;
    path: string;
    modified_at: string | null;
  } | null;
}

export interface GoviralRegisteredAgent {
  name: string;
  display_name: string | null;
  lane: string;
  type: string;
  enabled: boolean;
  can_modify_prod: boolean;
  consistency: string;
  has_definition: boolean;
  has_policy: boolean;
}

export interface GoviralAgentDrift {
  agent: string;
  issue: string;
  recommendation: string;
}

export interface GoviralAgentsSummary {
  registered_count: number;
  discovered_definition_count: number;
  enabled_count: number;
  disabled_count: number;
  active_run_count: number;
  runs_today_count: number;
  recent_run_count: number;
  drift_count: number;
}

export interface GoviralAgentsResponse {
  generated_at: string;
  registered_agents: GoviralRegisteredAgent[];
  registry_definition_drift: GoviralAgentDrift[];
  summary: GoviralAgentsSummary;
}

// ─── Agent Reconciliation (v3.1) ────────────────────────────────────────────

export interface ReconciliationDriftItem {
  agent: string;
  classification: string;
  issue: string;
  recommendation: string;
  technical_details?: Record<string, unknown>;
}

export interface ReconciliationProposal {
  agent: string;
  action: string;
  rationale: string;
}

export interface AgentReconciliationResponse {
  generated_at: string;
  drift_items: ReconciliationDriftItem[];
  proposals: ReconciliationProposal[];
  summary: {
    total_drift: number;
    classifications: Record<string, number>;
  };
}

// ─── Module Manifests (v3.1) ────────────────────────────────────────────────

export type ModuleState = 'identified' | 'partially_identified' | 'orphaned' | 'unavailable';

export interface ModuleManifest {
  id: string;
  label: string;
  state: ModuleState;
  owner_agent: string | null;
  run_id: string | null;
  updated_at: string | null;
  summary: Record<string, GoviralScalar>;
}

export interface ModulesResponse {
  generated_at: string;
  modules: ModuleManifest[];
}

// ─── Integrations (v3.1) ───────────────────────────────────────────────────

export interface TelegramIntegration {
  configured: boolean;
  state: string;
  credentials_present: boolean;
  notifier_timer: string | null;
  last_delivery: string | null;
  last_check: string | null;
}

export interface ClickUpIntegration {
  configured: boolean;
  state: string;
  stage: string | null;
  writes_enabled: boolean;
  last_check: string | null;
}

export interface QdrantIntegration {
  configured: boolean;
  state: string;
  reachable: boolean;
  collections_count: number | null;
  last_check: string | null;
}

export interface IntegrationsResponse {
  generated_at: string;
  telegram: TelegramIntegration;
  clickup: ClickUpIntegration;
  qdrant: QdrantIntegration;
}

// ─── Approval Analysis (v3.1) ──────────────────────────────────────────────

export interface ApprovalGroup {
  fingerprint: string;
  count: number;
  representative_title: string;
  item_ids: string[];
}

export interface ApprovalAnalysisItem {
  id: string;
  title: string;
  status: string;
  risk_classification: string | null;
  malformed: boolean;
  malformed_reason: string | null;
  requested_by: string | null;
  created_at: string | null;
}

export interface ApprovalAnalysisResponse {
  generated_at: string;
  counts: {
    pending: number;
    approved: number;
    rejected: number;
    executed: number;
    malformed: number;
  };
  duplicate_groups: ApprovalGroup[];
  items: ApprovalAnalysisItem[];
}

// ─── Semantic Services (v3.1) ──────────────────────────────────────────────

export type SemanticState = 'running' | 'idle' | 'scheduled' | 'failed' | 'unknown';

export interface SemanticService {
  name: string;
  description: string | null;
  semantic_state: SemanticState;
  active_state: string;
  sub_state: string;
  unit_file_state: string | null;
  next_run_at: string | null;
  timer_backed: boolean;
}

export interface SemanticServicesResponse {
  generated_at: string;
  services: SemanticService[];
  aggregates: {
    running: number;
    idle: number;
    scheduled: number;
    failed: number;
    unknown: number;
    total: number;
  };
}

// ─── Canary (v3.1) ─────────────────────────────────────────────────────────

export interface CanaryStatusResponse {
  generated_at: string;
  status: 'idle' | 'running' | 'completed' | 'failed' | 'cancelled';
  task_id: string | null;
  started_at: string | null;
  completed_at: string | null;
  cancelled_at: string | null;
  result_summary: string | null;
}

export interface CanaryActionResponse {
  ok: boolean;
  error?: string;
  task_id?: string;
}

// ─── Access Mode (v3.1) ────────────────────────────────────────────────────

export interface AccessModeResponse {
  generated_at: string;
  access_mode: string;
  access_mode_description: string;
  auth_enabled: boolean;
  public_exposure: boolean;
  rbac_role: string;
}

// ─── Fetch functions ────────────────────────────────────────────────────────

export async function fetchGoviralOverview(): Promise<GoviralOverview> {
  return requestJson<GoviralOverview>('/api/goviral/overview');
}

export async function fetchGoviralAgents(): Promise<GoviralAgentsResponse> {
  return requestJson<GoviralAgentsResponse>('/api/goviral/agents');
}

export async function fetchAgentReconciliation(): Promise<AgentReconciliationResponse> {
  return requestJson<AgentReconciliationResponse>('/api/goviral/agents/reconciliation');
}

export async function fetchModules(): Promise<ModulesResponse> {
  return requestJson<ModulesResponse>('/api/goviral/modules');
}

export async function fetchIntegrations(): Promise<IntegrationsResponse> {
  return requestJson<IntegrationsResponse>('/api/goviral/integrations');
}

export async function fetchApprovalAnalysis(): Promise<ApprovalAnalysisResponse> {
  return requestJson<ApprovalAnalysisResponse>('/api/goviral/approvals/analysis');
}

export async function fetchSemanticServices(): Promise<SemanticServicesResponse> {
  return requestJson<SemanticServicesResponse>('/api/goviral/services/semantic');
}

export async function fetchCanaryStatus(): Promise<CanaryStatusResponse> {
  return requestJson<CanaryStatusResponse>('/api/goviral/canary/status');
}

export async function launchCanary(): Promise<CanaryActionResponse> {
  return requestJson<CanaryActionResponse>('/api/goviral/canary/launch', { method: 'POST' });
}

export async function cancelCanary(): Promise<CanaryActionResponse> {
  return requestJson<CanaryActionResponse>('/api/goviral/canary/cancel', { method: 'POST' });
}

export async function fetchAccessMode(): Promise<AccessModeResponse> {
  return requestJson<AccessModeResponse>('/api/goviral/access');
}

export async function sendTelegramTest(): Promise<CanaryActionResponse> {
  return requestJson<CanaryActionResponse>('/api/goviral/integrations/telegram/test', {
    method: 'POST',
  });
}
