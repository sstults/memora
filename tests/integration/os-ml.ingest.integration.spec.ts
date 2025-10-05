import { describe, it, expect } from "vitest";
import { ensurePipelineAndAttachmentFromEnv } from "../../src/services/os-ml";
import { getClient } from "../../src/services/os-client";

/**
 * Integration test for ingest pipeline provisioning via dev auto-register path.
 *
 * This suite is INTEGRATION-gated and specifically targets the case where:
 *  - MEMORA_EMBED_PROVIDER=opensearch_pipeline
 *  - MEMORA_OS_AUTO_REGISTER_MODEL=true
 *  - OPENSEARCH_ML_MODEL_ID is NOT set
 *
 * Preconditions when running with INTEGRATION=1:
 *  - OpenSearch 3.2+ is running at OPENSEARCH_URL
 *  - ML Commons plugins installed; cluster can register+deploy default ONNX model
 *  - Index `MEMORA_SEMANTIC_INDEX` exists if MEMORA_OS_DEFAULT_PIPELINE_ATTACH=true
 *    (use scripts/create_indices.sh or memory.integration.spec.ts bootstrap)
 *
 * Example run:
 *   docker compose -f docker/docker-compose.yml up -d
 *   ./scripts/create_indices.sh
 *   INTEGRATION=1 \\
 *   MEMORA_EMBED_PROVIDER=opensearch_pipeline \\
 *   MEMORA_OS_AUTO_REGISTER_MODEL=true \\
 *   MEMORA_OS_DEFAULT_PIPELINE_ATTACH=false \\
 *   npm run test:integration
 */

const INTEGRATION = process.env.INTEGRATION === "1";
const providerOk = (process.env.MEMORA_EMBED_PROVIDER || "").toLowerCase() === "opensearch_pipeline";
const autoRegister = (process.env.MEMORA_OS_AUTO_REGISTER_MODEL || "false").toLowerCase() === "true";
const hasExplicitModelId = !!process.env.OPENSEARCH_ML_MODEL_ID;

// Run only when explicitly integration-enabled and the auto-register path is being exercised.
const suite = (INTEGRATION && providerOk && autoRegister && !hasExplicitModelId) ? describe : describe.skip;

suite("os-ml ingest pipeline integration (auto-register path; INTEGRATION gated)", () => {
  it("provisions ingest pipeline via dev auto-register and is idempotent", async () => {
    const name = process.env.MEMORA_OS_INGEST_PIPELINE_NAME || "mem-text-embed";
    const attach =
      (process.env.MEMORA_OS_DEFAULT_PIPELINE_ATTACH || "false").toLowerCase() === "true";
    const index = process.env.MEMORA_SEMANTIC_INDEX || "mem-semantic";

    // Create/update twice to validate idempotency
    await expect(ensurePipelineAndAttachmentFromEnv()).resolves.toBeUndefined();
    await expect(ensurePipelineAndAttachmentFromEnv()).resolves.toBeUndefined();

    // Verify pipeline exists via GET /_ingest/pipeline/{id}
    const client = getClient();
    const getResp = await (client as any).transport.request({
      method: "GET",
      path: `/_ingest/pipeline/${encodeURIComponent(name)}`
    });
    const body = (getResp as any)?.body ?? getResp;
    // Response shape is { [pipelineId]: { ...pipelineDef } }
    expect(body).toBeTruthy();
    expect(typeof body).toBe("object");
    expect(body[name]).toBeTruthy();

    // If configured to attach default, assert index.default_pipeline is set
    if (attach) {
      const settingsResp = await client.indices.getSettings({ index } as any);
      const settingsBody: any = (settingsResp as any).body ?? settingsResp;
      const firstKey = Object.keys(settingsBody)[0];
      const def =
        settingsBody[firstKey]?.settings?.index?.default_pipeline ??
        settingsBody[firstKey]?.settings?.index?.["default_pipeline"];
      expect(def).toBe(name);
    }
  });
});
