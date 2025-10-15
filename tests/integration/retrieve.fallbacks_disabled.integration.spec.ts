import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import path from "path";
import {
  assertHealthy,
  ensureIndex,
  putIndexTemplate
} from "../../src/services/os-client";
import { registerContext } from "../../src/routes/context";
import { registerMemory } from "../../src/routes/memory";

type ToolFn = (req: any) => Promise<any>;

const run = process.env.INTEGRATION === "1";

/**
 * Integration: when fallback3/4 flags are false (defaults in config/retrieval.yaml),
 * memory.retrieve must not execute or log episodic.fallback3/4 traces even with diagnostics enabled.
 *
 * How to run (requires OpenSearch via docker-compose):
 *   docker compose -f docker/docker-compose.yml up -d
 *   INTEGRATION=1 npx vitest run tests/integration/retrieve.fallbacks_disabled.integration.spec.ts
 */
describe.runIf(run)(
  "memory.retrieve does not execute fallback3/4 when flags are false (diagnostics on)",
  () => {
    const EPISODIC_PREFIX = process.env.MEMORA_EPI_PREFIX || "mem-episodic-";
    const episodicToday = `${EPISODIC_PREFIX}${new Date().toISOString().slice(0, 10)}`;

    // Use a dedicated trace file for this test to avoid reading the main retrieve.ndjson
    const TRACE_DIR = path.join(process.cwd(), "outputs", "test-trace");
    const TRACE_FILE = path.join(TRACE_DIR, "retrieve.fallbacks_disabled.ndjson");

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
      // Ensure health and episodic template/index
      await assertHealthy();
      const episodicTemplate = JSON.parse(
        fs.readFileSync("config/index-templates/mem-episodic.json", "utf8")
      );
      await putIndexTemplate("mem-episodic", episodicTemplate);
      await ensureIndex(episodicToday);

      // Prepare clean trace target and enable diagnostics (env override enables all categories)
      fs.mkdirSync(TRACE_DIR, { recursive: true });
      try { fs.unlinkSync(TRACE_FILE); } catch { /* ignore */ }
      process.env.MEMORA_TRACE_FILE = TRACE_FILE;
      process.env.MEMORA_DIAGNOSTICS = "1"; // enables guard/fallback/request-response logs

      // Register tools (no active context set intentionally)
      registerContext(server as any);
      registerMemory(server as any);
    });

    afterAll(() => {
      // Best-effort cleanup; keep file for inspection if needed
      // try { fs.unlinkSync(TRACE_FILE); } catch { /* ignore */ }
    });

    it("retrieves and emits no fallback3/4 markers when disabled", async () => {
      const write = tools.get("memory.write")!;
      const retrieve = tools.get("memory.retrieve")!;

      const tenant = process.env.MEMORA_DEFAULT_TENANT || "memora";
      const project = process.env.MEMORA_DEFAULT_PROJECT || "benchmarks";
      const marker = `UniqueMarker_FB34_OFF_${Date.now()}`;
      const content = `FB34-OFF IT: ${marker}. Simple episodic text for BM25 retrieval with tag filter.`;

      // Write explicit tenant/project since we intentionally have no active context
      const wres = await write({
        tenant_id: tenant,
        project_id: project,
        role: "tool",
        content,
        tags: ["it-fallback34-off", "integration"]
      });
      expect(wres?.ok).toBe(true);

      // Retrieve with tag filter to hit the above event via primary path
      const rres = await retrieve({
        objective: marker,
        budget: 8,
        filters: {
          tags: ["it-fallback34-off"]
        }
      });

      expect(Array.isArray(rres?.snippets)).toBe(true);
      expect(rres.snippets.length).toBeGreaterThan(0);
      const texts = rres.snippets.map((s: any) => String(s.text || ""));
      expect(texts.some((t: string) => t.includes(marker))).toBe(true);

      // Assert diagnostics were written
      expect(fs.existsSync(TRACE_FILE)).toBe(true);
      const trace = fs.readFileSync(TRACE_FILE, "utf8");

      // With diagnostics enabled, if fallback3/4 executed they would log:
      //   "episodic.fallback3.request"/"episodic.fallback3.response"
      //   "episodic.fallback4.request"/"episodic.fallback4.response"
      // Default flags are false per retrieval.yaml, so these must be absent.
      expect(trace.includes("episodic.fallback3.request")).toBe(false);
      expect(trace.includes("episodic.fallback3.response")).toBe(false);
      expect(trace.includes("episodic.fallback4.request")).toBe(false);
      expect(trace.includes("episodic.fallback4.response")).toBe(false);
    });
  }
);
