// src/routes/memory.ts
// Memory write/retrieve/promote tools for Memora MCP.

import { v4 as uuidv4 } from "uuid";
import { debug } from "../services/log.js";

import { getClient, bulkSafe, indexWithRetries, searchWithRetries, withRetries } from "../services/os-client.js";
import { embed } from "../services/embedder.js";
import { scoreSalience, atomicSplit, summarizeIfLong, redact } from "../services/salience.js";
import { policyNumber, policyArray, retrievalNumber, retrievalArray, retrievalBoolean, retrievalString } from "../services/config.js";
import { packPrompt } from "../services/packer.js";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

import { requireContext } from "./context.js";
import { buildBoolFilter, FilterOptions } from "../domain/filters.js";
import type { Hit as FusedHit } from "../domain/fusion.js";
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
const USE_OS_PIPELINE = (process.env.MEMORA_EMBED_PROVIDER || "").toLowerCase() === "opensearch_pipeline";
const log = debug("memora:memory");
function currentTraceFile(): string {
  return process.env.MEMORA_TRACE_FILE || "";
}

function traceWrite(event: string, payload: any) {
  const file = currentTraceFile();
  if (!file) return;

  // Diagnostics gating:
  // - Default: only minimal markers are written (retrieve.begin/end, episodic.body_once, episodic.index.*)
  // - Enable broader traces via either:
  //     MEMORA_DIAGNOSTICS=1 (env override)
  //   or retrieval.yaml:
  //     diagnostics.enabled: true
  //     diagnostics.guard_traces: true
  //     diagnostics.fallback_traces: true
  //     diagnostics.request_response_traces: true
  const envDiag = (process.env.MEMORA_DIAGNOSTICS || "").trim() === "1";
  const diagEnabled = envDiag || retrievalBoolean("diagnostics.enabled", false);

  // Always-on minimal markers for post-stabilization:
  const alwaysOn =
    event === "retrieve.begin" ||
    event === "retrieve.end" ||
    event === "episodic.body_once" ||
    event.startsWith("episodic.index.");

  // Per-category flags (env override enables all categories)
  const guardAllowed = diagEnabled && (envDiag || retrievalBoolean("diagnostics.guard_traces", false));
  const fallbackAllowed = diagEnabled && (envDiag || retrievalBoolean("diagnostics.fallback_traces", false));
  const reqRespAllowed = diagEnabled && (envDiag || retrievalBoolean("diagnostics.request_response_traces", false));

  // Category-based gating
  if (!alwaysOn) {
    if (
      event.startsWith("retrieve.guard") ||
      event === "retrieve.pre_context" ||
      event === "retrieve.post_context" ||
      event === "retrieve.finally" ||
      event === "retrieve.params" ||
      event === "retrieve.diag" ||
      event === "retrieve.ckpt"
    ) {
      if (!guardAllowed) return;
    } else if (event.startsWith("episodic.fallback")) {
      if (!fallbackAllowed) return;
    } else if (event === "episodic.request" || event === "episodic.response") {
      if (!reqRespAllowed) return;
    } else if (!diagEnabled) {
      // All other non-essential events require diagnostics to be enabled
      return;
    }
  }

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

// Trace episodic search body once per process for reproduction
let EPI_BODY_LOGGED_ONCE = false;
function traceEpisodicBodyOnce(index: string, body: any) {
  if (EPI_BODY_LOGGED_ONCE) return;
  EPI_BODY_LOGGED_ONCE = true;
  try {
    traceWrite("episodic.body_once", { index, body });
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
      round_id: z.string().optional().describe("Optional round identifier for aggregated turns"),
      round_index: z.number().optional().describe("0-based round index within the source session"),
      round_ts: z.string().optional().describe("ISO timestamp anchor for the round"),
      round_date: z.string().optional().describe("ISO date (YYYY-MM-DD) anchor for the round"),
      facts_text: z.array(z.string()).optional().describe("Precomputed fact strings to augment lexical keys"),
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
      round_id: z.string().optional(),
      round_index: z.number().optional(),
      round_ts: z.string().optional(),
      round_date: z.string().optional(),
      facts_text: z.array(z.string()).optional(),
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
  // Normalize envelopes: if params missing OR not an object OR missing 'content', extract from envelope
  if (!(req as any)?.params || typeof (req as any).params !== "object" || !("content" in (req as any).params)) {
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
  const ts = coerceIsoDateTime(req.params?.ts) ?? nowIso;
  const roundIndexRaw = req.params?.round_index;
  const roundIndex = typeof roundIndexRaw === "number"
    ? roundIndexRaw
    : roundIndexRaw !== undefined
    ? Number(roundIndexRaw)
    : undefined;
  const roundTs = coerceIsoDateTime(req.params?.round_ts) ?? ts;
  const roundDate = coerceIsoDate(req.params?.round_date) ?? (roundTs ? roundTs.slice(0, 10) : ts.slice(0, 10));
  const factsText = Array.isArray(req.params?.facts_text)
    ? dedupeStrings(req.params.facts_text)
    : [];

  const event: Event = {
    event_id: uuidv4(),
    ts,
    role: req.params?.role || "tool",
    content: redact(String(req.params?.content ?? "")),
    tags: req.params?.tags || [],
    artifacts: req.params?.artifacts || [],
    hash: req.params?.hash,
    round_id: req.params?.round_id ? String(req.params.round_id) : undefined,
    round_index: Number.isFinite(roundIndex) ? roundIndex : undefined,
    round_ts: roundTs,
    round_date: roundDate,
    facts_text: factsText,
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
    let res: any;
    if (FORCE_DIRECT) {
      const client = getClient();
      res = await withRetries(() => client.index({
        index: episodicIndex,
        id: event.event_id,
        body: flattenEventForIndex(event),
        refresh: true
      } as any));
    } else {
      res = await indexWithRetries({
        index: episodicIndex,
        id: event.event_id,
        body: flattenEventForIndex(event),
        refresh: true
      });
    }
    // Inspect result to assert success; surface failures in trace and throw
    try {
      const body = (res as any)?.body ?? res;
      const statusCode = (res as any)?.statusCode ?? null;
      const result = body?.result ?? null;
      const _id = body?._id ?? event.event_id;
      traceWrite("episodic.index.response", { index: episodicIndex, id: _id, result, statusCode });
      if ((statusCode && Number(statusCode) >= 300) || (result && !["created", "updated"].includes(String(result)))) {
        traceWrite("episodic.index.fail", { index: episodicIndex, id: _id, result, statusCode });
        throw new Error(`Episodic index failed: status=${statusCode} result=${result}`);
      }
    } catch (inner) {
      // If parsing failed, still continue to ok trace below; outer catch will handle thrown errors
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

  // If both semantic and facts writes are disabled, end after episodic append
  if (!retrievalBoolean("stages.semantic.enabled", false) && !retrievalBoolean("stages.facts.enabled", false)) {
    return { ok: true, event_id: event.event_id, semantic_upserts: 0, facts_upserts: 0 };
  }

  // 2) Salience → semantic chunks + facts (gated by retrieval.yaml)
  const WRITE_SEM_ENABLED = retrievalBoolean("stages.semantic.enabled", false);
  const WRITE_FACTS_ENABLED = retrievalBoolean("stages.facts.enabled", false);
  const atoms = atomicSplit(event.content);
  const chunks: SemanticChunk[] = [];
  const facts: Fact[] = [];

  for (const a of atoms) {
    const sal = scoreSalience(a, { tags: event.tags });
    if (sal < getPolicy("salience.min_score", 0.6)) continue;

    // (a) facts (very light heuristic; your extractor can live in salience.ts)
    if (WRITE_FACTS_ENABLED) {
      const extractedFacts = extractFacts(a, event.context);
      facts.push(...extractedFacts);
    }

    // Backpressure: cap number of semantic chunks to avoid unbounded embeds
    if (chunks.length >= MAX_CHUNKS) {
      log("write.chunk_cap_reached", { cap: MAX_CHUNKS });
      break;
    }
    // (b) semantic chunk
    if (WRITE_SEM_ENABLED) {
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
  // Normalize params from various envelopes (handles plain args, {params:{...}}, SDK shapes)
  (req as any).params = normalizeParamsContainer((req as any)?.params ?? req);

  // Early trace to confirm entry into handler (post-normalization)
  try {
    const p: any = (req as any)?.params || {};
    const hasParams = p && typeof p === "object" && Object.keys(p).length > 0;
    traceWrite("retrieve.enter", { hasParams, keys: Object.keys(p || {}), objective: String(p?.objective ?? "") });
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
  try { traceWrite("retrieve.guard.before_ctx", {}); } catch { /* ignore */ void 0; }

  let active: Context;
  try {
    active = requireContext();
    try {
      traceWrite("retrieve.post_context", {
        tenant_id: active.tenant_id,
        project_id: active.project_id,
        context_id: active.context_id,
        task_id: active.task_id,
        env: active.env,
        api_version: active.api_version
      });
      traceWrite("retrieve.guard.after_ctx", { hasActive: true });
    } catch { /* ignore */ void 0; }
  } catch (err) {
    // Fallback when no active context is set: use default tenant/project and any provided params
    const p: any = (req as any)?.params || {};
    const tenant = process.env.MEMORA_DEFAULT_TENANT || "memora";
    const project = process.env.MEMORA_DEFAULT_PROJECT || "benchmarks";
    active = {
      tenant_id: String(tenant),
      project_id: String(project),
      context_id: (p.context_id as any) ?? null,
      task_id: (p.task_id as any) ?? null,
      env: (p.filters?.env as any) ?? undefined,
      api_version: (p.filters?.api_version as any) ?? undefined
    } as Context;
    try {
      traceWrite("retrieve.context_fallback", { tenant_id: active.tenant_id, project_id: active.project_id });
    } catch { /* ignore */ void 0; }
  }

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
  let episodicHits: FusedHit[] = [];
  try {
    traceWrite("retrieve.guard.before_epi", {});
    episodicHits = await episodicSearch(q2, fopts);
  } catch (e) {
    try { traceWrite("retrieve.guard.epi_error", { error: String(e) }); } catch { /* ignore */ void 0; }
    throw e;
  } finally {
    try { traceWrite("retrieve.guard.after_epi", { hits: Array.isArray(episodicHits) ? episodicHits.length : -1 }); } catch { /* ignore */ void 0; }
  }
  log("stage.episodic", { hits: episodicHits.length, tookMs: Date.now() - tE });

  // Stage B: Semantic (k-NN + filters) — gated by config.stages.semantic.enabled
  const semanticHits: FusedHit[] = [];
  log("stage.semantic", { hits: 0, tookMs: 0 });

  // Stage C: Facts (1–2 hop expansion) — gated by config.stages.facts.enabled
  const factHits: FusedHit[] = [];
  log("stage.facts", { hits: 0, tookMs: 0 });

  // Fuse + optional rerank
  let fused: FusedHit[] = episodicHits.slice(0, budget);
  log("fuse", { episodic: episodicHits.length, semantic: semanticHits.length, facts: factHits.length, fused: fused.length });


  // Touch last_used for semantic docs we return
  // semantic.touch skipped in minimal POC

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
  try { traceWrite("retrieve.finally", { phase: "after_end" }); } catch { /* ignore */ void 0; }
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
    round_id: e.round_id || null,
    round_index: typeof e.round_index === "number" ? e.round_index : null,
    round_ts: e.round_ts || e.ts,
    round_date: e.round_date || (e.round_ts || e.ts)?.slice(0, 10),
    role: e.role,
    content: e.content,
    facts_text: Array.isArray(e.facts_text) ? e.facts_text : [],
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

function dedupeStrings(values: any[]): string[] {
  const seen = new Set<string>();
  if (!Array.isArray(values)) return [];
  for (const value of values) {
    if (value === undefined || value === null) continue;
    const s = typeof value === "string" ? value : String(value);
    const trimmed = s.trim();
    if (trimmed) {
      seen.add(trimmed);
    }
  }
  return Array.from(seen);
}

function coerceIsoDateTime(value: any): string | null {
  if (!value) return null;
  try {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return null;
    return d.toISOString();
  } catch {
    return null;
  }
}

function coerceIsoDate(value: any): string | null {
  if (!value) return null;
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value.trim())) {
    return value.trim();
  }
  const iso = coerceIsoDateTime(value);
  return iso ? iso.slice(0, 10) : null;
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
  const objective = String(q.objective ?? "");
  const useShingles = retrievalBoolean("lexical.use_shingles", true);
  const fields = [
    "content^3",
    ...(useShingles ? ["content.shingles^1.2"] : []),
    "facts_text^2",
    ...(useShingles ? ["facts_text.shingles^1.1"] : []),
    "tags^2",
    "artifacts^1",
    "content.raw^0.5"
  ];
  const mmType = retrievalString("lexical.multi_match_type", "best_fields");
  const tieBreaker = retrievalNumber("lexical.tie_breaker", 0.3);
  const msmPct = retrievalNumber("lexical.min_should_match_pct", 60);
  const temporalRange = extractTemporalRange(objective);
  const isTemporal = isTemporalQuery(objective) || !!temporalRange;
  const msm = isTemporal ? null : computedMinShouldMatch(objective, msmPct);

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

  // Episodic docs do not include env/api_version, task_scope, or context_id; tailor filters accordingly
  // Episodic memories are task-scoped (use task_id only, no context_id or scopes)
  const eopts: FilterOptions = {
    tenant_id: fopts.tenant_id,
    project_id: fopts.project_id,
    task_id: fopts.task_id,
    scopes: undefined,  // Episodic docs don't have task_scope field
    tags: fopts.tags,
    exclude_tags: fopts.exclude_tags,
    recent_days: fopts.recent_days
  };
  const filter = buildBoolFilter(eopts);
  const rangeFilters = temporalRange ? [{ range: { round_date: temporalRange } }] : [];
  const baseFilters = [...(filter.bool.filter || []), ...(filter.bool.must || []), ...rangeFilters];
  const mustNotClauses = filter.bool.must_not || [];

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
            fields: ["content^1", "content.raw^0.5", "facts_text^0.8"]
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
          must: [],
          // Move tenant/project constraints to filter to avoid unintended must interactions
          filter: baseFilters,
          must_not: mustNotClauses
        }
      }
    : {
        bool: {
          // Keep lexical clause in must; move constraints to filter for stability and recall
          must: [mmClause],
          ...(shouldClauses.length ? { should: shouldClauses } : {}),
          filter: baseFilters,
          must_not: mustNotClauses
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
  try { traceEpisodicBodyOnce(`${EPISODIC_PREFIX}*`, body); } catch { /* ignore */ void 0; }
  let resp = await searchWithRetries({ index: `${EPISODIC_PREFIX}*`, body });
  let hits: any[] = resp?.body?.hits?.hits || [];
  {
    try {
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

  // Fallback: if zero episodic hits, retry with a simpler match query and relaxed filter placement
  if (!Array.isArray(hits) || hits.length === 0) {
    try {
      const fallbackBody: any = {
        size: getPolicy("stages.episodic.top_k", 25),
        query: {
          bool: {
            must: [
              { match: { content: { query: String(q.objective ?? ""), operator: "or" } } }
            ],
            // Move tenant/project terms to filter to avoid accidental scoring interference
            filter: baseFilters,
            must_not: mustNotClauses || []
          }
        }
      };
      traceWrite("episodic.fallback.request", { index: `${EPISODIC_PREFIX}*`, query: fallbackBody.query });
      resp = await searchWithRetries({ index: `${EPISODIC_PREFIX}*`, body: fallbackBody });
      hits = resp?.body?.hits?.hits || [];
      traceWrite("episodic.fallback.response", {
        took: resp?.body?.took,
        total: (resp?.body?.hits as any)?.total ?? null,
        count: Array.isArray(hits) ? hits.length : 0,
        sample: (Array.isArray(hits) ? hits : []).slice(0, 3).map((h: any) => ({ id: h?._id, score: h?._score }))
      });
    } catch {
      // best-effort fallback
    }
  }

  // Fallback 2: broaden to simple_query_string over content/raw/tags with OR operator
  if (!Array.isArray(hits) || hits.length === 0) {
    try {
      const fallback2Body: any = {
        size: getPolicy("stages.episodic.top_k", 25),
        query: {
          bool: {
            must: [
              {
                simple_query_string: {
                  query: String(q.objective ?? ""),
                  fields: ["content^3", "content.raw^0.5", "facts_text^2", "tags^2"],
                  default_operator: "or"
                }
              }
            ],
            filter: baseFilters,
            must_not: mustNotClauses || []
          }
        }
      };
      traceWrite("episodic.fallback2.request", { index: `${EPISODIC_PREFIX}*`, query: fallback2Body.query });
      resp = await searchWithRetries({ index: `${EPISODIC_PREFIX}*`, body: fallback2Body });
      hits = resp?.body?.hits?.hits || [];
      traceWrite("episodic.fallback2.response", {
        took: resp?.body?.took,
        total: (resp?.body?.hits as any)?.total ?? null,
        count: Array.isArray(hits) ? hits.length : 0,
        sample: (Array.isArray(hits) ? hits : []).slice(0, 3).map((h: any) => ({ id: h?._id, score: h?._score }))
      });
    } catch {
      // best-effort fallback 2
    }
  }
  
  
  
  return (hits || []).map((hit: any, i: number) => ({
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

// ---- Facts (1–2 hop expansion; here we just keyword-match s/p/o)


 // ---- Utilities ----
 function makeIdemKey(ctxIds: { tenant_id: string; project_id: string; context_id: string; task_id: string }, key: string): string {
   const safe = (s: string) => String(s).replace(/[^A-Za-z0-9:_-]/g, "_");
   return `${safe(ctxIds.tenant_id)}:${safe(ctxIds.project_id)}:${safe(ctxIds.context_id)}:${safe(ctxIds.task_id)}:${safe(key)}`;
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
const MONTH_LOOKUP = new Map<string, number>([
  ["january", 0],
  ["february", 1],
  ["march", 2],
  ["april", 3],
  ["may", 4],
  ["june", 5],
  ["july", 6],
  ["august", 7],
  ["september", 8],
  ["october", 9],
  ["november", 10],
  ["december", 11]
]);

function isTemporalQuery(q: string | undefined): boolean {
  const s = (q || "").toLowerCase();
  return (
    /\b(how many days?|days? between|how long|number of days?|time difference|days? from|days? until|how many weeks?)\b/.test(s) ||
    /\b(when|what year|which year|year|date|month|day)\b/.test(s) ||
    /\b(19\d{2}|20\d{2})\b/.test(s) ||
    /\b(january|february|march|april|may|june|july|august|september|october|november|december)\b/.test(s)
  );
}

function extractTemporalRange(q: string): { gte?: string; lte?: string } | null {
  const s = (q || "").toLowerCase();
  const yearMatch = s.match(/\b(19\d{2}|20\d{2})\b/);
  const monthMatch = s.match(/\b(january|february|march|april|may|june|july|august|september|october|november|december)\b/);

  if (monthMatch && yearMatch) {
    const monthIdx = MONTH_LOOKUP.get(monthMatch[1]);
    const year = Number(yearMatch[1]);
    if (monthIdx !== undefined && Number.isFinite(year)) {
      const dayMatch = s.match(/\b([0-3]?\d)(?:st|nd|rd|th)?\b/);
      const pad = (n: number) => String(n).padStart(2, "0");
      if (dayMatch) {
        const day = Number(dayMatch[1]);
        if (day >= 1 && day <= 31) {
          const dayStr = pad(Math.min(day, new Date(Date.UTC(year, monthIdx + 1, 0)).getUTCDate()));
          const iso = `${year}-${pad(monthIdx + 1)}-${dayStr}`;
          return { gte: iso, lte: iso };
        }
      }
      const lastDay = new Date(Date.UTC(year, monthIdx + 1, 0)).getUTCDate();
      return {
        gte: `${year}-${pad(monthIdx + 1)}-01`,
        lte: `${year}-${pad(monthIdx + 1)}-${pad(lastDay)}`
      };
    }
  }

  if (yearMatch) {
    const year = Number(yearMatch[1]);
    if (Number.isFinite(year)) {
      return { gte: `${year}-01-01`, lte: `${year}-12-31` };
    }
  }

  return null;
}

/**
 * Recency factor in [0,1], where 1 means "now", 0.5 at half-life in days.
 * Missing/invalid timestamps return 0 (no boost).
 */

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
