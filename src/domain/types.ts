// src/domain/types.ts
// Shared type definitions for Memora MCP.

export type Scope = "this_task" | "project" | "global";
export type Source = "episodic" | "semantic" | "facts";

export interface Context {
  tenant_id: string;
  project_id: string;
  context_id?: string;
  task_id?: string;
  env?: string;
  api_version?: string;
}

export interface Event {
  event_id: string;
  ts: string;               // ISO timestamp
  role: "agent" | "user" | "tool" | "eval";
  content: string;
  tags?: string[];
  artifacts?: string[];
  hash?: string;
  round_id?: string;
  round_index?: number;
  round_ts?: string;
  round_date?: string;
  facts_text?: string[];
  context: Context;
}

export interface SemanticChunk {
  mem_id: string;
  scope: Scope;
  title?: string;
  text: string;
  tags?: string[];
  salience: number;
  novelty?: number;
  ttl_days: number;
  last_used?: string | null;  // ISO timestamp or null
  api_version?: string;
  env?: string;
  source_event_ids?: string[];
  embedding?: number[];       // vector representation
  context: Context;
}

export interface Fact {
  fact_id: string;
  s: string;
  p: string;
  o: string;
  version?: string;
  confidence?: number;
  evidence?: string[];
  context: Context;
}

export interface Hit {
  id: string;              // e.g., mem:abc or evt:xyz
  text: string;
  score: number;
  source: Source;
  why?: string;
  tags?: string[];
  context: Context;
  meta?: Record<string, any>;
}

export interface RetrievalQuery extends Context {
  objective: string;
  filters?: {
    scope?: Scope[];
    tags?: string[];
    api_version?: string;
    env?: string;
  };
  budget?: number;          // max snippets to return
}

export interface RetrievalResult {
  snippets: Hit[];
}

export interface EvalMetrics extends Context {
  task_id: string;
  step: number;
  success: boolean;
  tokens_in: number;
  latency_ms: number;
  cost_usd?: number;
  retrieved_ids: string[];
  p_at_k?: number;
  groundedness?: number;
}
