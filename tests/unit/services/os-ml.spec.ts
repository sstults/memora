import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  buildDevMlSettingsBody,
  buildIngestPipelineBody,
  ensureIngestPipeline,
  attachDefaultPipelineToIndex,
  ensurePipelineAndAttachmentFromEnv
} from "../../../src/services/os-ml";

describe("os-ml helpers", () => {
  const envBackup = { ...process.env };

  beforeEach(() => {
    vi.restoreAllMocks();
    // Reset env of keys we touch
    delete process.env.MEMORA_EMBED_PROVIDER;
    delete process.env.MEMORA_OS_APPLY_DEV_ML_SETTINGS;
    delete process.env.MEMORA_OS_INGEST_PIPELINE_NAME;
    delete process.env.MEMORA_OS_TEXT_SOURCE_FIELD;
    delete process.env.MEMORA_OS_EMBED_FIELD;
    delete process.env.MEMORA_OS_DEFAULT_PIPELINE_ATTACH;
    delete process.env.MEMORA_SEMANTIC_INDEX;
    delete process.env.OPENSEARCH_ML_MODEL_ID;
  });

  afterEach(() => {
    process.env = { ...envBackup };
  });

  it("buildDevMlSettingsBody returns dev-friendly persistent ML settings", () => {
    const body = buildDevMlSettingsBody();
    expect(body).toEqual({
      persistent: {
        "plugins.ml_commons.only_run_on_ml_node": false,
        "plugins.ml_commons.model_access_control_enabled": true,
        "plugins.ml_commons.native_memory_threshold": 99
      }
    });
  });

  it("buildIngestPipelineBody maps text field to embedding field using text_embedding", () => {
    const body = buildIngestPipelineBody({
      modelId: "model-123",
      textField: "text",
      embedField: "embedding",
      description: "custom desc"
    });
    expect(body).toEqual({
      description: "custom desc",
      processors: [
        {
          text_embedding: {
            model_id: "model-123",
            field_map: {
              text: "embedding"
            }
          }
        }
      ]
    });
  });

  it("ensureIngestPipeline calls ingest.putPipeline with provided client", async () => {
    const calls: any[] = [];
    const fakeClient: any = {
      ingest: {
        putPipeline: vi.fn(async (args: any) => {
          calls.push(["putPipeline", args]);
          return { body: { acknowledged: true } };
        })
      }
    };
    await ensureIngestPipeline({
      id: "mem-text-embed",
      body: { processors: [] },
      client: fakeClient
    });
    expect(calls).toEqual([
      ["putPipeline", { id: "mem-text-embed", body: { processors: [] } }]
    ]);
  });

  it("attachDefaultPipelineToIndex is a no-op when already attached", async () => {
    const fakeClient: any = {
      indices: {
        getSettings: vi.fn(async () => ({
          body: {
            "mem-semantic": {
              settings: {
                index: {
                  default_pipeline: "mem-text-embed"
                }
              }
            }
          }
        })),
        putSettings: vi.fn(async () => {
          throw new Error("should not be called");
        })
      }
    };
    await attachDefaultPipelineToIndex({
      index: "mem-semantic",
      pipeline: "mem-text-embed",
      client: fakeClient
    });
    expect(fakeClient.indices.getSettings).toHaveBeenCalledTimes(1);
    expect(fakeClient.indices.putSettings).not.toHaveBeenCalled();
  });

  it("attachDefaultPipelineToIndex sets default_pipeline when missing/different", async () => {
    const putCalls: any[] = [];
    const fakeClient: any = {
      indices: {
        getSettings: vi.fn(async () => ({
          body: {
            "mem-semantic": {
              settings: {
                index: {
                  // no default_pipeline set
                }
              }
            }
          }
        })),
        putSettings: vi.fn(async (args: any) => {
          putCalls.push(args);
          return { body: { acknowledged: true } };
        })
      }
    };
    await attachDefaultPipelineToIndex({
      index: "mem-semantic",
      pipeline: "mem-text-embed",
      client: fakeClient
    });
    expect(fakeClient.indices.getSettings).toHaveBeenCalledTimes(1);
    expect(fakeClient.indices.putSettings).toHaveBeenCalledTimes(1);
    expect(putCalls[0]).toEqual({
      index: "mem-semantic",
      body: { index: { default_pipeline: "mem-text-embed" } }
    });
  });

  it("ensurePipelineAndAttachmentFromEnv is a no-op when provider is not opensearch_pipeline", async () => {
    process.env.MEMORA_EMBED_PROVIDER = "other_provider";
    await expect(ensurePipelineAndAttachmentFromEnv()).resolves.toBeUndefined();
  });

  it("ensurePipelineAndAttachmentFromEnv warns and returns when model id is not set", async () => {
    process.env.MEMORA_EMBED_PROVIDER = "opensearch_pipeline";
    // leave OPENSEARCH_ML_MODEL_ID undefined
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await ensurePipelineAndAttachmentFromEnv();

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const msg = (warnSpy.mock.calls[0]?.[0] || "").toString();
    expect(msg).toMatch(/OPENSEARCH_ML_MODEL_ID is not set/i);
  });
});
