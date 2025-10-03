// scripts/demo_seed.ts
// Quick seed script for local development.
// Run with: npx ts-node scripts/demo_seed.ts

import { Client } from '@opensearch-project/opensearch';
import { v4 as uuidv4 } from 'uuid';

const OS_URL = process.env.OPENSEARCH_URL || 'http://localhost:9200';
const client = new Client({ node: OS_URL });

async function seed() {
  const tenant_id = "demo";
  const project_id = "memora-demo";
  const context_id = "demo-window";
  const task_id = "T-001";

  // 1. Seed episodic log
  const event_id = uuidv4();
  await client.index({
    index: `mem-episodic-${new Date().toISOString().slice(0, 10)}`,
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
    }
  });

  // 2. Seed semantic chunk (with a fake embedding vector)
  const mem_id = uuidv4();
  const fakeEmbedding = Array.from({ length: 1024 }, () => Math.random());
  await client.index({
    index: "mem-semantic",
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
    }
  });

  // 3. Seed fact
  const fact_id = uuidv4();
  await client.index({
    index: "mem-facts",
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
    }
  });

  console.log("✅ Seed complete. Try a memory.retrieve with objective='DFS logging bug'");
}

seed().catch(err => {
  console.error("❌ Seed failed", err);
  process.exit(1);
});
