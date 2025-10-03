import { describe, it, expect, beforeAll } from "vitest";

// Integration test skeleton for memory routes against a real OpenSearch instance.
// This suite is skipped by default. Enable by setting INTEGRATION=1 in the environment
// and ensuring Docker OpenSearch is running plus indices are created via scripts/create_indices.sh.
//
// Example:
//   docker compose -f docker/docker-compose.yml up -d
//   bash scripts/create_indices.sh
//   INTEGRATION=1 npm run test:integration

const run = process.env.INTEGRATION === "1";

describe.runIf(run)("memory integration (OpenSearch required)", () => {
  beforeAll(async () => {
    // In a future pass we can import assertHealthy() and verify connectivity here.
    // For now we assume the environment is prepared by the developer/CI.
  });

  it("placeholder: writes an event and retrieves snippets", async () => {
    // TODO: Implement once OpenSearch is available in CI and local dev is verified.
    // Plan:
    // 1) Programmatically register routes on a test server double
    // 2) Set context
    // 3) Call memory.write with a sample event
    // 4) Call memory.retrieve and validate shape, and that last_used updated for semantic docs
    expect(true).toBe(true);
  });
});
