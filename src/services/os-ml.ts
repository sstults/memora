import { Client } from "@opensearch-project/opensearch";
import { getClient, withRetries } from "./os-client.js";

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

/**
 * Orchestrate pipeline creation and optional default_pipeline attachment using env.
 * Safe to call unconditionally; it is a no-op unless MEMORA_EMBED_PROVIDER=opensearch_pipeline.
 *
 * Env (commonly set in .env.example):
 * - MEMORA_EMBED_PROVIDER=opensearch_pipeline
 * - OPENSEARCH_ML_MODEL_ID=<required to create pipeline>
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

  // Require a provided model id for stability across OS versions
  const modelId = process.env.OPENSEARCH_ML_MODEL_ID;
  if (!modelId) {
    // Do not throw to avoid breaking bootstrap; log guidance instead.
    console.warn(
      "[memora:os-ml] OPENSEARCH_ML_MODEL_ID is not set. Skipping ingest pipeline creation. " +
        "Set a deployed ML model id to enable text_embedding pipeline provisioning."
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
