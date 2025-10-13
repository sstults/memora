// src/routes/memory.ts
// Memory write/retrieve/promote tools for Memora MCP.

import { v4 as uuidv4 } from "uuid";
import { debug } from "../services/log.js";

import { getClient, bulkSafe, indexWithRetries, searchWithRetries, withRetries } from "../services/os-client.js";
import { embed } from "../services/embedder.js";
import { scoreSalience, atomicSplit, summarizeIfLong, redact } from "../services/salience.js";
import { crossRerank } from "../services/rerank.js";
import { policyNumber, policyArray, retrievalNumber, retrievalArray, retrievalBoolean, retrievalString } from "../services/config.js";
import { packPrompt } from "../services/packer.js";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

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
// Rerank gating: env override if set, else fall back to retrieval.yaml (rerank.enabled)
const ENV_RERANK = process.env.MEMORA_RERANK_ENABLED;
const RERANK_ENABLED = ENV_RERANK ? ENV_RERANK.toLowerCase() === "true" : retrievalBoolean("rerank.enabled", false);
const USE_OS_PIPELINE = (process.env.MEMORA_EMBED_PROVIDER || "").toLowerCase() === "opensearch_pipeline";
const log = debug("memora:memory");
function currentTraceFile(): string {
  return process.env.MEMORA_TRACE_FILE || "";
}

function traceWrite(event: string, payload: any) {
  // Write if a trace file is configured, regardless of MEMORA_QUERY_TRACE
  const file = currentTraceFile();
  if (!file) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(
      file,
      JSON.stringify({ ts: new Date().toISOString(), event, ...payload }) + "\n"
    );
  } catch {
    // ignore
  }
}

// Environment snapshot from memory route module to verify TRACE_FILE visibility
try {
  traceWrite("env.snapshot.memory", {
    cwd: process.cwd(),
    MODULE: "routes/memory",
    MEMORA_TRACE_FILE: currentTraceFile() || "unset",
    MEMORA_EPI_PREFIX: process.env.MEMORA_EPI_PREFIX || "unset"
  });
} catch {
  // ignore
}

// Idempotency and backpressure knobs
const IDEMP_INDEX = process.env.MEMORA_IDEMP_INDEX || "mem-idempotency";
const MAX_CHUNKS = Number(process.env.MEMORA_WRITE_MAX_CHUNKS || 64);

// In-process cache as a fast path for idempotency (persists per process)
const idempotencyCache = new Map<string, { result: { ok: boolean; event_id: string; semantic_upserts: number; facts_upserts: number }; ts: string }>();

// Normalize various SDK request shapes into a flat params object.
// Supports: req.params, req.arguments, nested { params: {...} } / { arguments: {...} }, or when req itself is the params object.
function normalizeParamsContainer(raw: any): any {
  const req = raw || {};
  const isObj = (v: any) => v && typeof v === "object" && !Array.isArray(v);
  const parseIfJson = (v: any) => {
    if (typeof v === "string") {
      try { return JSON.parse(v); } catch { return {}; }
    }
    return v;
  };

  // Prefer explicit "arguments" from MCP request
  if ((req as any).arguments !== undefined) {
    const a = (req as any).arguments;
    return isObj(a) ? a : parseIfJson(a);
  }

  // If "params" exists and looks like a plain args object (not the whole SDK request), use/unwrap it
  if ((req as any).params !== undefined && !("sendRequest" in (req as any).params) && !("requestInfo" in (req as any).params)) {
    let p: any = (req as any).params;
    p = parseIfJson(p);
    if ((p as any)?.arguments !== undefined) {
      const a = (p as any).arguments;
      return isObj(a) ? a : parseIfJson(a);
    }
    if ((p as any)?.params !== undefined) {
      const pp = (p as any).params;
      return isObj(pp) ? pp : parseIfJson(pp);
    }
    return isObj(p) ? p : {};
  }

  // SDK envelope: requestInfo.params or requestInfo.arguments
  if (isObj((req as any).requestInfo)) {
    const ri: any = (req as any).requestInfo;
    if (ri?.params !== undefined) {
      const v = ri.params;
      return isObj(v) ? v : parseIfJson(v);
    }
    if (ri?.arguments !== undefined) {
      const v = ri.arguments;
      return isObj(v) ? v : parseIfJson(v);
    }
  }

  // Some servers put the SDK envelope under req.params (so path becomes req.params.requestInfo.{params|arguments})
  if ((req as any).params !== undefined) {
    const rpAny: any = (req as any).params;
    const rp = isObj(rpAny) ? rpAny : parseIfJson(rpAny);
    if (isObj(rp)) {
      if (isObj(rp.requestInfo)) {
        const rpi: any = rp.requestInfo;
        if (rpi?.params !== undefined) {
          const v = rpi.params;
          return isObj(v) ? v : parseIfJson(v);
        }
        if (rpi?.arguments !== undefined) {
          const v = rpi.arguments;
          return isObj(v) ? v : parseIfJson(v);
        }
      }
      if (rp?.arguments !== undefined) {
        const v = rp.arguments;
        return isObj(v) ? v : parseIfJson(v);
      }
      if (rp?.params !== undefined) {
        const v = rp.params;
        return isObj(v) ? v : parseIfJson(v);
      }
      if (rp?.body !== undefined) {
        const v = rp.body;
        return isObj(v) ? v : parseIfJson(v);
      }
      if (rp?.data !== undefined) {
        const v = rp.data;
        return isObj(v) ? v : parseIfJson(v);
      }
    }
  }

  // Some SDKs wrap twice: req.params.params or req.params.arguments
  if ((req as any).params !== undefined) {
    const rpAny: any = (req as any).params;
    const rp = isObj(rpAny) ? rpAny : parseIfJson(rpAny);
    if (isObj(rp)) {
      if (rp?.params !== undefined) {
        const v = rp.params;
        return isObj(v) ? v : parseIfJson(v);
      }
      if (rp?.arguments !== undefined) {
        const v = rp.arguments;
        return isObj(v) ? v : parseIfJson(v);
      }
    }
  }

  // SDK meta envelope: req._meta.request.{arguments|params} or req._meta.{arguments|params}
  if (isObj((req as any)._meta)) {
    const meta: any = (req as any)._meta;
    if (isObj(meta.request)) {
      const rq: any = meta.request;
      if (rq?.arguments !== undefined) {
        const v = rq.arguments;
        return isObj(v) ? v : parseIfJson(v);
      }
      if (rq?.params !== undefined) {
        const v = rq.params;
        return isObj(v) ? v : parseIfJson(v);
      }
    }
    if (meta?.arguments !== undefined) {
      const v = meta.arguments;
      return isObj(v) ? v : parseIfJson(v);
    }
    if (meta?.params !== undefined) {
      const v = meta.params;
      return isObj(v) ? v : parseIfJson(v);
    }
  }

  // Last resort: if raw itself looks like an args object or is a JSON string of it
  if (typeof req === "string") {
    const parsed = parseIfJson(req);
    if (isObj(parsed)) return parsed;
  }
  if (isObj(req) && ("objective" in req || "budget" in req || "filters" in req || "to_scope" in req || "content" in req)) {
    return req;
  }

  return {};
}

// ---- Public registration ----
export function registerMemory(server: any) {
  // Register handlers directly; pass raw request for write, and schema-bound args for retrieve (SDK three-arg signature)
  server.tool(
    "memory.write",
    "Persist an event; always writes episodic, semantic/facts gated by salience.",
    {
      content: z.string().describe("Event content text"),
      role: z.string().optional().describe("Role for the event, default 'tool'"),
      tags: z.array(z.string()).optional().describe("Optional tags"),
      idempotency_key: z.string().optional().describe("Idempotency key for de-duplication"),
      scope: z.enum(["this_task", "project", "tenant"]).optional().describe("Scope for semantic chunks"),
      task_id: z.string().optional().describe("Task identifier"),
      artifacts: z.array(z.string()).optional().describe("Optional artifact identifiers"),
      hash: z.string().optional().describe("Optional hash for idempotency"),
      ts: z.string().optional().describe("ISO timestamp override"),
      // Optional context override when no active context is set in-process
      tenant_id: z.string().optional().describe("Optional: provide when no active context is set"),
      project_id: z.string().optional().describe("Optional: provide when no active context is set"),
      context_id: z.string().optional().describe("Optional context identifier"),
      env: z.string().optional(),
      api_version: z.string().optional()
    },
    async (args: any) => {
      return handleWrite({ params: args });
    }
  );
  // Fallback to standard registration to avoid SDK signature mismatches; normalization inside handleRetrieve covers envelopes
  server.tool(
    "memory.retrieve",
    "Retrieve memories by fusing episodic (BM25), semantic (k-NN), and facts; optional rerank and diversification.",
    {
      objective: z.string().describe("Natural-language query objective"),
      budget: z.number().optional().describe("Max number of items to return (top-K budget)"),
      filters: z.object({
        scope: z.array(z.string()).optional().describe("Scopes to search e.g., ['this_task','project']"),
        tags: z.array(z.string()).optional().describe("Optional tag filters"),
        api_version: z.string().optional(),
        env: z.string().optional()
      }).optional(),
      context_id: z.string().optional(),
      task_id: z.string().optional()
    },
    async (args: any) => {
      return handleRetrieve({ params: args });
    }
  );
  server.tool(
    "memory.promote",
    "Promote a semantic memory to a broader scope.",
    {
      mem_id: z.string().describe("Semantic memory id (mem:<id> or <id>)"),
      to_scope: z.enum(["this_task", "project", "tenant"]).describe("Target scope")
    },
    async (args: any) => {
      return handlePromote({ params: args });
    }
  );
  // New agent-ergonomic tools
  server.tool(
    "memory.write_if_salient",
    "Write only if at least one salient atom passes threshold.",
    {
      content: z.string().describe("Event content text"),
      role: z.string().optional(),
      tags: z.array(z.string()).optional(),
      idempotency_key: z.string().optional(),
      scope: z.enum(["this_task", "project", "tenant"]).optional(),
      task_id: z.string().optional(),
      min_score_override: z.number().optional().describe("Override salience threshold for this call")
    },
    async (args: any) => {
      return handleWriteIfSalient({ params: args });
    }
  );
  server.tool(
    "memory.retrieve_and_pack",
    "Retrieve snippets and return a packed prompt using config/packing.yaml.",
    {
      objective: z.string().describe("Natural-language query objective"),
      budget: z.number().optional().describe("Max number of items to return (top-K budget)"),
      system: z.string().optional(),
      task_frame: z.string().optional(),
      tool_state: z.string().optional(),
      recent_turns: z.string().optional(),
      filters: z.object({
        scope: z.array(z.string()).optional(),
        tags: z.array(z.string()).optional(),
        api_version: z.string().optional(),
        env: z.string().optional()
      }).optional(),
      context_id: z.string().optional(),
      task_id: z.string().optional()
    },
    async (args: any) => {
      return handleRetrieveAndPack({ params: args });
    }
  );
  server.tool(
    "memory.autopromote",
    "Promote top-N semantic memories to a target scope based on sort criteria.",
    {
      to_scope: z.enum(["this_task", "project", "tenant"]).describe("Target scope"),
      limit: z.number().optional().describe("Number of items to promote (default 10)"),
      sort_by: z.enum(["last_used", "salience"]).optional().describe("Sort criteria"),
      filters: z.object({
        context_id: z.string().optional(),
        scope: z.array(z.string()).optional(),
        tags: z.array(z.string()).optional(),
        api_version: z.string().optional(),
        env: z.string().optional()
      }).optional()
    },
    async (args: any) => {
      return handleAutoPromote({ params: args });
    }
  );

  // Diagnostics: confirm tools registered in this process
  try {
    traceWrite("memory.tools_registered", {
      tools: ["memory.write","memory.retrieve","memory.promote","memory.write_if_salient","memory.retrieve_and_pack","memory.autopromote"]
    });
  } catch {
    // ignore
  }
}

// =========================
// memory.write
// =========================
async function handleWrite(req: any) {
  // Use SDK-provided params when present; otherwise normalize from envelope
  if (!(req as any)?.params || (typeof (req as any).params === "object" && Object.keys((req as any).params || {}).length === 0)) {
    (req as any).params = normalizeParamsContainer(req);
  }
  try {
    traceWrite("write.params", { keys: Object.keys((req as any)?.params || []) });
  } catch {
    // ignore
  }
  let ctx: Context;
  try {
    ctx = requireContext();
  } catch {
    const p: any = (req as any)?.params || {};
    if (!p?.tenant_id || !p?.project_id) {
      try { traceWrite("write.context_missing", { reason: "no_active_context_and_no_args" }); } catch { /* noop */ void 0; }
      throw new Error("No active context set. Provide tenant_id and project_id to memory.write or call context.set_context first.");
    }
    ctx = {
      tenant_id: String(p.tenant_id),
      project_id: String(p.project_id),
      context_id: (p.context_id as any) ?? null,
      task_id: (p.task_id as any) ?? null,
      env: p.env ?? undefined,
      api_version: p.api_version ?? undefined
    } as Context;
    try { traceWrite("write.context_fallback", { tenant_id: ctx.tenant_id, project_id: ctx.project_id }); } catch { /* noop */ void 0; }
  }
  try {
    traceWrite("write.post_context", {
      tenant_id: ctx.tenant_id,
      project_id: ctx.project_id,
      context_id: ctx.context_id,
      task_id: ctx.task_id
    });
  } catch {
    // ignore
  }

  // Idempotency check (semantic/facts only) — episodic append always executes
  const idemRaw = req.params?.idempotency_key || req.params?.hash;
  const idemKey = idemRaw ? makeIdemKey({
    tenant_id: ctx.tenant_id,
    project_id: ctx.project_id,
    context_id: (ctx.context_id ?? ""),
    task_id: (req.params?.task_id ?? ctx.task_id ?? "")
  }, String(idemRaw)) : null;

  let priorResult: { ok: boolean; event_id: string; semantic_upserts: number; facts_upserts: number } | null = null;
  if (idemKey) {
    const cached = idempotencyCache.get(idemKey);
    if (cached) {
      log("idempotency.cache_hit", { key: idemKey });
      priorResult = cached.result;
    } else {
      // Optional persistent check (best-effort); if not found, proceed
      try {
        const resp = await searchWithRetries({
          index: IDEMP_INDEX,
          body: { size: 1, query: { ids: { values: [idemKey] } } }
        });
        const hit = resp?.body?.hits?.hits?.[0];
        if (hit && hit._source?.result) {
          log("idempotency.store_hit", { key: idemKey });
          priorResult = hit._source.result;
          idempotencyCache.set(idemKey, { result: hit._source.result, ts: new Date().toISOString() });
        }
      } catch (e) {
        log("idempotency.lookup_error", { err: String(e) });
      }
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

  try {
    traceWrite("write.event_built", { episodicIndex: dailyEpisodicIndex(), id: event.event_id, ts: event.ts });
  } catch {
    // ignore
  }

  // 1) Write episodic (append-only)
  const episodicIndex = dailyEpisodicIndex();
  // Trace request before attempting write
  try {
    traceWrite("episodic.index.request", { index: episodicIndex, id: event.event_id });
  } catch {
    // ignore
  }
  // Wrap indexing in try/catch to trace failures as well
  try {
    const FORCE_DIRECT = (process.env.MEMORA_FORCE_EPI_DIRECT_WRITE || "") === "1";
    if (FORCE_DIRECT) {
      const client = getClient();
      await withRetries(() => client.index({
        index: episodicIndex,
        id: event.event_id,
        body: flattenEventForIndex(event),
        refresh: true
      } as any));
    } else {
      await indexWithRetries({
        index: episodicIndex,
        id: event.event_id,
        body: flattenEventForIndex(event),
        refresh: true
      });
    }
    traceWrite("episodic.index.ok", { index: episodicIndex, id: event.event_id });
    // Back-compat event
    traceWrite("episodic.write", {
      index: episodicIndex,
      id: event.event_id,
      tags: event.tags,
      context: event.context
    });
  } catch (e) {
    try {
      traceWrite("episodic.index.fail", { index: episodicIndex, id: event.event_id, error: String(e) });
    } catch {
      // ignore
    }
    throw e;
  }

  // If we have a prior idempotent result, skip semantic/facts upserts but keep episodic append
  if (priorResult) {
    return { ok: true, event_id: event.event_id, semantic_upserts: priorResult.semantic_upserts, facts_upserts: priorResult.facts_upserts };
  }

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
    const vec = USE_OS_PIPELINE ? undefined : await embed(text); // if using OS ingest pipeline, let it embed
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
  // Prefer SDK-provided params; only normalize if missing/empty
  const incoming = (req as any)?.params;
  let normalizedParams: any = undefined;

  // Detect when req.params is actually the SDK envelope (not user arguments)
  const looksLikeEnvelope =
    incoming && typeof incoming === "object" &&
    ("sendRequest" in incoming || "requestInfo" in incoming || "sessionId" in incoming || "signal" in incoming || "_meta" in incoming);

  if (incoming && typeof incoming === "object" && Object.keys(incoming).length > 0 && !looksLikeEnvelope) {
    // params already looks like plain user args
    normalizedParams = incoming;
  } else if (incoming && looksLikeEnvelope) {
    // Extract from the envelope first
    normalizedParams = normalizeParamsContainer(incoming);
  }

  // Fallback: extract from the whole request envelope (req.arguments, req.requestInfo, etc.)
  if (!normalizedParams || Object.keys(normalizedParams || {}).length === 0) {
    normalizedParams = normalizeParamsContainer(req);
  }


  (req as any).params = normalizedParams;

  // Early trace to confirm entry into handler (post-normalization)
  try {
    const hasParams = normalizedParams && typeof normalizedParams === "object" && Object.keys(normalizedParams).length > 0;
    traceWrite("retrieve.enter", { hasParams, keys: Object.keys((req as any)?.params || []), objective: String((req as any)?.params?.objective ?? "") });
  } catch {
    // ignore
  }
  // Log a compact sample of normalized params to verify objective/budget/filters visibility
  try {
    const p: any = (req as any)?.params || {};
    const hasObjective = typeof (p as any)?.objective !== "undefined";
    const hasBudget = typeof (p as any)?.budget !== "undefined";
    const hasFilters = typeof (p as any)?.filters !== "undefined";
    traceWrite("retrieve.params", {
      hasObjective,
      hasBudget,
      hasFilters,
      objectiveType: typeof p.objective,
      budgetType: typeof p.budget,
      filtersType: typeof p.filters,
      objectivePreview: typeof p.objective === "string" ? String(p.objective).slice(0, 120) : null
    });
  } catch {
    // ignore
  }

// Additional deep-diagnostic to detect non-plain argument containers
  try {
    const rp: any = (req as any);
    const diag: any = {
      hasReqParamsKey: Object.prototype.hasOwnProperty.call(rp, "params"),
      typeReqParams: typeof rp?.params,
      hasReqArgumentsKey: Object.prototype.hasOwnProperty.call(rp, "arguments"),
      typeReqArguments: typeof rp?.arguments,
      hasReqRequestInfo: Object.prototype.hasOwnProperty.call(rp, "requestInfo"),
      typeReqRequestInfo: typeof rp?.requestInfo
    };
    traceWrite("retrieve.diag", diag);
  } catch {
    // ignore
  }

  // Trace around context acquisition to diagnose early exits
  try {
    traceWrite("retrieve.pre_context", {});
  } catch { /* ignore */ void 0; }

  const active: Context = requireContext();
  try { traceWrite("retrieve.post_context", {}); } catch { /* ignore */ void 0; }

  const q = req.params as RetrievalQuery;
  const q2 = q as RetrievalQuery;

  const budget = q2.budget ?? DEFAULT_BUDGET;
  const t0 = Date.now();

  // Checkpoint before begin to confirm q2 content
  try {
    traceWrite("retrieve.ckpt", {
      stage: "pre_begin",
      qKeys: Object.keys(q2 || {}),
      objectivePreview: typeof q2.objective === "string" ? q2.objective.slice(0, 120) : null
    });
  } catch {
    // ignore
  }

  log("retrieve.begin", { budget, scopes: q2.filters?.scope ?? ["this_task", "project"] });
  traceWrite("retrieve.begin", { budget, scopes: q2.filters?.scope ?? ["this_task", "project"], objective: q2.objective });

  // Checkpoint after begin
  try {
    traceWrite("retrieve.ckpt", { stage: "post_begin" });
  } catch {
    // ignore
  }

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
    recent_days: getPolicy("stages.episodic.filters.recent_days", 30)
  };

  // Stage A: Episodic (BM25 / match)
  const tE = Date.now();
  const episodicHits = await episodicSearch(q2, fopts);
  log("stage.episodic", { hits: episodicHits.length, tookMs: Date.now() - tE });

  // Stage B: Semantic (k-NN + filters)
  const tS = Date.now();
  const semanticHits = await semanticSearch(q2, fopts);
  log("stage.semantic", { hits: semanticHits.length, tookMs: Date.now() - tS });

  // Stage C: Facts (1–2 hop expansion)
  const tF = Date.now();
  const factHits = await factsSearch(q2, fopts);
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
        enabled: !isTemporalQuery(q2.objective),
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
    fused = await crossRerank(q2.objective, fused, {
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
  traceWrite("retrieve.end", { totalMs: Date.now() - t0, snippets: snippets.length });
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
  // Diagnostic entry trace to verify function execution
  try {
    traceWrite("episodic.enter", { objective: q.objective });
    const hbDir = path.join(process.cwd(), "outputs", "memora", "trace");
    fs.mkdirSync(hbDir, { recursive: true });
    fs.appendFileSync(
      path.join(hbDir, "heartbeat.ndjson"),
      JSON.stringify({ ts: new Date().toISOString(), event: "episodic.enter" }) + "\n"
    );
  } catch {
    // ignore
  }
  // Build lexical multi_match with optional shingles/keyword subfields and guardrails
  const useShingles = retrievalBoolean("lexical.use_shingles", true);
  const fields = [
    "content^3",
    ...(useShingles ? ["content.shingles^1.2"] : [])
  ];
  const mmType = retrievalString("lexical.multi_match_type", "best_fields");
  const tieBreaker = retrievalNumber("lexical.tie_breaker", 0.3);
  const msmPct = retrievalNumber("lexical.min_should_match_pct", 60);
  const isTemporal = isTemporalQuery(String(q.objective ?? ""));
  const msm = isTemporal ? null : computedMinShouldMatch(String(q.objective ?? ""), msmPct);

  const mmClause: any = {
    multi_match: {
      query: q.objective,
      type: mmType,
      fields,
      tie_breaker: tieBreaker,
      lenient: true,
      ...(msm ? { minimum_should_match: msm } : {})
    }
  };

  // Episodic docs do not include env/api_version or scope; tailor filters accordingly
  const eopts: FilterOptions = {
    tenant_id: fopts.tenant_id,
    project_id: fopts.project_id,
    // Relax episodic filters: try task_id-only to compare
    // context_id: fopts.context_id,
    task_id: fopts.task_id,
    tags: fopts.tags,
    exclude_tags: fopts.exclude_tags,
    recent_days: fopts.recent_days
  };
  const filter = buildBoolFilter(eopts);

  // Optional time decay on ts
  const tdEnabled = retrievalBoolean("time_decay.enabled", false);
  const tdHalfLife = retrievalNumber("time_decay.episodic.half_life_days", 45);
  const tdWeight = retrievalNumber("time_decay.episodic.weight", 0.25);

  const shouldClauses: any[] = isTemporal
    ? [
        {
          simple_query_string: {
            query:
              "day OR days OR week OR weeks OR month OR months OR jan* OR feb* OR mar* OR apr* OR may OR jun* OR jul* OR aug* OR sep* OR oct* OR nov* OR dec* OR /",
            fields: ["content^1", "content.raw^0.5"]
          }
        }
      ]
    : [];
  const boolQuery: any = isTemporal
    ? {
        bool: {
          // For temporal queries, allow either the question tokens OR date/number patterns to match
          should: [mmClause, ...shouldClauses],
          minimum_should_match: 1,
          must: filter.bool.must || [],
          filter: filter.bool.filter,
          must_not: filter.bool.must_not
        }
      }
    : {
        bool: {
          must: [mmClause, ...(filter.bool.must || [])],
          ...(shouldClauses.length ? { should: shouldClauses } : {}),
          filter: filter.bool.filter,
          must_not: filter.bool.must_not
        }
      };

  const body = tdEnabled ? {
    size: getPolicy("stages.episodic.top_k", 25),
    query: {
      function_score: {
        query: boolQuery,
        score_mode: "multiply",
        boost_mode: "multiply",
        functions: [{
          gauss: {
            ts: { origin: "now", scale: `${Math.max(1, tdHalfLife)}d`, decay: 0.5 }
          },
          weight: tdWeight
        }]
      }
    }
  } : {
    size: getPolicy("stages.episodic.top_k", 25),
    query: boolQuery
  };

  {
    const sizeForLog = getPolicy("stages.episodic.top_k", 25);
    try {
      const payload = {
        prefix: EPISODIC_PREFIX,
        index: `${EPISODIC_PREFIX}*`,
        isTemporal,
        tdEnabled,
        size: sizeForLog,
        filter: filter.bool,
        query: boolQuery
      };
      log("episodic.request", payload);
      traceWrite("episodic.request", payload);
    } catch {
      // best-effort logging
    }
  }
  const resp = await searchWithRetries({ index: `${EPISODIC_PREFIX}*`, body });
  {
    try {
      const hits: any[] = resp?.body?.hits?.hits || [];
      traceWrite("episodic.response", {
        took: resp?.body?.took,
        total: (resp?.body?.hits as any)?.total ?? null,
        count: hits.length,
        sample: hits.slice(0, 3).map(h => ({ id: h?._id, score: h?._score }))
      });
    } catch {
      // best-effort logging
    }
  }
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

  const tdEnabled = retrievalBoolean("time_decay.enabled", false);
  const halfLife = retrievalNumber("time_decay.semantic.half_life_days", 45);
  const weight = retrievalNumber("time_decay.semantic.weight", 0.15);

  return hits.map((hit: any, i: number) => {
    const baseScore = hit._score ?? 0;
    const lu: string | undefined = hit._source?.last_used;
    const decay = tdEnabled ? recencyFactor(lu, halfLife) : 0;
    const adj = baseScore * (1 + weight * decay);
    return {
      id: `mem:${hit._id}`,
      text: hit._source?.text || "",
      score: tdEnabled ? adj : baseScore,
      rank: i + 1,
      source: "semantic" as const,
      tags: hit._source?.tags || [],
      why: "semantic: vector similarity",
      meta: { embedding: hit._source?.embedding, last_used: lu }
    };
  });
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
 * Compute minimum_should_match guardrail string like "60%" for queries with 4+ terms.
 * Returns null when not applied.
 */
function computedMinShouldMatch(q: string, pct: number): string | null {
  // If pct <= 0, disable MSM entirely (diagnostic mode from retrieval.yaml)
  if (!(pct > 0)) return null;
  const terms = q
    .toLowerCase()
    .replace(/[^a-z0-9_./:-]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (terms.length >= 4) {
    const p = Math.max(1, Math.min(100, Math.floor(pct)));
    return `${p}%`;
  }
  return null;
}

/** Heuristic: detect temporal counting questions where MMR should be disabled and date-bearing text boosted */
function isTemporalQuery(q: string | undefined): boolean {
  const s = (q || "").toLowerCase();
  return /\b(how many days?|days? between|how long|number of days?|time difference|days? from|days? until|how many weeks?)\b/.test(s);
}

/**
 * Recency factor in [0,1], where 1 means "now", 0.5 at half-life in days.
 * Missing/invalid timestamps return 0 (no boost).
 */
function recencyFactor(isoTs: string | null | undefined, halfLifeDays: number): number {
  if (!isoTs) return 0;
  const t = new Date(isoTs).getTime();
  if (!Number.isFinite(t)) return 0;
  const now = Date.now();
  const ageMs = Math.max(0, now - t);
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  const hl = Math.max(1e-6, halfLifeDays);
  // Exponential decay with half-life
  const factor = Math.pow(0.5, ageDays / hl);
  // Bound to [0,1]
  return Math.max(0, Math.min(1, factor));
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
  return { ...res, written: true };
}

/**
 * memory.retrieve_and_pack
 * Retrieves snippets and returns a packed prompt using config/packing.yaml.
 * Accepts optional sections: system, task_frame, tool_state, recent_turns (strings).
 */
async function handleRetrieveAndPack(req: any) {
  // Normalize MCP tool arguments
  (req as any).params = normalizeParamsContainer(req);
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
  // Normalize MCP tool arguments
  (req as any).params = normalizeParamsContainer(req);
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
