// scripts/demo_seed.ts
// Quick seed script for local development.
// Run with: npx ts-node scripts/demo_seed.ts
//
// Behavior:
// - Waits for OpenSearch health (yellow by default) before seeding.
// - Indexes one episodic event, one semantic memory (fake embedding), and one fact.
// - Uses refresh=true so documents are immediately visible to subsequent searches.
// - Prints a simple next step hint for memory.retrieve.
//
// Env:
//   OPENSEARCH_URL (default: http://localhost:9200)
//   OPENSEARCH_USERNAME / OPENSEARCH_PASSWORD (optional)
//   OPENSEARCH_SSL_REJECT_UNAUTHORIZED=false (optional; for self-signed local dev)

import { Client } from "@opensearch-project/opensearch";
import { v4 as uuidv4 } from "uuid";

const OS_URL = process.env.OPENSEARCH_URL || "http://localhost:9200";
const username = process.env.OPENSEARCH_USERNAME;
const password = process.env.OPENSEARCH_PASSWORD;
const rejectUnauthorized = (process.env.OPENSEARCH_SSL_REJECT_UNAUTHORIZED ?? "true") !== "false";

const client = new Client({
  node: OS_URL,
  ...(username && password ? { auth: { username, password } } : {}),
  ssl: { rejectUnauthorized }
} as any);

async function waitForHealth(minStatus: "yellow" | "green" = "yellow", timeoutMs = 30000) {
  const timeout = `${Math.max(1, Math.ceil(timeoutMs / 1000))}s`;
  try {
    const res = await (client as any).cluster.health({
      wait_for_status: minStatus,
      timeout
    });
    const body = (res as any)?.body ?? res;
    const status: string = body?.status || "unknown";
    const order: Record<string, number> = { red: 0, yellow: 1, green: 2 };
    if ((order[status] ?? 0) < (order[minStatus] ?? 1)) {
      throw new Error(`Cluster health '${status}' did not reach '${minStatus}' within ${timeout}`);
    }
  } catch (err: any) {
    throw new Error(`OpenSearch health check failed for ${OS_URL}. Root cause: ${err?.message || err}`);
  }
}

async function seed() {
  const tenant_id = "demo";
  const project_id = "memora-demo";
  const context_id = "demo-window";
  const task_id = "T-001";

  // Gate on health for predictable seeding.
  console.log(`Waiting for OpenSearch at ${OS_URL} to be healthy...`);
  await waitForHealth("yellow", 30000);
  console.log("Health OK");

  // Index names
  const today = new Date().toISOString().slice(0, 10);
  const episodicIndex = `mem-episodic-${today}`;
  const semanticIndex = "mem-semantic";
  const factsIndex = "mem-facts";

  // 1. Seed episodic log (refresh for immediate visibility)
  const event_id = uuidv4();
  await client.index({
    index: episodicIndex,
    id: event_id,
    body: {
      tenant_id,
      project_id,
      context_id,
      task_id,
      event_id,
      ts: new Date().toISOString(),
      role: "tool",
      content: "Build failed: NullPointerException in RankerQuery.java line 55",
      tags: ["error", "build"],
      artifacts: ["RankerQuery.java"],
      hash: "demo123"
    },
    refresh: true
  });

  // 2. Seed semantic chunk (with a fake embedding vector, refresh=true)
  const mem_id = uuidv4();
  const fakeEmbedding = Array.from({ length: 1024 }, () => Math.random());
  await client.index({
    index: semanticIndex,
    id: mem_id,
    body: {
      tenant_id,
      project_id,
      context_id,
      task_scope: "this_task",
      mem_id,
      title: "DFS logging bug",
      text: "RankerQuery requires DFS statistics when logging features. Ensure dfs_query_then_fetch is enabled.",
      tags: ["logging", "OpenSearch", "DFS"],
      salience: 0.9,
      novelty: 0.8,
      ttl_days: 180,
      last_used: null,
      api_version: "3.3",
      env: "dev",
      source_event_ids: [event_id],
      embedding: fakeEmbedding
    },
    refresh: true
  });

  // 3. Seed fact (refresh=true)
  const fact_id = uuidv4();
  await client.index({
    index: factsIndex,
    id: fact_id,
    body: {
      tenant_id,
      project_id,
      fact_id,
      s: "RankerQuery.featureScoreCache",
      p: "introduced_in",
      o: "OpenSearch 3.3.0",
      version: "2025-09-26",
      confidence: 0.9,
      evidence: [event_id]
    },
    refresh: true
  });

  console.log("Seed complete. Next step: try memory.retrieve with objective='DFS logging bug'.");
}

seed().catch(err => {
  console.error("Seed failed:", err?.message || err);
  process.exit(1);
});
