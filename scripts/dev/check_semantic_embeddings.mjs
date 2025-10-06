#!/usr/bin/env node
/**
 * scripts/dev/check_semantic_embeddings.mjs
 * Quick diagnostics for semantic embeddings and ingest/search pipeline attachment.
 *
 * What it checks:
 *  - Index settings: index.default_pipeline and index.search.default_pipeline
 *  - Mapping for 'embedding' field (type and dims if present)
 *  - Counts of docs with/without 'embedding'
 *  - Sample docs with/without embeddings and inferred embedding length stats
 *
 * Env:
 *  - OPENSEARCH_URL (default: http://localhost:19200)
 *  - MEMORA_SEMANTIC_INDEX (default: mem-semantic)
 *  - MEMORA_OS_INGEST_PIPELINE_NAME (default: mem-text-embed)
 */
import { Client } from "@opensearch-project/opensearch";

const node = process.env.OPENSEARCH_URL || "http://localhost:19200";
const index = process.env.MEMORA_SEMANTIC_INDEX || "mem-semantic";
const ingestPipelineName = process.env.MEMORA_OS_INGEST_PIPELINE_NAME || "mem-text-embed";

function pick(obj, ...keys) {
  const out = {};
  for (const k of keys) out[k] = obj?.[k];
  return out;
}

function unbody(resp) {
  return resp?.body ?? resp;
}

function embLen(emb) {
  return Array.isArray(emb) ? emb.length : null;
}

async function main() {
  const client = new Client({ node });

  console.log("== OpenSearch connection ==");
  console.log(`node: ${node}`);
  console.log(`index: ${index}`);
  console.log("");

  // 1) Index settings: default pipelines
  console.log("== Index settings (pipelines) ==");
  try {
    const resp = unbody(await client.indices.getSettings({ index }));
    const settings = resp?.[index]?.settings || {};
    const idxSettings = settings?.index || settings;
    const defaultPipeline = idxSettings?.default_pipeline;
    const searchDefaultPipeline = idxSettings?.search?.default_pipeline ?? idxSettings?.["search.default_pipeline"];
    console.log(pick(idxSettings, "default_pipeline", "search.default_pipeline"));
    console.log(`Resolved default_pipeline: ${defaultPipeline || "(none)"}`);
    console.log(`Resolved search.default_pipeline: ${searchDefaultPipeline || "(none)"}`);
  } catch (e) {
    console.warn(`[WARN] Failed to read index settings: ${e?.message || e}`);
  }
  console.log("");

  // 2) Mapping for 'embedding' field
  console.log("== Index mapping (embedding) ==");
  try {
    const resp = unbody(await client.indices.getMapping({ index }));
    const props = resp?.[index]?.mappings?.properties || {};
    const emb = props?.embedding || {};
    console.log("embedding mapping:", JSON.stringify(emb, null, 2));
  } catch (e) {
    console.warn(`[WARN] Failed to read mapping: ${e?.message || e}`);
  }
  console.log("");

  // 3) Counts: total, with embedding, without embedding
  console.log("== Document counts ==");
  let total = 0, withEmb = 0, withoutEmb = 0;
  try {
    const respTotal = unbody(await client.count({ index, body: { query: { match_all: {} } } }));
    total = Number(respTotal?.count || 0);

    const respWith = unbody(await client.count({
      index,
      body: { query: { exists: { field: "embedding" } } }
    }));
    withEmb = Number(respWith?.count || 0);

    const respWithout = unbody(await client.count({
      index,
      body: { query: { bool: { must_not: [{ exists: { field: "embedding" } }] } } }
    }));
    withoutEmb = Number(respWithout?.count || 0);

    console.log({ total, withEmb, withoutEmb });
  } catch (e) {
    console.warn(`[WARN] Failed to count docs: ${e?.message || e}`);
  }
  console.log("");

  // 4) Sample docs with embeddings
  console.log("== Sample docs WITH embeddings (up to 5) ==");
  try {
    const resp = unbody(await client.search({
      index,
      size: 5,
      query: { exists: { field: "embedding" } },
      _source: ["title", "text", "tags", "embedding"]
    }));
    const hits = resp?.hits?.hits || [];
    const lens = [];
    for (const h of hits) {
      const id = h?._id;
      const src = h?._source || {};
      const len = embLen(src.embedding);
      lens.push(len ?? 0);
      console.log({ id, len, title: (src.title || "").slice(0, 60) });
    }
    if (lens.length) {
      const min = Math.min(...lens), max = Math.max(...lens), avg = lens.reduce((a, b) => a + b, 0) / lens.length;
      console.log(`embedding lengths (sample): min=${min} max=${max} avg=${avg.toFixed(1)}`);
    }
  } catch (e) {
    console.warn(`[WARN] Failed to sample WITH embeddings: ${e?.message || e}`);
  }
  console.log("");

  // 5) Sample docs without embeddings
  console.log("== Sample docs WITHOUT embeddings (up to 5) ==");
  try {
    const resp = unbody(await client.search({
      index,
      size: 5,
      query: { bool: { must_not: [{ exists: { field: "embedding" } }] } },
      _source: ["title", "text", "tags"]
    }));
    const hits = resp?.hits?.hits || [];
    for (const h of hits) {
      const id = h?._id;
      const src = h?._source || {};
      console.log({ id, title: (src.title || "").slice(0, 60) });
    }
  } catch (e) {
    console.warn(`[WARN] Failed to sample WITHOUT embeddings: ${e?.message || e}`);
  }
  console.log("");

  // 6) Ingest/search pipeline presence (optional)
  console.log("== Ingest/search pipeline presence (optional) ==");
  try {
    // Best-effort: list pipelines and show if our expected ingest pipeline exists
    const resp = unbody(await client.ingest.getPipeline().catch(() => ({})));
    const names = Object.keys(resp || {});
    const hasIngest = names.includes(ingestPipelineName);
    console.log(`pipelines found: ${names.slice(0, 10).join(", ")}${names.length > 10 ? " ..." : ""}`);
    console.log(`ingest pipeline '${ingestPipelineName}': ${hasIngest ? "present" : "absent"}`);
  } catch (e) {
    console.warn(`[WARN] Failed to inspect pipelines: ${e?.message || e}`);
  }
  console.log("");

  // Summary verdicts
  console.log("== Summary ==");
  if (withEmb === 0) {
    console.log("VERDICT: No semantic embeddings present. Ingest pipeline likely not attached or model not deployed.");
  } else if (withEmb < Math.max(1, Math.floor(total * 0.1))) {
    console.log("VERDICT: Very few docs have embeddings. Ingest likely not applied consistently; check default_pipeline and writer path.");
  } else {
    console.log("VERDICT: Embeddings appear present on many docs. Investigate retrieval budgets, rerank, and packer limits next.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
