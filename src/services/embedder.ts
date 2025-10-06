/* src/services/embedder.ts
   Minimal embedding client with a deterministic local fallback.
   - If EMBEDDING_ENDPOINT is set, POSTs {texts, dim} and expects {vectors: number[][]}.
   - Otherwise, uses a hash-based fallback to produce stable pseudo-embeddings.
   Vectors are L2-normalized.
*/

import fs from "node:fs";
import path from "node:path";

const ENDPOINT = process.env.EMBEDDING_ENDPOINT; // e.g., http://localhost:8080/embed
const API_KEY = process.env.EMBEDDING_API_KEY || "";
const DIM = Number(process.env.MEMORA_EMBED_DIM || 384);
const TIMEOUT_MS = Number(process.env.MEMORA_EMBED_TIMEOUT_MS || 8000);
const MAX_RETRIES = Number(process.env.MEMORA_EMBED_RETRIES || 3);
const PROVIDER = (process.env.MEMORA_EMBED_PROVIDER || "").toLowerCase();
const OS_URL = process.env.OPENSEARCH_URL || "http://localhost:19200";

// Resolve OpenSearch ML model id from env or cache file (written by os-ml.ts)
function getModelIdCachePath(): string {
  const p = process.env.MEMORA_OS_MODEL_ID_CACHE_FILE || ".memora/model_id";
  try {
    return path.resolve(process.cwd(), p);
  } catch {
    return p;
  }
}
function readCachedModelId(): string | undefined {
  try {
    const p = getModelIdCachePath();
    if (fs.existsSync(p)) {
      const v = fs.readFileSync(p, "utf8").trim();
      return v || undefined;
    }
  } catch {
    // ignore
  }
  return undefined;
}
function resolveOsModelId(): string | undefined {
  return process.env.OPENSEARCH_ML_MODEL_ID || readCachedModelId();
}

export async function embed(text: string, dim: number = DIM): Promise<number[]> {
  const [v] = await embedBatch([text], dim);
  return v;
}

export async function embedBatch(texts: string[], dim: number = DIM): Promise<number[][]> {
  if (!texts || texts.length === 0) return [];

  // If using OpenSearch ML ingest pipeline for document embeddings, align query embeddings by calling ML _infer.
  const modelId = resolveOsModelId();
  if (PROVIDER === "opensearch_pipeline" && modelId) {
    try {
      const vecs = await (async function osMlInferBatch(input: string[], expectedDim: number): Promise<number[][]> {
        // Try two endpoints for compatibility across OS ML versions
        const payload = JSON.stringify({ model_id: modelId, input });
        const tryEndpoints = [
          `${OS_URL.replace(/\/+$/, "")}/_plugins/_ml/_infer`,
          `${OS_URL.replace(/\/+$/, "")}/_plugins/_ml/models/${encodeURIComponent(modelId)}/_infer`
        ];

        let lastErr: any;
        for (const ep of tryEndpoints) {
          try {
            const ctrl = new AbortController();
            const to = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
            const res = await fetch(ep, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: payload,
              signal: ctrl.signal
            }).finally(() => clearTimeout(to));
            if (!res.ok) {
              const txt = await res.text();
              throw new Error(`HTTP ${res.status}: ${txt.slice(0, 200)}`);
            }
            const body: any = await res.json();

            // Parse common response shapes
            let vectors: number[][] | undefined;

            // 1) { inference_results: [{ output: [[...]] }]} or output: [...]
            if (Array.isArray(body?.inference_results)) {
              const outs = body.inference_results.map((r: any) => {
                if (Array.isArray(r?.output)) {
                  // Some versions return [[...]]; accept both shapes
                  if (Array.isArray(r.output[0]) && typeof r.output[0][0] === "number") return r.output[0];
                  if (typeof r.output[0] === "number") return r.output as number[];
                }
                if (Array.isArray(r?.predicted_value)) return r.predicted_value as number[];
                return undefined;
              });
              if (outs.every((v: any) => Array.isArray(v))) {
                vectors = outs as number[][];
              }
            }

            // 2) { results: [[...], [...]] }
            if (!vectors && Array.isArray(body?.results) && Array.isArray(body.results[0])) {
              vectors = body.results as number[][];
            }

            if (!vectors || vectors.length !== input.length) {
              throw new Error("Malformed ML infer response: missing vectors or count mismatch");
            }
            // Basic dim check
            for (const v of vectors) {
              if (!Array.isArray(v) || (expectedDim > 0 && v.length !== expectedDim)) {
                // Do not hard-fail if dim mismatches; continue with whatever was returned
                break;
              }
            }
            return vectors;
          } catch (err) {
            lastErr = err;
            // try next endpoint
          }
        }
        throw new Error(`OS ML infer failed: ${String(lastErr)}`);
      })(texts, dim);
      return vecs.map(unitNormalize);
    } catch (e) {
      console.warn(`[embedder] OpenSearch ML infer failed, falling back. Reason: ${(e as Error).message}`);
      // Fall through to other providers/endpoints
    }
  }

  // If a custom HTTP endpoint is configured, use it.
  if (ENDPOINT) {
    try {
      const vecs = await remoteEmbed(texts, dim);
      return vecs.map(unitNormalize);
    } catch (e) {
      console.warn(`[embedder] remote endpoint failed, using fallback. Reason: ${(e as Error).message}`);
      return texts.map(t => unitNormalize(localFallbackEmbedding(t, dim)));
    }
  }

  // Deterministic local pseudo-embeddings (dev only)
  return texts.map(t => unitNormalize(localFallbackEmbedding(t, dim)));
}

// ---------------------------
// Remote HTTP embedder
// ---------------------------
async function remoteEmbed(texts: string[], dim: number): Promise<number[][]> {
  const body = JSON.stringify({ texts, dim });
  let lastErr: any;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), TIMEOUT_MS);

      const res = await fetch(ENDPOINT!, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {})
        },
        body,
        signal: ctrl.signal
      }).finally(() => clearTimeout(to));

      if (!res.ok) {
        const text = await safeText(res);
        throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
      }

      const data = (await res.json()) as { vectors?: number[][] };
      if (!data?.vectors || !Array.isArray(data.vectors) || data.vectors.length !== texts.length) {
        throw new Error("Malformed response: missing or invalid 'vectors'");
      }

      // Basic shape checks
      for (const v of data.vectors) {
        if (!Array.isArray(v) || v.length !== dim) {
          throw new Error(`Vector has wrong dimension (expected ${dim}, got ${v?.length})`);
        }
      }
      return data.vectors;
    } catch (err) {
      lastErr = err;
      await sleep(backoffMs(attempt));
    }
  }
  throw new Error(`remoteEmbed failed after ${MAX_RETRIES} attempts: ${String(lastErr)}`);
}

function backoffMs(attempt: number): number {
  const base = 150; // ms
  const jitter = Math.floor(Math.random() * 100);
  return Math.min(2000, base * Math.pow(2, attempt)) + jitter;
}

function sleep(ms: number) {
  return new Promise(res => setTimeout(res, ms));
}

async function safeText(res: Response): Promise<string> {
  try { return await res.text(); } catch { return ""; }
}

// ---------------------------
// Deterministic local fallback
// ---------------------------
// Produces a stable pseudo-embedding per input text by hashing tokens and
// spreading phases over the vector with sin/cos. Not semantically meaningful,
// but good enough for dev/demo and unit tests.

function localFallbackEmbedding(text: string, dim: number): number[] {
  const vec = new Array<number>(dim).fill(0);
  const tokens = simpleTokens(text);

  // Seed from whole text for variety
  const seed = murmur3(text);
  const rng = mulberry32(seed);

  // For each token, compute two hash-derived indices and add sinusoidal bumps.
  for (const tok of tokens) {
    const h1 = murmur3(tok + "|a");
    const h2 = murmur3(tok + "|b");
    const i = Math.abs(h1) % dim;
    const j = Math.abs(h2) % dim;

    const phase = (h1 ^ h2) >>> 0;
    const amp = 0.5 + 0.5 * rng(); // 0.5..1.0
    vec[i] += Math.sin(phase * 0.0001) * amp;
    vec[j] += Math.cos(phase * 0.0001) * amp * 0.7;
  }

  // Small random noise to break ties
  for (let k = 0; k < dim; k++) vec[k] += (rng() - 0.5) * 0.01;
  return vec;
}

function simpleTokens(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9_./:-]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 1024); // cap
}

// Murmur3 32-bit hash (x86 variant, simplified)
function murmur3(key: string, seed = 0): number {
  let h = seed ^ key.length;
  let i = 0;
  while (key.length >= i + 4) {
    let k =
      (key.charCodeAt(i) & 0xff) |
      ((key.charCodeAt(i + 1) & 0xff) << 8) |
      ((key.charCodeAt(i + 2) & 0xff) << 16) |
      ((key.charCodeAt(i + 3) & 0xff) << 24);
    k = Math.imul(k, 0xcc9e2d51);
    k = (k << 15) | (k >>> 17);
    k = Math.imul(k, 0x1b873593);
    h ^= k;
    h = (h << 13) | (h >>> 19);
    h = (Math.imul(h, 5) + 0xe6546b64) | 0;
    i += 4;
  }
  let k1 = 0;
  switch (key.length & 3) {
    case 3:
      k1 ^= (key.charCodeAt(i + 2) & 0xff) << 16;
    // falls through
    case 2:
      k1 ^= (key.charCodeAt(i + 1) & 0xff) << 8;
    // falls through
    case 1:
      k1 ^= key.charCodeAt(i) & 0xff;
      k1 = Math.imul(k1, 0xcc9e2d51);
      k1 = (k1 << 15) | (k1 >>> 17);
      k1 = Math.imul(k1, 0x1b873593);
      h ^= k1;
  }
  h ^= key.length;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h | 0;
}

// Tiny deterministic PRNG for fallback noise
function mulberry32(a: number) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------
// Vector utilities
// ---------------------------
function unitNormalize(v: number[]): number[] {
  let norm = 0;
  for (let i = 0; i < v.length; i++) norm += v[i] * v[i];
  norm = Math.sqrt(norm) || 1;
  return v.map(x => x / norm);
}
