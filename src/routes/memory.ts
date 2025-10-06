// src/routes/memory.ts
// Memory write/retrieve/promote tools for Memora MCP.

import { v4 as uuidv4 } from "uuid";
import { debug } from "../services/log.js";

import { getClient, bulkSafe, indexWithRetries, searchWithRetries, withRetries } from "../services/os-client.js";
import { embed } from "../services/embedder.js";
import { scoreSalience, atomicSplit, summarizeIfLong, redact } from "../services/salience.js";
import { crossRerank } from "../services/rerank.js";
import { policyNumber, policyArray, retrievalNumber, retrievalArray } from "../services/config.js";
import { packPrompt } from "../services/packer.js";

import { requireContext } from "./context.js";
import { buildBoolFilter, FilterOptions } from "../domain/filters.js";
import { fuseAndDiversify, Hit as FusedHit } from "../domain/fusion.js";
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
const SEMANTIC_INDEX = process.env.MEMORA_SEMANTIC_INDEX || "mem-semantic";
const FACTS_INDEX = process.env.MEMORA_FACTS_INDEX || "mem-facts";
const EPISODIC_PREFIX = process.env.MEMORA_EPI_PREFIX || "mem-episodic-";

const DEFAULT_BUDGET = Number(process.env.MEMORA_DEFAULT_BUDGET || 12);
const RERANK_ENABLED = process.env.MEMORA_RERANK_ENABLED === "true";
const log = debug("memora:memory");

// Idempotency and backpressure knobs
const IDEMP_INDEX = process.env.MEMORA_IDEMP_INDEX || "mem-idempotency";
const MAX_CHUNKS = Number(process.env.MEMORA_WRITE_MAX_CHUNKS || 64);

// In-process cache as a fast path for idempotency (persists per process)
const idempotencyCache = new Map<string, { result: { ok: boolean; event_id: string; semantic_upserts: number; facts_upserts: number }; ts: string }>();

// ---- Public registration ----
export function registerMemory(server: any) {
  server.tool("memory.write", handleWrite);
  server.tool("memory.retrieve", handleRetrieve);
  server.tool("memory.promote", handlePromote);
  // New agent-ergonomic tools
  server.tool("memory.write_if_salient", handleWriteIfSalient);
  server.tool("memory.retrieve_and_pack", handleRetrieveAndPack);
  server.tool("memory.autopromote", handleAutoPromote);
}

// =========================
// memory.write
// =========================
async function handleWrite(req: any) {
  const ctx = requireContext();

  // Idempotency fast-path: if idempotency_key (or hash) provided, check cache/persistence
  const idemRaw = req.params?.idempotency_key || req.params?.hash;
  const idemKey = idemRaw ? makeIdemKey({
    tenant_id: ctx.tenant_id,
    project_id: ctx.project_id,
    context_id: (ctx.context_id ?? ""),
    task_id: (req.params?.task_id ?? ctx.task_id ?? "")
  }, String(idemRaw)) : null;

  if (idemKey) {
    const cached = idempotencyCache.get(idemKey);
    if (cached) {
      log("idempotency.cache_hit", { key: idemKey });
      return cached.result;
    }
    // Optional persistent check (best-effort); if not found, proceed
    try {
      const resp = await searchWithRetries({
        index: IDEMP_INDEX,
        body: { size: 1, query: { ids: { values: [idemKey] } } }
      });
      const hit = resp?.body?.hits?.hits?.[0];
      if (hit && hit._source?.result) {
        log("idempotency.store_hit", { key: idemKey });
        const result = hit._source.result;
        idempotencyCache.set(idemKey, { result, ts: new Date().toISOString() });
        return result;
      }
    } catch (e) {
      log("idempotency.lookup_error", { err: String(e) });
    }
  }

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
  await indexWithRetries({
    index: episodicIndex,
    id: event.event_id,
    body: flattenEventForIndex(event),
    refresh: true
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

    // Backpressure: cap number of semantic chunks to avoid unbounded embeds
    if (chunks.length >= MAX_CHUNKS) {
      log("write.chunk_cap_reached", { cap: MAX_CHUNKS });
      break;
    }
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
    await bulkSafe(body, true);
    semantic_upserts = chunks.length;
  }

  // 2b) Index facts
  let facts_upserts = 0;
  if (facts.length > 0) {
    const body = facts.flatMap((f) => [
      { index: { _index: FACTS_INDEX, _id: f.fact_id } },
      flattenFactForIndex(f)
    ]);
    await bulkSafe(body, true);
    facts_upserts = facts.length;
  }

  const result = { ok: true, event_id: event.event_id, semantic_upserts, facts_upserts };

  // Persist idempotency record (best-effort) and cache
  if (idemKey) {
    try {
      await indexWithRetries({
        index: IDEMP_INDEX,
        id: idemKey,
        body: {
          idempotency_key: idemRaw,
          tenant_id: event.context.tenant_id,
          project_id: event.context.project_id,
          context_id: event.context.context_id,
          task_id: event.context.task_id,
          ts: nowIso,
          result
        },
        refresh: false
      });
    } catch (e) {
      log("idempotency.store_error", { err: String(e) });
    }
    idempotencyCache.set(idemKey, { result, ts: nowIso });
  }

  return result;
}

// =========================
/** memory.retrieve
 *  - Pulls episodic (BM25), semantic (k-NN), facts (keyword), fuses, optional rerank, diversifies.
 */
// =========================
async function handleRetrieve(req: any): Promise<RetrievalResult> {
  const active = requireContext();

  const q = req.params as RetrievalQuery;
  const budget = q.budget ?? DEFAULT_BUDGET;
  const t0 = Date.now();
  log("retrieve.begin", { budget, scopes: q.filters?.scope ?? ["this_task", "project"] });

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
  const tE = Date.now();
  const episodicHits = await episodicSearch(q, fopts);
  log("stage.episodic", { hits: episodicHits.length, tookMs: Date.now() - tE });

  // Stage B: Semantic (k-NN + filters)
  const tS = Date.now();
  const semanticHits = await semanticSearch(q, fopts);
  log("stage.semantic", { hits: semanticHits.length, tookMs: Date.now() - tS });

  // Stage C: Facts (1–2 hop expansion)
  const tF = Date.now();
  const factHits = await factsSearch(q, fopts);
  log("stage.facts", { hits: factHits.length, tookMs: Date.now() - tF });

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
  log("fuse", { episodic: episodicHits.length, semantic: semanticHits.length, facts: factHits.length, fused: fused.length });

  if (RERANK_ENABLED) {
    const r0 = Date.now();
    const inCount = fused.length;
    log("rerank.start", { candidates: inCount });
    fused = await crossRerank(q.objective, fused, {
      maxCandidates: getPolicy("rerank.max_candidates", 64),
      budgetMs: getPolicy("rerank.budget_ms", 1000)
    });
    fused = fused.slice(0, budget);
    log("rerank.end", { tookMs: Date.now() - r0, in: inCount, out: fused.length });
  }

  // Touch last_used for semantic docs we return
  const semanticIds = fused.filter(h => h.source === "semantic").map(h => h.id);
  await touchLastUsed(semanticIds);
  log("semantic.touch", { count: semanticIds.length });

  // Optionally compress/package on the server; often you’ll pack in the client
  const snippets = fused.map(h => ({
    id: h.id,
    text: h.text || "",
    score: h.score,
    source: h.source,
    why: h.why,
    tags: h.tags,
    context: active
  }));

  log("retrieve.end", { totalMs: Date.now() - t0, snippets: snippets.length });
  return { snippets };
}

// =========================
// memory.promote
// =========================
async function handlePromote(req: any) {
  const client = getClient();
  const { mem_id, to_scope } = req.params as { mem_id: string; to_scope: Scope };
  if (!mem_id || !to_scope) throw new Error("memory.promote requires mem_id and to_scope.");

  // Normalize to accept either "mem:<id>" or raw "<id>"
  const id = String(mem_id).replace(/^mem:/, "");

  await withRetries(() => client.update({
    index: SEMANTIC_INDEX,
    id,
    body: { doc: { task_scope: to_scope } }
  }));

  return { ok: true, mem_id: id, scope: to_scope };
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
async function episodicSearch(q: RetrievalQuery, fopts: FilterOptions): Promise<FusedHit[]> {
  const must = [{
    simple_query_string: {
      query: q.objective,
      fields: ["content^3", "tags", "artifacts"]
    }
  }];

  // Episodic docs do not include env/api_version or scope; tailor filters accordingly
  const eopts: FilterOptions = {
    tenant_id: fopts.tenant_id,
    project_id: fopts.project_id,
    context_id: fopts.context_id,
    task_id: fopts.task_id,
    tags: fopts.tags,
    exclude_tags: fopts.exclude_tags,
    recent_days: fopts.recent_days
  };
  const filter = buildBoolFilter(eopts);
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

  const resp = await searchWithRetries({ index: `${EPISODIC_PREFIX}*`, body });
  return (resp.body.hits?.hits || []).map((hit: any, i: number) => ({
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
async function semanticSearch(q: RetrievalQuery, fopts: FilterOptions): Promise<FusedHit[]> {
  const qvec = await embed(buildSemanticQueryText(q));
  const size = getPolicy("stages.semantic.top_k", 50);

  const sfopts: FilterOptions = {
    tenant_id: fopts.tenant_id,
    project_id: fopts.project_id,
    context_id: fopts.context_id,
    // semantic docs do not persist task_id; filter by scope/context instead
    scopes: fopts.scopes,
    tags: fopts.tags,
    api_version: fopts.api_version,
    env: fopts.env,
    exclude_tags: fopts.exclude_tags
  };
  const bf = buildBoolFilter(sfopts);
  const filterClauses: any[] = [];
  for (const qx of bf.bool.must) filterClauses.push(qx);
  for (const qx of bf.bool.filter) filterClauses.push(qx);
  if (bf.bool.must_not && bf.bool.must_not.length) {
    filterClauses.push({ bool: { must_not: bf.bool.must_not } });
  }

  // Use widely-supported script_score with knn_score to avoid version-specific knn syntax issues
  const innerBool: any = {
    filter: bf.bool.filter || []
  };
  if (bf.bool.must && bf.bool.must.length) innerBool.must = bf.bool.must;
  if (bf.bool.must_not && bf.bool.must_not.length) innerBool.must_not = bf.bool.must_not;

  const body = {
    size,
    query: {
      script_score: {
        query: { bool: innerBool },
        script: {
          source: "knn_score",
          lang: "knn",
          params: {
            field: "embedding",
            query_value: qvec,
            space_type: "cosinesimil"
          }
        }
      }
    }
  };
  const resp = await searchWithRetries({ index: SEMANTIC_INDEX, body });
  let hits: any[] = (resp.body.hits?.hits || []);

  // Fallback: if ANN returns nothing (plugin/syntax variance), use BM25 over text/title with same filters
  if (hits.length === 0) {
    const fallbackBody = {
      size,
      query: {
        bool: {
          must: [{
            simple_query_string: {
              query: q.objective,
              fields: ["text^2", "title", "tags"]
            }
          }],
          filter: bf.bool.filter,
          must_not: bf.bool.must_not
        }
      }
    };
    const resp2 = await searchWithRetries({ index: SEMANTIC_INDEX, body: fallbackBody as any });
    hits = (resp2.body.hits?.hits || []);
  }

  return hits.map((hit: any, i: number) => ({
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
async function factsSearch(q: RetrievalQuery, fopts: FilterOptions): Promise<FusedHit[]> {
  // Facts docs only store tenant_id and project_id; avoid filtering on context/task/env/api_version
  const ff = buildBoolFilter({
    tenant_id: fopts.tenant_id,
    project_id: fopts.project_id
  } as any);
  const filterClauses: any[] = [];
  for (const qx of ff.bool.must) filterClauses.push(qx);
  for (const qx of ff.bool.filter) filterClauses.push(qx);

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
        filter: filterClauses
      }
    }
  };
  const resp = await searchWithRetries({ index: FACTS_INDEX, body });
  return (resp.body.hits?.hits || []).map((hit: any, i: number) => ({
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

async function touchLastUsed(memIds: string[]) {
  if (memIds.length === 0) return;
  const now = new Date().toISOString();
  const body = memIds.flatMap((fullId) => {
    const id = fullId.replace(/^mem:/, "");
    return [{ update: { _index: SEMANTIC_INDEX, _id: id } }, { doc: { last_used: now } }];
  });
  await bulkSafe(body, false);
}

 // ---- Utilities ----
 function makeIdemKey(ctxIds: { tenant_id: string; project_id: string; context_id: string; task_id: string }, key: string): string {
   const safe = (s: string) => String(s).replace(/[^A-Za-z0-9:_-]/g, "_");
   return `${safe(ctxIds.tenant_id)}:${safe(ctxIds.project_id)}:${safe(ctxIds.context_id)}:${safe(ctxIds.task_id)}:${safe(key)}`;
 }
 function buildSemanticQueryText(q: RetrievalQuery): string {
  // IMPORTANT: For semantic query embedding, use only the natural-language objective.
  // All metadata constraints (scope/tags/env/api_version) are applied via filters, not the embedding.
  // Including tags/identifiers in the embed text pollutes the semantic signal and hurts retrieval accuracy.
  return String(q.objective ?? "");
}

function deriveTitle(text: string): string {
  const first = text.split("\n")[0].trim();
  return first.length > 80 ? first.slice(0, 77) + "…" : first;
}

/**
 * memory.write_if_salient
 * Fast salience precheck: if no atom meets threshold, do not persist anything.
 * Optional param: min_score_override to adjust threshold at call time (useful for tests/agents).
 */
async function handleWriteIfSalient(req: any) {
  requireContext();
  const content = String(req.params?.content ?? "");
  const atoms = atomicSplit(content);
  const threshold = typeof req.params?.min_score_override === "number"
    ? Number(req.params.min_score_override)
    : getPolicy("salience.min_score", 0.6);

  let anySalient = false;
  for (const a of atoms) {
    const sal = scoreSalience(a, { tags: req.params?.tags || [] });
    if (sal >= threshold) {
      anySalient = true;
      break;
    }
  }

  // Heuristic: treat structured fact-like relations as salient even if score is below threshold
  // Matches "<subject> (introduced_in|requires|uses) <object>"
  if (!anySalient) {
    const relationLike = /([A-Za-z0-9_.]+)\s+(introduced_in|requires|uses)\s+([A-Za-z0-9_.-]+)/i.test(content);
    if (relationLike) {
      anySalient = true;
    }
  }

  if (!anySalient) {
    return { ok: true, written: false, reason: "below_threshold" };
  }

  // Delegate to canonical write
  const res = await handleWrite(req);
  return { ok: true, written: true, ...res };
}

/**
 * memory.retrieve_and_pack
 * Retrieves snippets and returns a packed prompt using config/packing.yaml.
 * Accepts optional sections: system, task_frame, tool_state, recent_turns (strings).
 */
async function handleRetrieveAndPack(req: any) {
  requireContext(); // ensure context set
  const rres = await handleRetrieve({ params: req.params });

  const system = String(req.params?.system ?? "");
  const task_frame = String(req.params?.task_frame ?? "");
  const tool_state = String(req.params?.tool_state ?? "");
  const recent_turns = String(req.params?.recent_turns ?? "");

  const retrievedText = rres.snippets
    .map((s, i) => `[#${i + 1}] (${s.source}; score=${(s.score ?? 0).toFixed(3)}) ${s.text}`)
    .join("\n");

  const sections = [
    system ? { name: "system", content: system } : null,
    task_frame ? { name: "task_frame", content: task_frame } : null,
    tool_state ? { name: "tool_state", content: tool_state } : null,
    retrievedText ? { name: "retrieved", content: retrievedText } : null,
    recent_turns ? { name: "recent_turns", content: recent_turns } : null
  ].filter(Boolean) as { name: string; content: string }[];

  const packed_prompt = packPrompt(sections);
  return { snippets: rres.snippets, packed_prompt };
}

/**
 * memory.autopromote
 * Promotes top-N semantic memories to a target scope based on sort criteria.
 * Request: { to_scope, limit?, sort_by? = "last_used", filters? }
 */
async function handleAutoPromote(req: any) {
  const client = getClient();
  const to_scope = req.params?.to_scope as Scope;
  if (!to_scope) throw new Error("memory.autopromote requires to_scope.");

  const active = requireContext();
  const limit = Math.max(1, Math.min(100, Number(req.params?.limit ?? 10)));
  const sort_by = String(req.params?.sort_by ?? "last_used"); // "last_used" | "salience"

  // Build filter for current tenant/project (+ optional filters)
  const fopts: FilterOptions = {
    tenant_id: active.tenant_id,
    project_id: active.project_id,
    context_id: req.params?.filters?.context_id ?? active.context_id,
    scopes: req.params?.filters?.scope ?? ["this_task", "project"],
    tags: req.params?.filters?.tags,
    api_version: req.params?.filters?.api_version ?? active.api_version,
    env: req.params?.filters?.env ?? active.env,
    exclude_tags: getPolicyArray("filters.exclude_tags", ["secret", "sensitive"])
  } as any;

  const bf = buildBoolFilter(fopts);
  // Build sort array explicitly to satisfy OpenSearch client's SortOptions[]
  const sort: any[] = [];
  if (sort_by === "salience") {
    sort.push({ salience: { order: "desc" } }, { last_used: { order: "desc" } });
  } else {
    sort.push({ last_used: { order: "desc" } }, { salience: { order: "desc" } });
  }

  const body = {
    size: limit,
    query: { bool: { must: bf.bool.must ?? [], filter: bf.bool.filter ?? [], must_not: bf.bool.must_not ?? [] } },
    sort
  };

  const resp = await searchWithRetries({ index: SEMANTIC_INDEX, body });
  const hits: any[] = (resp.body?.hits?.hits ?? []);
  const ids = hits.map(h => String(h._id));

  for (const id of ids) {
    await withRetries(() => client.update({
      index: SEMANTIC_INDEX,
      id,
      body: { doc: { task_scope: to_scope } }
    }));
  }

  return { ok: true, promoted: ids, scope: to_scope };
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
  // Route keys to the correct YAML: memory_policies.yaml for salience/ttl, retrieval.yaml for the rest.
  if (path.startsWith("salience.") || path.startsWith("ttl.")) {
    return policyNumber(path, dflt);
  }
  return retrievalNumber(path, dflt);
}
function getPolicyArray(path: string, dflt: string[]): string[] {
  // filters.* live under retrieval.yaml; others fall back to policies if added later.
  if (path.startsWith("filters.")) {
    return retrievalArray(path, dflt);
  }
  return policyArray(path, dflt);
}
