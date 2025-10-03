// src/domain/filters.ts
// Utilities to build OpenSearch query filters for memory retrieval.

export interface FilterOptions {
  tenant_id: string;
  project_id: string;
  context_id?: string;
  task_id?: string;
  scopes?: string[];          // e.g., ["this_task","project"]
  tags?: string[];
  api_version?: string;       // e.g., ">=3.3"
  env?: string;               // e.g., "dev" | "prod"
  exclude_tags?: string[];
  recent_days?: number;       // limit by recency (episodic only)
}

export function buildBoolFilter(opts: FilterOptions) {
  const must: any[] = [];
  const mustNot: any[] = [];
  const filter: any[] = [];

  // Required filters
  must.push({ term: { tenant_id: opts.tenant_id } });
  must.push({ term: { project_id: opts.project_id } });

  if (opts.context_id) {
    must.push({ term: { context_id: opts.context_id } });
  }
  if (opts.task_id) {
    must.push({ term: { task_id: opts.task_id } });
  }

  // Scope filter
  if (opts.scopes && opts.scopes.length > 0) {
    filter.push({ terms: { task_scope: opts.scopes } });
  }

  // Tag filter
  if (opts.tags && opts.tags.length > 0) {
    filter.push({ terms: { tags: opts.tags } });
  }

  // Exclude tags
  if (opts.exclude_tags && opts.exclude_tags.length > 0) {
    mustNot.push({ terms: { tags: opts.exclude_tags } });
  }

  // API version filter (naive: only supports >= version strings)
  if (opts.api_version && opts.api_version.startsWith(">=")) {
    const v = opts.api_version.replace(">=", "").trim();
    filter.push({ range: { api_version: { gte: v } } });
  }

  // Env filter
  if (opts.env) {
    filter.push({ term: { env: opts.env } });
  }

  // Recency filter
  if (opts.recent_days && opts.recent_days > 0) {
    filter.push({
      range: {
        ts: { gte: `now-${opts.recent_days}d/d` }
      }
    });
  }

  return {
    bool: {
      must,
      must_not: mustNot,
      filter
    }
  };
}
