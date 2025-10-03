// src/routes/memory.ts
// Memory write/retrieve/promote tools for Memora MCP.

import { Server } from "@modelcontextprotocol/sdk";
import { v4 as uuidv4 } from "uuid";

import { getClient } from "../services/os-client";
import { embed } from "../services/embedder";
import { scoreSalience, atomicSplit, summarizeIfLong, redact } from "../services/salience";
import { packSnippets } from "../services/packer";
import { crossRerank } from "../services/rerank";

import { requireContext } from "./context";
import { buildBoolFilter, FilterOptions } from "../domain/filters";
import { fuseAndDiversify, Hit as FusedHit } from "../domain/fusion";
import {
  Context,
  Event,
  SemanticChunk,
  Fact,
  RetrievalQuery,
  RetrievalResult,
  Scope
} from "../domain/types";

// ---- Index names & knobs ----
const METRICS_INDEX = process.env.MEMORA_METRICS_INDEX || "mem-metrics";
const SEMANTIC_INDEX = process.env.MEMORA_SEMANTIC_INDEX || "mem-semantic";
const FACTS_INDEX = process.env.MEMORA_FACTS_INDEX || "mem-facts";
const EPISODIC_PREFIX = process.env.MEMORA_EPI_PREFIX || "mem-episodic-";

const DEFAULT_BUDGET = Number(process.env.MEMORA_DEFAULT_BUDGET || 12);
const RERANK_ENABLED = process.env.MEMORA_RERANK_ENABLED === "true";

// ---- Public registration ----
export function registerMemory(server: Server) {
  server.tool("memory.write", handleWrite);
  server.tool("memory.retrieve", handleRetrieve);
  server.tool("memory.promote", handlePromote);
}

// =========================
// memory.write
// =========================
async function handleWrite(req: any) {
  const ctx = requireContext();
  const client = getClient();

  // Assemble event from params + context
  const nowIso = new Date().toISOString();
  const event: Event = {
    event_id: uuidv4(),
    ts: req.params?.ts || nowIso,
    role: req.params?.role || "tool",
    content: redact(String(req.params?.content ?? "")),
    tags: req.params?.tags || [],
    artifacts: req.params?.artifacts || [],
    hash: req.params?.hash,
    context: {
      tenant_id: ctx.tenant_id,
      project_id: ctx.project_id,
      context_id: ctx.context_id,
      task_id: req.params?.task_id || ctx.task_id,
      env: ctx.env,
      api_version: ctx.api_version
    }
  };

  // 1) Write episodic (append-only)
  const episodicIndex = dailyEpisodicIndex();
  await client.index({
    index: episodicIndex,
    id: event.event_id,
    document: flattenEventForIndex(event)
  });

  // 2) Salience → semantic chunks + facts
  const atoms = atomicSplit(event.content);
  const chunks: SemanticChunk[] = [];
  const facts: Fact[] = [];

  for (const a of atoms) {
    const sal = scoreSalience(a, { tags: event.tags });
    if (sal < getPolicy("salience.min_score", 0.6)) continue;

    // (a) facts (very light heuristic; your extractor can live in salience.ts)
    const extractedFacts = extractFacts(a, event.context);
    facts.push(...extractedFacts);

    // (b) semantic chunk
    const text = summarizeIfLong(a, getPolicy("salience.max_chunk_tokens", 800));
    const vec = await embed(text); // local or remote embedder
    const mem_id = uuidv4();
    chunks.push({
      mem_id,
      scope: (req.params?.scope as Scope) || "this_task",
      title: deriveTitle(text),
      text,
      tags: event.tags,
      salience: sal,
      ttl_days: getPolicy("ttl.semantic_days", 180),
      last_used: null,
      api_version: event.context.api_version,
      env: event.context.env,
      source_event_ids: [event.event_id],
      embedding: vec,
      context: event.context
    });
  }

  // 2a) Index semantic chunks
  let semantic_upserts = 0;
  if (chunks.length > 0) {
    const body = chunks.flatMap((c) => [
      { index: { _index: SEMANTIC_INDEX, _id: c.mem_id } },
      flattenChunkForIndex(c)
    ]);
    const resp = await client.bulk({ refresh: "true", body });
    if (resp.errors) {
      const items = (resp.items || []).filter((i: any) => i.index?.error);
      throw new Error(`semantic_upsert errors: ${JSON.stringify(items.slice(0, 3))}`);
    }
    semantic_upserts = chunks.length;
  }

  // 2b) Index facts
  let facts_upserts = 0;
  if (facts.length > 0) {
    const body = facts.flatMap((f) => [
      { index: { _index: FACTS_INDEX, _id: f.fact_id } },
      flattenFactForIndex(f)
    ]);
    const resp = await client.bulk({ refresh: "false", body });
    if (resp.errors) {
      const items = (resp.items || []).filter((i: any) => i.index?.error);
      throw new Error(`facts_upsert errors: ${JSON.stringify(items.slice(0, 3))}`);
    }
    facts_upserts = facts.length;
  }

  return { ok: true, event_id: event.event_id, semantic_upserts, facts_upserts };
}

// =========================
/** memory.retrieve
 *  - Pulls episodic (BM25), semantic (k-NN), facts (keyword), fuses, optional rerank, diversifies.
 */
// =========================
async function handleRetrieve(req: any): Promise<RetrievalResult> {
  const client = getClient();
  const active = requireContext();

  const q = req.params as RetrievalQuery;
  const budget = q.budget ?? DEFAULT_BUDGET;

  // Build filter options shared across searches
  const fopts: FilterOptions = {
    tenant_id: active.tenant_id,
    project_id: active.project_id,
    context_id: q.context_id ?? active.context_id,
    task_id: q.task_id ?? active.task_id,
    scopes: q.filters?.scope ?? ["this_task", "project"],
    tags: q.filters?.tags,
    api_version: q.filters?.api_version ?? active.api_version,
    env: q.filters?.env ?? active.env,
    exclude_tags: getPolicyArray("filters.exclude_tags", ["secret", "sensitive"]),
    recent_days: getPolicy("stages.episodic.recent_days", 30)
  };

  // Stage A: Episodic (BM25 / match)
  const episodicHits = await episodicSearch(client, q, fopts);

  // Stage B: Semantic (k-NN + filters)
  const semanticHits = await semanticSearch(client, q, fopts);

  // Stage C: Facts (1–2 hop expansion)
  const factHits = await factsSearch(client, q, fopts);

  // Fuse + optional rerank
  let fused: FusedHit[] = fuseAndDiversify(
    episodicHits,
    semanticHits,
    factHits,
    {
      limit: budget,
      rrfK: getPolicy("fusion.rrf_k", 60),
      normalizeScores: true,
      mmr: {
        enabled: true,
        lambda: getPolicy("diversity.lambda", 0.7),
        minDistance: getPolicy("diversity.min_distance", 0.2),
        maxPerTag: getPolicy("diversity.max_per_tag", 3)
      }
    }
  );

  if (RERANK_ENABLED) {
    fused = await crossRerank(q.objective, fused, {
      maxCandidates: getPolicy("rerank.max_candidates", 64),
      budgetMs: getPolicy("rerank.budget_ms", 1000)
    });
    fused = fused.slice(0, budget);
  }

  // Touch last_used for semantic docs we return
  await touchLastUsed(client, fused.filter(h => h.source === "semantic").map(h => h.id));

  // Optionally compress/package on the server; often you’ll pack in the client
  const snippets = fused.map(h => ({
    id: h.id,
    text: h.text || "",
    score: h.score,
    source: h.source,
    why: h.why,
    tags: h.tags
  }));

  return { snippets };
}

// =========================
// memory.promote
// =========================
async function handlePromote(req: any) {
  const client = getClient();
  const { mem_id, to_scope } = req.params as { mem_id: string; to_scope: Scope };
  if (!mem_id || !to_scope) throw new Error("memory.promote requires mem_id and to_scope.");

  await client.update({
    index: SEMANTIC_INDEX,
    id: mem_id,
    doc: { task_scope: to_scope }
  });

  return { ok: true, mem_id, scope: to_scope };
}

// =====================================================
// --------- Helpers: search, indexing, policies --------
// =====================================================

function dailyEpisodicIndex(): string {
  return `${EPISODIC_PREFIX}${new Date().toISOString().slice(0, 10)}`;
}

function flattenEventForIndex(e: Event) {
  return {
    tenant_id: e.context.tenant_id,
    project_id: e.context.project_id,
    context_id: e.context.context_id,
    task_id: e.context.task_id,
    event_id: e.event_id,
    ts: e.ts,
    role: e.role,
    content: e.content,
    tags: e.tags || [],
    artifacts: e.artifacts || [],
    hash: e.hash || null
  };
}

function flattenChunkForIndex(c: SemanticChunk) {
  return {
    tenant_id: c.context.tenant_id,
    project_id: c.context.project_id,
    context_id: c.context.context_id,
    task_scope: c.scope,
    mem_id: c.mem_id,
    title: c.title || null,
    text: c.text,
    tags: c.tags || [],
    salience: c.salience,
    novelty: c.novelty ?? null,
    ttl_days: c.ttl_days,
    last_used: c.last_used ?? "1970-01-01T00:00:00Z",
    api_version: c.api_version || null,
    env: c.env || null,
    source_event_ids: c.source_event_ids || [],
    embedding: c.embedding
  };
}

function flattenFactForIndex(f: Fact) {
  return {
    tenant_id: f.context.tenant_id,
    project_id: f.context.project_id,
    fact_id: f.fact_id,
    s: f.s, p: f.p, o: f.o,
    version: f.version || null,
    confidence: f.confidence ?? null,
    evidence: f.evidence || []
  };
}

// ---- Episodic BM25
async function episodicSearch(client: any, q: RetrievalQuery, fopts: FilterOptions): Promise<FusedHit[]> {
  const must = [{
    simple_query_string: {
      query: [
        q.objective,
        (q.task_id ? `"${q.task_id}"` : ""),
      ].filter(Boolean).join(" "),
      fields: ["content^3", "tags", "artifacts"],
      default_operator: "and"
    }
  }];

  const filter = buildBoolFilter(fopts);
  const body = {
    size: getPolicy("stages.episodic.top_k", 25),
    query: {
      bool: {
        must,
        filter: filter.bool.filter,
        must_not: filter.bool.must_not
      }
    }
  };

  const resp = await client.search({ index: `${EPISODIC_PREFIX}*`, body });
  return (resp.hits?.hits || []).map((hit: any, i: number) => ({
    id: `evt:${hit._id}`,
    text: hit._source?.content || "",
    score: hit._score ?? 0,
    rank: i + 1,
    source: "episodic" as const,
    tags: hit._source?.tags || [],
    why: "episodic: text match",
    meta: {}
  }));
}

// ---- Semantic k-NN
async function semanticSearch(client: any, q: RetrievalQuery, fopts: FilterOptions): Promise<FusedHit[]> {
  const qvec = await embed(buildSemanticQueryText(q));
  const size = getPolicy("stages.semantic.top_k", 50);
  const k = getPolicy("stages.semantic.ann_candidates", 200);

  const postFilter = buildBoolFilter(fopts);

  const body = {
    size,
    knn: {
      field: "embedding",
      query_vector: qvec,
      k,
      num_candidates: k
    },
    post_filter: postFilter
  };

  const resp = await client.search({ index: SEMANTIC_INDEX, body });
  return (resp.hits?.hits || []).map((hit: any, i: number) => ({
    id: `mem:${hit._id}`,
    text: hit._source?.text || "",
    score: hit._score ?? 0,
    rank: i + 1,
    source: "semantic" as const,
    tags: hit._source?.tags || [],
    why: "semantic: vector similarity",
    meta: { embedding: hit._source?.embedding }
  }));
}

// ---- Facts (1–2 hop expansion; here we just keyword-match s/p/o)
async function factsSearch(client: any, q: RetrievalQuery, fopts: FilterOptions): Promise<FusedHit[]> {
  const filter = buildBoolFilter(fopts);
  const body = {
    size: getPolicy("stages.facts.top_k", 20),
    query: {
      bool: {
        must: [{
          multi_match: {
            query: q.objective,
            fields: ["s^2", "p", "o"]
          }
        }],
        filter: filter
      }
    }
  };
  const resp = await client.search({ index: FACTS_INDEX, body });
  return (resp.hits?.hits || []).map((hit: any, i: number) => ({
    id: `fact:${hit._id}`,
    text: `${hit._source?.s} ${hit._source?.p} ${hit._source?.o}`,
    score: hit._score ?? 0,
    rank: i + 1,
    source: "facts" as const,
    tags: ["fact"],
    why: "facts: structured relation",
    meta: {}
  }));
}

async function touchLastUsed(client: any, memIds: string[]) {
  if (memIds.length === 0) return;
  const now = new Date().toISOString();
  const body = memIds.flatMap((fullId) => {
    const id = fullId.replace(/^mem:/, "");
    return [{ update: { _index: SEMANTIC_INDEX, _id: id } }, { doc: { last_used: now } }];
  });
  await client.bulk({ body, refresh: "false" });
}

// ---- Utilities ----
function buildSemanticQueryText(q: RetrievalQuery): string {
  const bits = [
    q.objective,
    q.task_id ? `task:${q.task_id}` : "",
    q.env ? `env:${q.env}` : "",
    q.api_version ? `api:${q.api_version}` : "",
    (q.filters?.tags || []).map(t => `tag:${t}`).join(" ")
  ].filter(Boolean);
  return bits.join(" ");
}

function deriveTitle(text: string): string {
  const first = text.split("\n")[0].trim();
  return first.length > 80 ? first.slice(0, 77) + "…" : first;
}

// Replace with your fact extraction (regex/LLM). Here we demo a trivial pattern.
function extractFacts(text: string, ctx: Context): Fact[] {
  const m = /([A-Za-z0-9_.]+)\s+(introduced_in|requires|uses)\s+([A-Za-z0-9_.-]+)/i.exec(text);
  if (!m) return [];
  return [{
    fact_id: uuidv4(),
    s: m[1],
    p: m[2] as any,
    o: m[3],
    version: undefined,
    confidence: 0.5,
    evidence: [],
    context: ctx
  }];
}

// Very light policy accessors; consider loading YAML once in a config service.
function getPolicy(path: string, dflt: number): number {
  // Stub: replace with real config loader (e.g., read YAML in services/config.ts)
  const table: Record<string, number> = {
    "salience.min_score": 0.6,
    "salience.max_chunk_tokens": 800,
    "ttl.semantic_days": 180,
    "stages.episodic.top_k": 25,
    "stages.episodic.recent_days": 30,
    "stages.semantic.top_k": 50,
    "stages.semantic.ann_candidates": 200,
    "stages.facts.top_k": 20,
    "fusion.rrf_k": 60,
    "diversity.lambda": 0.7,
    "diversity.min_distance": 0.2,
    "diversity.max_per_tag": 3,
    "rerank.max_candidates": 64,
    "rerank.budget_ms": 1000
  };
  return table[path] ?? dflt;
}
function getPolicyArray(path: string, dflt: string[]): string[] {
  const table: Record<string, string[]> = {
    "filters.exclude_tags": ["secret", "sensitive"]
  };
  return table[path] ?? dflt;
}
