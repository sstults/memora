import { Client } from "@opensearch-project/opensearch";
import { getClient, withRetries } from "./os-client.js";
import fs from "node:fs";
import path from "node:path";

/**
 * Utilities for OpenSearch ML Commons + pipelines integration (dev-friendly).
 * Focus: create/update ingest pipeline with text_embedding and optionally attach
 * as index default_pipeline. Dev ML cluster settings helper included.
 *
 * Notes:
 * - Registration/deploy of models differs across OS/ML Commons versions. To keep this
 *   module stable and testable without a live cluster, we require OPENSEARCH_ML_MODEL_ID
 *   to be provided when creating the ingest pipeline. Auto-register is intentionally
 *   deferred and guarded behind a future explicit flag.
 */

/** Build dev ML cluster settings (single-node convenience). */

// Model ID cache helpers (dev ergonomics)
function getModelIdCachePath(): string {
  const p = process.env.MEMORA_OS_MODEL_ID_CACHE_FILE || ".memora/model_id";
  return path.resolve(process.cwd(), p);
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

function writeCachedModelId(id: string): void {
  try {
    const p = getModelIdCachePath();
    const dir = path.dirname(p);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(p, id, "utf8");
  } catch (e: any) {
    console.warn(`[memora:os-ml] Failed to write model id cache: ${e?.message || e}`);
  }
}

/** Build dev ML cluster settings (single-node convenience). */
export function buildDevMlSettingsBody() {
  return {
    persistent: {
      "plugins.ml_commons.only_run_on_ml_node": false,
      "plugins.ml_commons.model_access_control_enabled": true,
      "plugins.ml_commons.native_memory_threshold": 99
    }
  };
}

/** Apply dev ML settings if MEMORA_OS_APPLY_DEV_ML_SETTINGS is true. */
export async function applyDevMlSettingsIfEnabled(client: Client = getClient()): Promise<void> {
  const apply =
    (process.env.MEMORA_OS_APPLY_DEV_ML_SETTINGS || "false").toLowerCase() === "true";
  if (!apply) return;

  const body = buildDevMlSettingsBody();
  await withRetries(() => (client as any).cluster.putSettings({ body } as any));
}

/** Build an ingest pipeline body using text_embedding processor. */
export function buildIngestPipelineBody(params: {
  modelId: string;
  textField: string;
  embedField: string;
  description?: string;
}) {
  const { modelId, textField, embedField, description } = params;
  return {
    description: description || "Memora text embedding pipeline",
    processors: [
      {
        text_embedding: {
          model_id: modelId,
          field_map: {
            [textField]: embedField
          }
          // Note: token_limit is not supported for text_embedding in OS 3.2
        }
      }
    ]
  };
}

/** Create or update an ingest pipeline by id (idempotent). */
export async function ensureIngestPipeline(opts: {
  id: string;
  body: Record<string, any>;
  client?: Client;
}): Promise<void> {
  const client = opts.client || getClient();
  await withRetries(() =>
    (client as any).ingest.putPipeline({ id: opts.id, body: opts.body })
  );
}

/** Create or update a search pipeline by id (idempotent). */
export async function ensureSearchPipeline(opts: {
  id: string;
  body: Record<string, any>;
  client?: Client;
}): Promise<void> {
  const client = opts.client || getClient();
  await withRetries(() =>
    (client as any).transport.request({
      method: "PUT",
      path: `/_search/pipeline/${encodeURIComponent(opts.id)}`,
      body: opts.body
    })
  );
}

/** Attach index.default_pipeline if not already set to the provided pipeline. */
export async function attachDefaultPipelineToIndex(opts: {
  index: string;
  pipeline: string;
  client?: Client;
}): Promise<void> {
  const client = opts.client || getClient();

  const settingsResp = await withRetries(() =>
    client.indices.getSettings({ index: opts.index } as any)
  );
  const settingsBody: any = (settingsResp as any).body ?? settingsResp;

  let current: string | undefined;
  if (settingsBody && typeof settingsBody === "object") {
    const firstKey = Object.keys(settingsBody)[0];
    current =
      settingsBody[firstKey]?.settings?.index?.default_pipeline ??
      settingsBody[firstKey]?.settings?.index?.["default_pipeline"];
  }

  if (current === opts.pipeline) return;

  await withRetries(() =>
    client.indices.putSettings({
      index: opts.index,
      body: {
        index: {
          default_pipeline: opts.pipeline
        }
      }
    } as any)
  );
}

/** Attach index.search.default_pipeline for search-time pipelines if not already set. */
export async function attachDefaultSearchPipelineToIndex(opts: {
  index: string;
  pipeline: string;
  client?: Client;
}): Promise<void> {
  const client = opts.client || getClient();

  const settingsResp = await withRetries(() =>
    client.indices.getSettings({ index: opts.index } as any)
  );
  const settingsBody: any = (settingsResp as any).body ?? settingsResp;

  let current: string | undefined;
  if (settingsBody && typeof settingsBody === "object") {
    const firstKey = Object.keys(settingsBody)[0];
    const idxSettings = settingsBody[firstKey]?.settings?.index;
    current =
      idxSettings?.search?.default_pipeline ??
      idxSettings?.["search.default_pipeline"];
  }

  if (current === opts.pipeline) return;

  await withRetries(() =>
    client.indices.putSettings({
      index: opts.index,
      body: {
        index: {
          search: { default_pipeline: opts.pipeline }
        }
      }
    } as any)
  );
}

/** Dev-only helpers: model auto-register/deploy for OpenSearch ML Commons (best-effort). */
async function pollMlTask(client: Client, taskId: string, timeoutMs = 90000, intervalMs = 1000): Promise<any> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const resp = await withRetries(() =>
      (client as any).transport.request({
        method: "GET",
        path: `/_plugins/_ml/tasks/${encodeURIComponent(taskId)}`
      })
    );
    const body: any = (resp as any)?.body ?? resp;
    const state: string | undefined = body?.state || body?.task?.state;
    if (state === "COMPLETED") return body;
    if (state === "FAILED") {
      const reason = body?.error || body?.task?.error || "unknown";
      throw new Error(`ML task ${taskId} failed: ${typeof reason === "string" ? reason : JSON.stringify(reason)}`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Timed out waiting for ML task ${taskId} completion after ${timeoutMs}ms`);
}

/**
 * Attempt to auto-register and deploy a default embedding model (dev-only).
 * Returns model_id on success, otherwise undefined. Controlled by MEMORA_OS_AUTO_REGISTER_MODEL.
 */
async function ensureModelRegisteredDeployedFromEnv(client: Client): Promise<string | undefined> {
  const auto =
    (process.env.MEMORA_OS_AUTO_REGISTER_MODEL || "false").toLowerCase() === "true";
  if (!auto) return undefined;

  const name = process.env.OPENSEARCH_ML_MODEL_NAME || "huggingface/sentence-transformers/all-MiniLM-L6-v2";
  const version = process.env.OPENSEARCH_ML_MODEL_VERSION || "1.0.2";
  const format = (process.env.OPENSEARCH_ML_MODEL_FORMAT || "ONNX").toUpperCase();

  // Attempt registration (shapes vary by OS version; handle task_id or model_id)
  let regResp: any;
  try {
    regResp = await withRetries(() =>
      (client as any).transport.request({
        method: "POST",
        path: "/_plugins/_ml/models/_register",
        body: {
          name,
          version,
          model_format: format,
          model_task_type: "TEXT_EMBEDDING"
        }
      })
    );
  } catch (e: any) {
    console.warn(
      `[memora:os-ml] Auto-register failed (${name} ${version} ${format}): ${e?.message || e}`
    );
    return undefined;
  }

  const regBody: any = (regResp as any)?.body ?? regResp;
  let modelId: string | undefined = regBody?.model_id;
  const regTaskId: string | undefined = regBody?.task_id;

  try {
    if (!modelId && regTaskId) {
      const task = await pollMlTask(client, regTaskId);
      modelId = task?.model_id || task?.task?.model_id || task?.model?.model_id;
    }
  } catch (e: any) {
    console.warn(
      `[memora:os-ml] Auto-register task polling failed: ${e?.message || e}`
    );
    return undefined;
  }

  if (!modelId) {
    console.warn("[memora:os-ml] Could not resolve model_id from registration response");
    return undefined;
  }

  // Deploy the model; some versions return task_id — poll if present
  try {
    const depResp = await withRetries(() =>
      (client as any).transport.request({
        method: "POST",
        path: `/_plugins/_ml/models/${encodeURIComponent(modelId)}/_deploy`
      })
    );
    const depBody: any = (depResp as any)?.body ?? depResp;
    const depTaskId: string | undefined = depBody?.task_id;
    if (depTaskId) {
      await pollMlTask(client, depTaskId);
    }
  } catch (e: any) {
    // Non-fatal: deployment may already exist or shape differs; continue
    console.warn(
      `[memora:os-ml] Auto-deploy warning for model ${modelId}: ${e?.message || e}`
    );
  }

  const useCache = (process.env.MEMORA_OS_ENABLE_MODEL_ID_CACHE || "false").toLowerCase() === "true";
  if (useCache) {
    writeCachedModelId(modelId);
  }
  return modelId;
}

/**
 * Orchestrate pipeline creation and optional default_pipeline attachment using env.
 * Safe to call unconditionally; it is a no-op unless MEMORA_EMBED_PROVIDER=opensearch_pipeline.
 *
 * Env (commonly set in .env.example):
 * - MEMORA_EMBED_PROVIDER=opensearch_pipeline
 * - OPENSEARCH_ML_MODEL_ID=<optional; required unless MEMORA_OS_AUTO_REGISTER_MODEL=true>
 * - MEMORA_OS_AUTO_REGISTER_MODEL=true|false  (dev-only auto-register/deploy default model when model id is unset)
 * - MEMORA_OS_INGEST_PIPELINE_NAME=mem-text-embed
 * - MEMORA_OS_TEXT_SOURCE_FIELD=text
 * - MEMORA_OS_EMBED_FIELD=embedding
 * - MEMORA_OS_DEFAULT_PIPELINE_ATTACH=true|false
 * - MEMORA_SEMANTIC_INDEX=mem-semantic
 * - MEMORA_OS_APPLY_DEV_ML_SETTINGS=true|false
 */
export async function ensurePipelineAndAttachmentFromEnv(): Promise<void> {
  const provider = (process.env.MEMORA_EMBED_PROVIDER || "").toLowerCase();
  if (provider !== "opensearch_pipeline") return;

  const client = getClient();

  // Optionally apply dev ML cluster settings (single-node convenience)
  await applyDevMlSettingsIfEnabled(client);

  const pipelineName = process.env.MEMORA_OS_INGEST_PIPELINE_NAME || "mem-text-embed";
  const textField = process.env.MEMORA_OS_TEXT_SOURCE_FIELD || "text";
  const embedField = process.env.MEMORA_OS_EMBED_FIELD || "embedding";
  const attachDefault =
    (process.env.MEMORA_OS_DEFAULT_PIPELINE_ATTACH || "false").toLowerCase() === "true";
  const semanticIndex = process.env.MEMORA_SEMANTIC_INDEX || "mem-semantic";

  // Resolve model id: prefer explicit OPENSEARCH_ML_MODEL_ID; fallback to dev-only auto-register if enabled
  const useCache = (process.env.MEMORA_OS_ENABLE_MODEL_ID_CACHE || "false").toLowerCase() === "true";
  let modelId = process.env.OPENSEARCH_ML_MODEL_ID || (useCache ? readCachedModelId() : undefined);
  if (!modelId) {
    modelId = await ensureModelRegisteredDeployedFromEnv(client);
  }
  if (!modelId) {
    console.warn(
      "[memora:os-ml] OPENSEARCH_ML_MODEL_ID is not set and auto-register is disabled or failed. " +
        "Skipping ingest pipeline creation. Set a deployed ML model id or enable MEMORA_OS_AUTO_REGISTER_MODEL=true for dev."
    );
    return;
  }

  const pipelineBody = buildIngestPipelineBody({
    modelId,
    textField,
    embedField,
    description: `Memora text embedding pipeline (${textField} → ${embedField})`
  });
  await ensureIngestPipeline({ id: pipelineName, body: pipelineBody, client });

  if (attachDefault) {
    await attachDefaultPipelineToIndex({ index: semanticIndex, pipeline: pipelineName, client });
  }
}

/**
 * Create or update a search pipeline and optionally attach as default to the semantic index.
 *
 * Env (commonly set in .env.example):
 * - MEMORA_EMBED_PROVIDER=opensearch_pipeline
 * - MEMORA_OS_SEARCH_PIPELINE_NAME=mem-search
 * - MEMORA_OS_SEARCH_PIPELINE_BODY_JSON='{"request_processors":[...],"response_processors":[...]}'
 * - MEMORA_OS_SEARCH_DEFAULT_PIPELINE_ATTACH=true|false
 * - MEMORA_SEMANTIC_INDEX=mem-semantic
 */
export async function ensureSearchPipelineFromEnv(): Promise<void> {
  const provider = (process.env.MEMORA_EMBED_PROVIDER || "").toLowerCase();
  if (provider !== "opensearch_pipeline") return;

  const name = process.env.MEMORA_OS_SEARCH_PIPELINE_NAME || "mem-search";
  const bodyJson = process.env.MEMORA_OS_SEARCH_PIPELINE_BODY_JSON;

  if (!bodyJson) {
    console.warn(
      "[memora:os-ml] MEMORA_OS_SEARCH_PIPELINE_BODY_JSON is not set. " +
        "Skipping search pipeline creation. See OpenSearch docs for search processors."
    );
    return;
  }

  let body: any;
  try {
    body = JSON.parse(bodyJson);
  } catch (e: any) {
    console.warn(
      `[memora:os-ml] Failed to parse MEMORA_OS_SEARCH_PIPELINE_BODY_JSON: ${e?.message || e}. Skipping.`
    );
    return;
  }

  const client = getClient();
  await ensureSearchPipeline({ id: name, body, client });

  const attachDefault =
    (process.env.MEMORA_OS_SEARCH_DEFAULT_PIPELINE_ATTACH || "false").toLowerCase() === "true";
  const semanticIndex = process.env.MEMORA_SEMANTIC_INDEX || "mem-semantic";
  if (attachDefault) {
    await attachDefaultSearchPipelineToIndex({ index: semanticIndex, pipeline: name, client });
  }
}

/**
 * Predict cross-encoder rerank scores using OpenSearch ML Commons model.
 * Accepts a query string and an array of candidate texts, returns a score per text.
 * Attempts to normalize across common ML Commons response shapes.
 */
export async function predictRerankScores(params: {
  modelId: string;
  query: string;
  texts: string[];
  timeoutMs?: number;
  client?: Client;
}): Promise<number[]> {
  const {
    modelId,
    query,
    texts,
    timeoutMs = Number(process.env.MEMORA_OS_CLIENT_TIMEOUT_MS ?? process.env.MEMORA_OS_REQUEST_TIMEOUT_MS ?? 10000),
    client = getClient()
  } = params;

  const resp = await withRetries(() =>
    (client as any).transport.request({
      method: "POST",
      path: `/_plugins/_ml/models/${encodeURIComponent(modelId)}/_predict`,
      body: {
        // Common pattern for cross-encoder rerank input
        parameters: { task_type: "RERANKING" },
        input: { query, texts }
      },
      ...(timeoutMs ? { requestTimeout: timeoutMs } : {})
    })
  );

  const body: any = (resp as any)?.body ?? resp;

  // Direct scores array
  if (Array.isArray(body?.scores)) return body.scores as number[];

  // ML Commons inference_results shape
  const fromInferenceResults =
    body?.inference_results?.[0]?.response?.scores ||
    body?.inference_results?.[0]?.output?.scores ||
    body?.output?.scores ||
    undefined;

  if (Array.isArray(fromInferenceResults)) return fromInferenceResults as number[];

  // Fallback: locate the first array of numbers in the response
  const nums = deepFindFirstNumberArray(body);
  if (Array.isArray(nums)) return nums as number[];

  throw new Error("Unexpected ML predict response shape for rerank; no scores found");
}

function deepFindFirstNumberArray(obj: any): number[] | undefined {
  if (!obj || typeof obj !== "object") return undefined;
  if (Array.isArray(obj) && obj.every((x) => typeof x === "number")) return obj as number[];
  for (const k of Object.keys(obj)) {
    const v = (obj as any)[k];
    const found = deepFindFirstNumberArray(v);
    if (found) return found;
  }
  return undefined;
}
