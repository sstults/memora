import { predictRerankScores } from "../../src/services/os-ml.js";

function numArg(name: string, dflt: number): number {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx >= 0 && process.argv[idx + 1]) {
    const v = Number(process.argv[idx + 1]);
    if (Number.isFinite(v)) return v;
  }
  return dflt;
}

function strArg(name: string, dflt: string): string {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx >= 0 && process.argv[idx + 1]) {
    return String(process.argv[idx + 1]);
  }
  return dflt;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * (sorted.length - 1))));
  return sorted[idx];
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function now() {
  return Date.now();
}

async function main() {
  const iters = numArg("iters", 30);
  const k = Math.min(numArg("k", 64), 128);
  const query = strArg("query", "find relevant project notes about opensearch ml reranking");
  const timeoutMs = numArg("timeout", Number(process.env.OPENSEARCH_ML_RERANK_TIMEOUT_MS || 1500));

  const modelId = process.env.OPENSEARCH_ML_RERANK_MODEL_ID;
  if (!modelId) {
    console.error("[smoke] OPENSEARCH_ML_RERANK_MODEL_ID is not set. Export it and retry.");
    process.exitCode = 1;
    return;
  }

  // Synthesize candidate texts (repeatable, diverse-enough content)
  const baseTexts = [
    "OpenSearch ML Commons supports cross-encoder reranking for search results.",
    "RRF fusion blends lexical and vector scores to improve diversity.",
    "MiniLM-L6 ONNX model outputs 384-dimensional embeddings.",
    "Set ef_search to increase recall for HNSW kNN queries.",
    "Time decay prefers fresher episodic events among ties.",
    "Semantic index stores text and vector fields with cosinesimil.",
    "Cross-encoder rerank can reorder top candidates by relevance.",
    "BM25 best_fields over content, shingles, tags and artifacts.",
    "Attach pipelines to index.search.default_pipeline for A/B.",
    "Latency budgets target p95 under 1200 milliseconds."
  ];
  const texts: string[] = Array.from({ length: k }, (_, i) => {
    const b = baseTexts[i % baseTexts.length];
    return `${b} [cand:${i.toString().padStart(3, "0")}]`;
  });

  const times: number[] = [];
  let ok = 0;
  let fail = 0;

  console.error(`[smoke] OS-ML rerank — model=${modelId} iters=${iters} k=${k} timeoutMs=${timeoutMs}`);
  for (let i = 0; i < iters; i++) {
    try {
      const t0 = now();
      const scores = await predictRerankScores({
        modelId,
        query,
        texts,
        timeoutMs
      });
      const took = now() - t0;
      times.push(took);
      if (!Array.isArray(scores) || scores.length !== texts.length) {
        throw new Error(`bad scores length: got ${scores?.length}, expected ${texts.length}`);
      }
      ok++;
      console.error(`[smoke] iter=${i + 1}/${iters} ok tookMs=${took}`);
    } catch (e: any) {
      fail++;
      console.error(`[smoke] iter=${i + 1}/${iters} ERROR: ${e?.message || e}`);
    }
  }

  const p50 = percentile(times, 50);
  const p95 = percentile(times, 95);
  const stats = {
    iters,
    k,
    ok,
    fail,
    minMs: times.length ? Math.min(...times) : 0,
    meanMs: +mean(times).toFixed(2),
    p50Ms: p50,
    p95Ms: p95,
    maxMs: times.length ? Math.max(...times) : 0
  };

  console.error("[smoke] done", stats);
  console.log(JSON.stringify({ type: "osml_rerank_smoke", query, k, stats }, null, 2));

  // Non-zero exit if too many failures
  if (fail > 0) {
    process.exitCode = 2;
  }
}

main().catch((e) => {
  console.error("[smoke] fatal", e);
  process.exit(2);
});
