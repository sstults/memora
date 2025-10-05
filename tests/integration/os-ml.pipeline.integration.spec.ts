import { describe, it, expect } from "vitest";

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

describe("os-ml search pipeline integration (INTEGRATION gated)", () => {
  if (!INTEGRATION) {
    it.skip("integration tests disabled (set INTEGRATION=1 to enable)", () => {
      // no-op
    });
    return;
  }

  // Additional gating: require certain env vars; if missing, skip the suite gracefully.
  const requiredEnv = [
    "MEMORA_EMBED_PROVIDER",
    "MEMORA_OS_SEARCH_PIPELINE_NAME",
    "MEMORA_OS_SEARCH_PIPELINE_BODY_JSON"
  ] as const;
  const missing = requiredEnv.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    it.skip(`required env not set for search pipeline integration: ${missing.join(", ")}`, () => {
      // no-op
    });
    return;
  }

  it("smoke: env wiring present for search pipeline JSON body", async () => {
    // Skeleton: verify expected envs are present when running with INTEGRATION=1.
    // Actual cluster calls are covered by os-bootstrap path in application runtime;
    // this test ensures CI/dev can wire the JSON without parse errors.
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
});
