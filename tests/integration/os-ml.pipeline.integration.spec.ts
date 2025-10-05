import { describe, it, expect } from "vitest";
import { ensureSearchPipelineFromEnv } from "../../src/services/os-ml";
import { getClient } from "../../src/services/os-client";

// Integration test skeleton for search pipeline provisioning.
// This suite is gated by INTEGRATION=1 and expects a live OpenSearch at OPENSEARCH_URL.
// It is intentionally minimal and safe to skip by default. Flesh out when a cluster is available.
//
// Preconditions when running with INTEGRATION=1:
// - OpenSearch 3.2+ is running at OPENSEARCH_URL
// - Index `MEMORA_SEMANTIC_INDEX` exists (bootstrap or create_indices.sh)
// - You have appropriate security disabled or credentials set via OPENSEARCH_USERNAME/PASSWORD
//
// Example run:
//   docker compose -f docker/docker-compose.yml up -d
//   ./scripts/create_indices.sh
//   INTEGRATION=1 \
//   MEMORA_EMBED_PROVIDER=opensearch_pipeline \
//   MEMORA_SEMANTIC_INDEX=mem-semantic \
//   MEMORA_OS_SEARCH_PIPELINE_NAME=mem-search \
//   MEMORA_OS_SEARCH_DEFAULT_PIPELINE_ATTACH=false \
//   MEMORA_OS_SEARCH_PIPELINE_BODY_JSON='{"request_processors":[{"filter_query":{"description":"integration smoke","query":{"match_all":{}}}}],"response_processors":[]}' \
//   npm run test:integration

const INTEGRATION = process.env.INTEGRATION === "1";
const REQUIRED_ENV = [
  "MEMORA_EMBED_PROVIDER",
  "MEMORA_OS_SEARCH_PIPELINE_NAME",
  "MEMORA_OS_SEARCH_PIPELINE_BODY_JSON"
] as const;
const MISSING = REQUIRED_ENV.filter((k) => !process.env[k]);

// Define-time skip: if INTEGRATION is not enabled or required env is missing,
// mark the whole suite as skipped at definition time so CI cannot accidentally run it.
const suite = (!INTEGRATION || MISSING.length > 0) ? describe.skip : describe;

suite("os-ml search pipeline integration (INTEGRATION gated)", () => {
  it("smoke: env wiring present for search pipeline JSON body", async () => {
    // Validate the JSON parses - mirrors ensureSearchPipelineFromEnv parsing path.
    const bodyRaw = process.env.MEMORA_OS_SEARCH_PIPELINE_BODY_JSON!;
    let parsed: any;
    expect(() => (parsed = JSON.parse(bodyRaw))).not.toThrow();
    expect(parsed).toBeTypeOf("object");
    expect(Array.isArray(parsed.request_processors)).toBe(true);

  // TODO (enhancement): When cluster is available, import ensureSearchPipelineFromEnv and:
  //  - call it to create/update the pipeline idempotently
  //  - optionally set MEMORA_OS_SEARCH_DEFAULT_PIPELINE_ATTACH=true and assert index settings
  });

  it("provisions search pipeline idempotently and optionally attaches default", async () => {
    // Preconditions already handled by suite gating via INTEGRATION and REQUIRED_ENV
    const name = process.env.MEMORA_OS_SEARCH_PIPELINE_NAME!;
    const attach =
      (process.env.MEMORA_OS_SEARCH_DEFAULT_PIPELINE_ATTACH || "false").toLowerCase() === "true";
    const index = process.env.MEMORA_SEMANTIC_INDEX || "mem-semantic";

    // Create/update twice to validate idempotency
    await expect(ensureSearchPipelineFromEnv()).resolves.toBeUndefined();
    await expect(ensureSearchPipelineFromEnv()).resolves.toBeUndefined();

    // Verify pipeline exists via GET /_search/pipeline/{id}
    const client = getClient();
    const getResp = await (client as any).transport.request({
      method: "GET",
      path: `/_search/pipeline/${encodeURIComponent(name)}`
    });
    const body = (getResp as any)?.body ?? getResp;
    expect(body).toBeTruthy();

    // If configured to attach default, assert index.search.default_pipeline is set
    if (attach) {
      const settingsResp = await client.indices.getSettings({ index } as any);
      const settingsBody: any = (settingsResp as any).body ?? settingsResp;
      const firstKey = Object.keys(settingsBody)[0];
      const def =
        settingsBody[firstKey]?.settings?.index?.search?.default_pipeline ??
        settingsBody[firstKey]?.settings?.index?.["search.default_pipeline"];
      expect(def).toBe(name);
    }
  });
});
