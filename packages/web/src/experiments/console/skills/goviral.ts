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

export async function fetchGoviralOverview(): Promise<GoviralOverview> {
  return requestJson<GoviralOverview>('/api/goviral/overview');
}
