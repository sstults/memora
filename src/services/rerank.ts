// src/services/rerank.ts
// Optional cross-encoder (or LLM) reranking for retrieved candidates.
//
// Env:
//   RERANK_ENDPOINT (e.g., http://localhost:8081/rerank)
//   RERANK_API_KEY   (optional, adds Authorization: Bearer <key>)
//   RERANK_TIMEOUT_MS=1500
//   RERANK_MAX_RETRIES=2
//
// Protocol (expected by default):
//   POST RERANK_ENDPOINT
//   body: { query: string, candidates: { id: string, text: string }[], model?: string }
//   resp: { scores: number[] }  // higher is better, same length as candidates
//
// If no endpoint is set or it fails, we fall back to a simple local reranker:
//   - Lexical overlap (Jaccard on token sets) between query & candidate text
//   - If embeddings are present in hit.meta.embedding, blend with cosine

import { Hit as FusedHit } from "../domain/fusion.js";
import { debug } from "./log.js";
import { predictRerankScores } from "./os-ml.js";
import { retrievalBoolean } from "./config.js";

export interface RerankOptions {
  maxCandidates?: number;  // default 64
  budgetMs?: number;       // overall latency guard (best-effort)
  model?: string;          // sent to the endpoint
}

const ENDPOINT = process.env.RERANK_ENDPOINT;
const API_KEY = process.env.RERANK_API_KEY || "";
const TIMEOUT_MS = numFromEnv("RERANK_TIMEOUT_MS", 1500);
const MAX_RETRIES = numFromEnv("RERANK_MAX_RETRIES", 2);
const OS_RERANK_MODEL_ID = process.env.OPENSEARCH_ML_RERANK_MODEL_ID;
const OS_RERANK_TIMEOUT_MS = numFromEnv("OPENSEARCH_ML_RERANK_TIMEOUT_MS", TIMEOUT_MS);
const log = debug("memora:rerank");
// Rerank gating: env override if set, else fall back to retrieval.yaml (rerank.enabled)
const ENV_RERANK = process.env.MEMORA_RERANK_ENABLED;
const ENABLED = ENV_RERANK ? ENV_RERANK.toLowerCase() === "true" : retrievalBoolean("rerank.enabled", false);

export async function crossRerank(
  query: string,
  hits: FusedHit[],
  opts: RerankOptions = {}
): Promise<FusedHit[]> {
  const maxC = Math.min(opts.maxCandidates ?? 64, 128);
  const candidates = hits.slice(0, maxC);
  if (candidates.length <= 1) return hits;
  if (!ENABLED) {
    log("disabled", { reason: "MEMORA_RERANK_ENABLED=false" });
    return hits;
  }

  const started = Date.now();
  log("begin", { hits: hits.length, candidates: candidates.length, maxC, budgetMs: opts.budgetMs ?? TIMEOUT_MS, endpoint: Boolean(ENDPOINT) });

  // OpenSearch ML cross-encoder rerank if configured
  if (OS_RERANK_MODEL_ID) {
    try {
      const r0 = Date.now();
      const scores = await predictRerankScores({
        modelId: OS_RERANK_MODEL_ID,
        query,
        texts: candidates.map(c => c.text || ""),
        timeoutMs: Math.max(250, Math.min(OS_RERANK_TIMEOUT_MS, opts.budgetMs ?? OS_RERANK_TIMEOUT_MS))
      });

      const reweighted = candidates.map((c, i) => ({
        ...c,
        score: isFiniteNumber(scores[i]) ? scores[i] : c.score
      }));
      log("osml.ok", { tookMs: Date.now() - r0, candidates: candidates.length });

      const fusedIds = new Set(reweighted.map(r => r.id));
      const tail = hits.filter(h => !fusedIds.has(h.id));
      reweighted.sort((a, b) => b.score - a.score);
      const delta = rankDeltaStats(candidates, reweighted);
      log("osml.delta", delta);
      log("osml.end", { totalMs: Date.now() - started, out: reweighted.length });
      return [...reweighted, ...tail];
    } catch (err) {
      log("osml.error", { message: (err as Error).message });
      console.warn(`[rerank] OpenSearch ML rerank failed: ${(err as Error).message}. Falling back.`);
    }
  }

  // Remote rerank if configured
  if (ENDPOINT) {
    try {
      const r0 = Date.now();
      const scores = await callRemoteRerank(
        ENDPOINT,
        {
          query,
          candidates: candidates.map(c => ({ id: c.id, text: c.text || "" })),
          model: opts.model
        },
        Math.max(250, Math.min(TIMEOUT_MS, opts.budgetMs ?? TIMEOUT_MS))
      );

      // Attach new scores and sort
      const reweighted = candidates.map((c, i) => ({
        ...c,
        score: isFiniteNumber(scores[i]) ? scores[i] : c.score
      }));
      log("remote.ok", { tookMs: Date.now() - r0, candidates: candidates.length });

      const fusedIds = new Set(reweighted.map(r => r.id));
      const tail = hits.filter(h => !fusedIds.has(h.id));
      reweighted.sort((a, b) => b.score - a.score);
      const delta = rankDeltaStats(candidates, reweighted);
      log("remote.delta", delta);
      log("remote.end", { totalMs: Date.now() - started, out: reweighted.length });
      return [...reweighted, ...tail];
    } catch (err) {
      // Fall through to local fallback if remote fails or times out
      log("remote.error", { message: (err as Error).message });
      console.warn(`[rerank] remote rerank failed: ${(err as Error).message}. Falling back.`);
    }
  }

  // Local fallback rerank (fast & deterministic)
  const l0 = Date.now();
  const local = localRerank(query, candidates);
  const localIds = new Set(local.map(r => r.id));
  const tail = hits.filter(h => !localIds.has(h.id));
  const budgetLeft = (opts.budgetMs ?? TIMEOUT_MS) - (Date.now() - started);
  log("local", { tookMs: Date.now() - l0, candidates: candidates.length, budgetLeft });
  const delta = rankDeltaStats(candidates, local);
  log("local.delta", delta);
  // If we already blew the budget, just return; otherwise concatenate.
  return budgetLeft <= 0 ? hits : [...local, ...tail];
}

// ----------------------------
// Remote calling helpers
// ----------------------------

async function callRemoteRerank(
  endpoint: string,
  payload: any,
  timeoutMs: number
): Promise<number[]> {
  let lastErr: any;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), timeoutMs);
      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {})
        },
        body: JSON.stringify(payload),
        signal: ctrl.signal
      }).finally(() => clearTimeout(t));

      if (!res.ok) {
        const txt = await safeText(res);
        throw new Error(`HTTP ${res.status}: ${txt.slice(0, 200)}`);
      }
      const data = await res.json() as { scores?: number[] };
      if (!data?.scores || !Array.isArray(data.scores) || data.scores.length !== payload.candidates.length) {
        throw new Error("Malformed rerank response: missing or invalid 'scores'");
      }
      return data.scores.map(n => (isFiniteNumber(n) ? n : 0));
    } catch (e) {
      lastErr = e;
      if (attempt === MAX_RETRIES) break;
      await sleep(backoffMs(attempt));
    }
  }
  throw new Error(`rerank endpoint failed after ${MAX_RETRIES + 1} attempts: ${String(lastErr)}`);
}

function backoffMs(attempt: number): number {
  const base = 120;
  const jitter = Math.floor(Math.random() * 80);
  return Math.min(1500, base * Math.pow(2, attempt)) + jitter;
}

function sleep(ms: number) {
  return new Promise(res => setTimeout(res, ms));
}

async function safeText(res: Response): Promise<string> {
  try { return await res.text(); } catch { return ""; }
}

// ----------------------------
// Local fallback reranker
// ----------------------------

function localRerank(query: string, hits: FusedHit[]): FusedHit[] {
  const qTokens = tokenize(query);
  const qVec = averageEmbeddingFromHits(hits); // if none present, undefined

  // Score each hit by blended lexical + embedding cosine (if embeddings exist)
  const rescored = hits.map(h => {
    const lex = jaccard(qTokens, tokenize(h.text || ""));
    const cos = cosine(qVec, (h.meta?.embedding as number[] | undefined));
    const blended = isFiniteNumber(cos) ? (0.7 * lex + 0.3 * cos) : lex;
    return { ...h, score: blended };
  });

  rescored.sort((a, b) => b.score - a.score);
  return rescored;
}

function tokenize(s: string): Set<string> {
  return new Set(
    (s || "")
      .toLowerCase()
      .replace(/[^a-z0-9_./:-]+/g, " ")
      .trim()
      .split(/\s+/)
      .filter(w => w.length > 1 && w !== "the" && w !== "and")
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = a.size + b.size - inter;
  return inter / union;
}

function cosine(a?: number[], b?: number[]): number {
  if (!a || !b || a.length !== b.length || a.length === 0) return NaN;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (na === 0 || nb === 0) return NaN;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** If no per-hit embedding, approximate with the mean of available ones (or undefined). */
function averageEmbeddingFromHits(hits: FusedHit[]): number[] | undefined {
  let sum: number[] | null = null;
  let count = 0;
  for (const h of hits) {
    const v = h.meta?.embedding as number[] | undefined;
    if (!v) continue;
    if (!sum) sum = new Array(v.length).fill(0);
    for (let i = 0; i < v.length; i++) sum[i] += v[i];
    count++;
  }
  if (!sum || count === 0) return undefined;
  for (let i = 0; i < sum.length; i++) sum[i] /= count;
  return sum;
}

/**
 * Compute simple rank delta diagnostics comparing original candidate order vs new order.
 * Reports topBefore/After, movedUp/Down/Unchanged counts, avg/max absolute position delta.
 */
function rankDeltaStats(original: FusedHit[], reranked: FusedHit[]) {
  const oldPos = new Map<string, number>();
  original.forEach((h, i) => oldPos.set(h.id, i));
  let movedUp = 0, movedDown = 0, unchanged = 0;
  let sumAbs = 0, maxAbs = 0;
  for (let i = 0; i < reranked.length; i++) {
    const id = reranked[i].id;
    const was = oldPos.get(id);
    if (was == null) continue;
    const delta = was - i;
    if (delta > 0) movedUp++;
    else if (delta < 0) movedDown++;
    else unchanged++;
    const abs = Math.abs(delta);
    sumAbs += abs;
    if (abs > maxAbs) maxAbs = abs;
  }
  const avgAbs = reranked.length ? +(sumAbs / reranked.length).toFixed(3) : 0;
  return {
    topBefore: original[0]?.id,
    topAfter: reranked[0]?.id,
    movedUp,
    movedDown,
    unchanged,
    avgAbsDelta: avgAbs,
    maxAbsDelta: maxAbs
  };
}

// ----------------------------
// Utils
// ----------------------------

function numFromEnv(k: string, dflt: number): number {
  const v = Number(process.env[k]);
  return Number.isFinite(v) ? v : dflt;
}

function isFiniteNumber(n: any): n is number {
  return typeof n === "number" && Number.isFinite(n);
}
