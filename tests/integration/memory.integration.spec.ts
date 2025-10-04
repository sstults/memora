import { describe, it, expect, beforeAll } from "vitest";
import fs from "fs";

import {
  assertHealthy,
  ensureIndex,
  putIndexTemplate,
  getClient
} from "../../src/services/os-client";
import { registerContext } from "../../src/routes/context";
import { registerMemory } from "../../src/routes/memory";
import { registerEval } from "../../src/routes/eval";

type ToolFn = (req: any) => Promise<any>;

// Integration test for memory routes against a real OpenSearch instance.
// This suite is skipped by default. Enable by setting INTEGRATION=1 in the environment
// and ensuring Docker OpenSearch is running plus indices are created/apply templates.
//
// Example:
//   docker compose -f docker/docker-compose.yml up -d
//   INTEGRATION=1 npm run test:integration
//
// This test will programmatically:
// - assert OpenSearch health
// - apply episodic template
// - create semantic/facts indices with mappings
// - ensure today's episodic index exists
// - register context and memory tools
// - write an event and retrieve snippets (fusion across stages)

const run = process.env.INTEGRATION === "1";

describe.runIf(run)("memory integration (OpenSearch required)", () => {
  const SEMANTIC_INDEX = process.env.MEMORA_SEMANTIC_INDEX || "mem-semantic";
  const FACTS_INDEX = process.env.MEMORA_FACTS_INDEX || "mem-facts";
  const EPISODIC_PREFIX = process.env.MEMORA_EPI_PREFIX || "mem-episodic-";
  const episodicToday = `${EPISODIC_PREFIX}${new Date().toISOString().slice(0, 10)}`;

  const tools = new Map<string, ToolFn>();
  const server = { tool: (name: string, fn: ToolFn) => tools.set(name, fn) };

  beforeAll(async () => {
    // 1) Health gate
    await assertHealthy();

    // 2) Apply templates / ensure indices
    const episodicTemplate = JSON.parse(
      fs.readFileSync("config/index-templates/mem-episodic.json", "utf8")
    );
    await putIndexTemplate("mem-episodic", episodicTemplate);

    const semanticBody = JSON.parse(
      fs.readFileSync("config/index-templates/mem-semantic.json", "utf8")
    );
    const factsBody = JSON.parse(
      fs.readFileSync("config/index-templates/mem-facts.json", "utf8")
    );

    await ensureIndex(SEMANTIC_INDEX, semanticBody);
    await ensureIndex(FACTS_INDEX, factsBody);
    await ensureIndex(episodicToday);

    // 3) Register tools
    registerContext(server);
    registerMemory(server);
    registerEval(server);

    // 4) Set context
    const setCtx = tools.get("context.set_context")!;
    await setCtx({
      params: {
        tenant_id: "memora",
        project_id: "integration",
        context_id: "ctx-1",
        task_id: "task-1",
        env: "test",
        api_version: "3.1"
      }
    });
  });

  it("writes an event and retrieves snippets (fusion across stages)", async () => {
    const write = tools.get("memory.write")!;
    const retrieve = tools.get("memory.retrieve")!;

    // Content includes a trivial fact pattern: "<subj> <p> <obj>"
    const content =
      "Integration check: FeatureA introduced_in v1_0 and requires EngineX. This API design decision outlines the contract and describes a fix for reliability.\nAdditional details about usage, design, and API contract.";

    const wres = await write({
      params: {
        role: "tool",
        content,
        tags: ["test", "integration"]
      }
    });

    expect(wres?.ok).toBe(true);
    expect(typeof wres?.event_id).toBe("string");
    // At least one semantic upsert expected from salience score
    expect(wres?.semantic_upserts).toBeGreaterThanOrEqual(1);

    const rres = await retrieve({
      params: {
        objective: "FeatureA introduced_in v1_0",
        budget: 8,
        filters: {
          scope: ["this_task", "project"]
        }
      }
    });

    expect(Array.isArray(rres?.snippets)).toBe(true);
    expect(rres.snippets.length).toBeGreaterThan(0);
    // Ideally we see at least one semantic hit
    const hasSemantic = rres.snippets.some((s: any) => s.source === "semantic");
    expect(hasSemantic).toBe(true);
  });

  it("touches last_used on retrieved semantic mems and can promote scope", async () => {
    const write = tools.get("memory.write")!;
    const retrieve = tools.get("memory.retrieve")!;
    const promote = tools.get("memory.promote")!;

    // Write another event
    const content =
      "Integration promote test: FeatureB introduced_in v2_0 and uses EngineY. API design decision and contract discussed to fix issues.";
    const wres = await write({
      params: { role: "tool", content, tags: ["test", "integration", "promote"] }
    });
    expect(wres?.ok).toBe(true);

    // Retrieve to get semantic mems (which also triggers last_used touch)
    const rres = await retrieve({
      params: {
        objective: "FeatureB introduced_in v2_0",
        budget: 8,
        filters: { scope: ["this_task", "project"] }
      }
    });
    const semantic = rres.snippets.filter((s: any) => s.source === "semantic");
    expect(semantic.length).toBeGreaterThan(0);

    // Verify last_used was touched
    const client = getClient();
    await client.indices.refresh({ index: SEMANTIC_INDEX });
    const memId = String(semantic[0].id).replace(/^mem:/, "");
    const doc = await client.get({ index: SEMANTIC_INDEX, id: memId });
    const src = ((doc as any).body ?? doc)?._source ?? {};
    expect(src.last_used).toBeTruthy();
    // last_used should be recent (within last 5 minutes)
    expect(new Date(src.last_used).getTime()).toBeGreaterThan(Date.now() - 5 * 60_000);

    // Promote to project scope and verify
    const pres = await promote({ params: { mem_id: memId, to_scope: "project" } });
    expect(pres?.ok).toBe(true);
    await client.indices.refresh({ index: SEMANTIC_INDEX });
    const doc2 = await client.get({ index: SEMANTIC_INDEX, id: memId });
    const src2 = ((doc2 as any).body ?? doc2)?._source ?? {};
    expect(src2.task_scope).toBe("project");
  });

  it("logs eval metrics with retrieved ids", async () => {
    const write = tools.get("memory.write")!;
    const retrieve = tools.get("memory.retrieve")!;
    const elog = tools.get("eval.log")!;
    const METRICS_INDEX = process.env.MEMORA_METRICS_INDEX || "mem-metrics";

    // Ensure metrics index exists (avoid relying on auto-create)
    await ensureIndex(METRICS_INDEX);

    // Write and retrieve to produce snippet ids
    const content =
      "Eval logging check: FeatureC requires EngineZ. API design decision and contract notes for retrieval; exception handling and fix details included.";
    const wres = await write({
      params: { role: "tool", content, tags: ["test", "integration", "eval"] }
    });
    expect(wres?.ok).toBe(true);

    const rres = await retrieve({
      params: {
        objective: "FeatureC requires EngineZ",
        budget: 6,
        filters: { scope: ["this_task", "project"] }
      }
    });
    expect(Array.isArray(rres?.snippets)).toBe(true);
    const ids = rres.snippets.map((s: any) => s.id);

    // Log eval metrics
    const eres = await elog({
      params: {
        step: 1,
        success: true,
        tokens_in: 10,
        latency_ms: 5,
        retrieved_ids: ids
      }
    });
    expect(eres?.ok).toBe(true);
    expect(typeof eres?.id).toBe("string");

    // Verify document persisted with retrieved_count
    const client = getClient();
    const doc = await client.get({ index: METRICS_INDEX, id: eres.id });
    const src = ((doc as any).body ?? doc)?._source ?? {};
    expect(src.retrieved_count).toBe(ids.length);
    expect(src.project_id).toBe("integration");
    expect(src.task_id).toBe("task-1");
  });
});
