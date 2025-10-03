import { describe, it, expect, beforeAll } from "vitest";
import fs from "fs";

import {
  assertHealthy,
  ensureIndex,
  putIndexTemplate
} from "../../src/services/os-client";
import { registerContext } from "../../src/routes/context";
import { registerMemory } from "../../src/routes/memory";

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
      "Integration check: FeatureA introduced_in v1_0 and requires EngineX.\nAdditional details about usage and design.";

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
});
