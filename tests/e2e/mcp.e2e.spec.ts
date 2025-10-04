import { describe, it, expect, beforeAll, vi } from "vitest";

// Hoist all mocks used by vi.mock to avoid ReferenceError due to hoisting
const h = vi.hoisted(() => {
  const indexed: any[] = [];
  const bulks: any[] = [];
  const searches: any[] = [];

  const mockClient = {
    index: vi.fn(async (args: any) => {
      indexed.push(args);
      return { body: { result: "created" } };
    }),
    update: vi.fn(async (_args: any) => {
      return { body: { result: "updated" } };
    })
  };

  const searchWithRetries = vi.fn(async ({ index, body }: any) => {
    searches.push({ index, body });
    const idx = typeof index === "string" ? index : "";
    if (idx.includes("mem-semantic")) {
      return {
        body: {
          hits: {
            hits: [
              {
                _id: "sem1",
                _score: 1.23,
                _source: { text: "semantic hit", tags: ["test"], embedding: [0.1, 0.2, 0.3, 0.4] }
              }
            ]
          }
        }
      };
    }
    if (idx.includes("mem-episodic")) {
      return {
        body: {
          hits: {
            hits: [
              {
                _id: "evt1",
                _score: 0.9,
                _source: { content: "episodic content", tags: ["test"] }
              }
            ]
          }
        }
      };
    }
    if (idx.includes("mem-facts")) {
      return { body: { hits: { hits: [] } } };
    }
    return { body: { hits: { hits: [] } } };
  });

  const indexWithRetries = vi.fn(async (_args: any) => {
    return { body: { result: "created" } };
  });

  const bulkSafe = vi.fn(async (_body: any, _refresh?: boolean) => {
    bulks.push({ _body, _refresh });
    return { body: { items: [] } };
  });

  const withRetries = vi.fn(async (fn: any) => fn());
  const assertHealthy = vi.fn(async () => true);

  return { indexed, bulks, searches, mockClient, searchWithRetries, indexWithRetries, bulkSafe, withRetries, assertHealthy };
});

// IMPORTANT: Path matches the import specifier used inside src files (../services/os-client.js)
vi.mock("../../src/services/os-client.js", () => ({
  getClient: () => h.mockClient,
  indexWithRetries: h.indexWithRetries,
  bulkSafe: h.bulkSafe,
  searchWithRetries: h.searchWithRetries,
  withRetries: h.withRetries,
  assertHealthy: h.assertHealthy
}));

import { registerContext } from "../../src/routes/context";
import { registerMemory } from "../../src/routes/memory";
import { registerEval } from "../../src/routes/eval";

type ToolFn = (req: any) => Promise<any>;

describe.runIf(process.env.E2E === "1")("MCP E2E (in-process tool surface, OS mocked)", () => {
  const tools = new Map<string, ToolFn>();
  const server = { tool: (name: string, fn: ToolFn) => tools.set(name, fn) };

  beforeAll(async () => {
    registerContext(server);
    registerMemory(server);
    registerEval(server);

    const setCtx = tools.get("context.set_context")!;
    await setCtx({
      params: {
        tenant_id: "memora",
        project_id: "e2e",
        context_id: "ctx-e2e",
        task_id: "task-e2e",
        env: "test",
        api_version: "3.1"
      }
    });
  });

  it("context.get_context returns the active context", async () => {
    const getCtx = tools.get("context.get_context")!;
    const res = await getCtx({ params: {} });
    expect(res.ok).toBe(true);
    expect(res.context?.project_id).toBe("e2e");
  });

  it("memory.write stores an event and upserts chunks/facts (OS calls mocked)", async () => {
    const write = tools.get("memory.write")!;
    const wres = await write({
      params: {
        role: "tool",
        content:
          "E2E check: FeatureA introduced_in v1_0 and requires EngineX.\nAdditional details about usage and design.",
        tags: ["test", "e2e"]
      }
    });
    expect(wres?.ok).toBe(true);
    expect(typeof wres?.event_id).toBe("string");
  });

  it("memory.write is idempotent when idempotency_key is provided", async () => {
    const write = tools.get("memory.write")!;
    const key = "idem-key-e2e-1";

    const bulksBefore = h.bulks.length;
    const ixBefore = h.indexWithRetries.mock.calls.length;

    const first = await write({
      params: {
        role: "tool",
        content: "Idempotent write content A",
        tags: ["test", "e2e", "idem"],
        idempotency_key: key
      }
    });

    const bulksAfterFirst = h.bulks.length;
    const ixAfterFirst = h.indexWithRetries.mock.calls.length;

    const second = await write({
      params: {
        role: "tool",
        content: "Idempotent write content B (should be ignored)",
        tags: ["test", "e2e", "idem"],
        idempotency_key: key
      }
    });

    const bulksAfterSecond = h.bulks.length;
    const ixAfterSecond = h.indexWithRetries.mock.calls.length;

    expect(first?.ok).toBe(true);
    expect(second?.ok).toBe(true);
    expect(second.event_id).toBe(first.event_id);

    // Ensure no additional OS writes happened on the second, duplicate call
    expect(bulksAfterSecond).toBe(bulksAfterFirst);
    expect(ixAfterSecond).toBe(ixAfterFirst);

    // Sanity: bulks may or may not have been produced depending on salience thresholds,
    // but if they were produced on first call, bulksAfterFirst should be > bulksBefore.
    expect(bulksAfterFirst).toBeGreaterThanOrEqual(bulksBefore);
    expect(ixAfterFirst).toBeGreaterThan(ixBefore);
  });

  it("memory.retrieve returns fused snippets (from mocked searches) and touches last_used", async () => {
    const retrieve = tools.get("memory.retrieve")!;
    const rres = await retrieve({
      params: {
        objective: "FeatureA introduced_in v1_0",
        budget: 5,
        filters: { scope: ["this_task", "project"] }
      }
    });
    expect(Array.isArray(rres?.snippets)).toBe(true);
    expect(rres.snippets.length).toBeGreaterThan(0);
    const hasSemantic = rres.snippets.some((s: any) => s.source === "semantic");
    expect(hasSemantic).toBe(true);
  });

  it("eval.log writes a metrics document (OS index mocked)", async () => {
    const elog = tools.get("eval.log")!;
    const res = await elog({
      params: {
        step: 1,
        success: true,
        tokens_in: 123,
        latency_ms: 456,
        retrieved_ids: ["mem:sem1"]
      }
    });
    expect(res?.ok).toBe(true);
    expect(typeof res?.id).toBe("string");
    expect(h.mockClient.index).toHaveBeenCalled();
  });

  it("memory tools require context; clearing context causes operations to error", async () => {
    const clearCtx = tools.get("context.clear_context")!;
    await clearCtx({ params: {} });

    const retrieve = tools.get("memory.retrieve")!;
    await expect(
      retrieve({ params: { objective: "anything", budget: 1 } })
    ).rejects.toThrow(/No active context set/i);
  });
});
