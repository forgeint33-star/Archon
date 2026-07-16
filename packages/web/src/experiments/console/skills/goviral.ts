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

export interface GoviralOverview {
  generated_at: string;
  brain_root: string;
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

export async function fetchGoviralOverview(): Promise<GoviralOverview> {
  return requestJson<GoviralOverview>('/api/goviral/overview');
}

export async function fetchGoviralAgents(): Promise<GoviralAgentsResponse> {
  return requestJson<GoviralAgentsResponse>('/api/goviral/agents');
}
