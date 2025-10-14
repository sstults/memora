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

// This integration test validates the "context fallback" path in memory.retrieve:
// When no active context is set, the route should fall back to defaults
// (MEMORA_DEFAULT_TENANT or "memora", MEMORA_DEFAULT_PROJECT or "benchmarks")
// and still retrieve episodic results.
//
// How to run (requires OpenSearch via docker-compose):
//   docker compose -f docker/docker-compose.yml up -d
//   INTEGRATION=1 npx vitest run tests/integration/retrieve.context_fallback.integration.spec.ts
//
// Note: This test focuses on episodic retrieval only and does not require semantic hits.

const run = process.env.INTEGRATION === "1";

describe.runIf(run)(
  "memory.retrieve context fallback (OpenSearch required)",
  () => {
    const EPISODIC_PREFIX = process.env.MEMORA_EPI_PREFIX || "mem-episodic-";
    const episodicToday = `${EPISODIC_PREFIX}${new Date()
      .toISOString()
      .slice(0, 10)}`;

    // Minimal test harness that can accept the 4-arg server.tool signature:
    // server.tool(name, description, schema, handler)
    // We only capture the handler in a map for direct invocation.
    const tools = new Map<string, ToolFn>();
    const server = {
      tool: (...args: any[]) => {
        const name = args[0];
        const handler = args[args.length - 1];
        if (typeof handler === "function") {
          tools.set(name, handler);
        }
      }
    };

    beforeAll(async () => {
      // Ensure cluster is healthy and episodic template/index exist
      await assertHealthy();

      const episodicTemplate = JSON.parse(
        fs.readFileSync("config/index-templates/mem-episodic.json", "utf8")
      );
      await putIndexTemplate("mem-episodic", episodicTemplate);
      await ensureIndex(episodicToday);

      // Register tools (no active context set intentionally for this test)
      registerContext(server as any);
      registerMemory(server as any);
    });

    it("retrieves snippets without active context via fallback defaults", async () => {
      const write = tools.get("memory.write")!;
      const retrieve = tools.get("memory.retrieve")!;

      const tenant = process.env.MEMORA_DEFAULT_TENANT || "memora";
      const project = process.env.MEMORA_DEFAULT_PROJECT || "benchmarks";
      const marker = "UniqueMarker_FALLBACK_EPI_1";
      const content = `Context fallback IT: ${marker}. Simple episodic text for BM25 retrieval.`;

      // Write explicitly providing tenant/project since no active context is set
      const wres = await write({
        tenant_id: tenant,
        project_id: project,
        role: "tool",
        content,
        tags: ["test", "integration", "it-fallback"]
      });

      expect(wres?.ok).toBe(true);
      expect(typeof wres?.event_id).toBe("string");

      // Retrieve WITHOUT setting active context; should use fallback tenant/project
      const rres = await retrieve({
        objective: marker,
        budget: 6,
        filters: {
          // limit to the tag we just wrote
          tags: ["it-fallback"]
        }
      });

      expect(Array.isArray(rres?.snippets)).toBe(true);
      expect(rres.snippets.length).toBeGreaterThan(0);
      const texts = rres.snippets.map((s: any) => String(s.text || ""));
      expect(texts.some((t: string) => t.includes(marker))).toBe(true);
    });
  }
);
