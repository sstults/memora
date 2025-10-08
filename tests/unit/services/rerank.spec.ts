import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Hit as FusedHit } from "../../../src/domain/fusion";

/**
 * Note: src/services/rerank.ts reads certain env vars at module import time.
 * Tests use dynamic import after setting process.env and vi.resetModules()
 * to exercise both local fallback and remote endpoint paths.
 */


async function importRerank() {
  // Dynamic import to pick up current env and mocks
  return await import("../../../src/services/rerank");
}

describe("rerank service", () => {
  beforeEach(() => {
    vi.resetModules();
    delete (globalThis as any).fetch;
    // Keep tests deterministic
    process.env.RERANK_TIMEOUT_MS = "1500";
    process.env.RERANK_MAX_RETRIES = "0";
    // Enable reranker by default for tests; individual tests may override
    process.env.MEMORA_RERANK_ENABLED = "true";
    // Ensure OS-ML rerank path is disabled by default unless explicitly enabled in a test
    delete process.env.OPENSEARCH_ML_RERANK_MODEL_ID;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.RERANK_ENDPOINT;
    delete process.env.RERANK_API_KEY;
    delete process.env.MEMORA_RERANK_ENABLED;
    delete process.env.OPENSEARCH_ML_RERANK_MODEL_ID;
  });

  it("local fallback reranks by lexical overlap when no endpoint configured", async () => {
    // Ensure no endpoint
    delete process.env.RERANK_ENDPOINT;
    vi.resetModules();
    const { crossRerank } = await importRerank();

    const hits: FusedHit[] = [
      { id: "a", text: "alpha delta", score: 0.2, source: "semantic" },
      { id: "b", text: "beta beta marker", score: 0.1, source: "semantic" },
      { id: "c", text: "gamma epsilon", score: 0.9, source: "semantic" }
    ];

    const out = await crossRerank("beta marker", hits);
    expect(out).toHaveLength(3);

    // "b" should come first due to strongest lexical overlap
    expect(out[0].id).toBe("b");
    // Others should still be present
    const ids = out.map(h => h.id);
    expect(ids.sort()).toEqual(["a", "b", "c"].sort());
  });

  it("remote rerank uses endpoint scores and preserves tail order beyond maxCandidates", async () => {
    process.env.RERANK_ENDPOINT = "http://localhost:8081/rerank";
    // Mock fetch happy-path
    const scores = [0.2, 0.9, 0.1]; // for first 3 candidates
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ scores })
    });
    (globalThis as any).fetch = fetchMock;

    vi.resetModules();
    const { crossRerank } = await importRerank();

    const hits: FusedHit[] = [
      { id: "h1", text: "t1", score: 0.0, source: "semantic" },
      { id: "h2", text: "t2", score: 0.0, source: "semantic" },
      { id: "h3", text: "t3", score: 0.0, source: "semantic" },
      { id: "h4", text: "t4", score: 0.0, source: "semantic" },
      { id: "h5", text: "t5", score: 0.0, source: "semantic" }
    ];

    const out = await crossRerank("q", hits as any, { maxCandidates: 3, budgetMs: 800 });

    // Expect fetch called once with 3 candidates
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const bodySent = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(bodySent.candidates).toHaveLength(3);

    // Candidates reordered by scores: h2 (0.9), h1 (0.2), h3 (0.1)
    const expectedHead = ["h2", "h1", "h3"];
    expect(out.slice(0, 3).map(h => h.id)).toEqual(expectedHead);

    // Tail preserved in original order for non-candidates
    expect(out.slice(3).map(h => h.id)).toEqual(["h4", "h5"]);
  });

  it("falls back to local rerank when remote endpoint returns non-OK", async () => {
    process.env.RERANK_ENDPOINT = "http://localhost:8081/rerank";
    // Mock fetch to return HTTP 500
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => "server error"
    });
    (globalThis as any).fetch = fetchMock;

    vi.resetModules();
    const { crossRerank } = await importRerank();

    const hits: FusedHit[] = [
      { id: "x1", text: "foo beta", score: 0.0, source: "semantic" },
      { id: "x2", text: "bar baz", score: 0.0, source: "semantic" }
    ];

    const out = await crossRerank("beta query", hits as any, { maxCandidates: 2, budgetMs: 500 });
    // Should still return same set and place x1 first due to lexical overlap with "beta"
    expect(out.map(h => h.id)).toEqual(["x1", "x2"]);
  });

  it("is a no-op when MEMORA_RERANK_ENABLED=false", async () => {
    process.env.MEMORA_RERANK_ENABLED = "false";
    vi.resetModules();
    const { crossRerank } = await importRerank();

    const hits: FusedHit[] = [
      { id: "a", text: "one", score: 0.0, source: "semantic" },
      { id: "b", text: "two", score: 0.0, source: "semantic" }
    ];

    const out = await crossRerank("query", hits as any, { maxCandidates: 2, budgetMs: 500 });
    expect(out.map(h => h.id)).toEqual(["a", "b"]);
  });

  it("clamps maxCandidates to 128 for remote rerank", async () => {
    process.env.RERANK_ENDPOINT = "http://localhost:8081/rerank";
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ scores: Array(128).fill(0).map((_, i) => 128 - i) })
    });
    (globalThis as any).fetch = fetchMock;

    vi.resetModules();
    const { crossRerank } = await importRerank();

    const hits: FusedHit[] = Array.from({ length: 140 }, (_, i) => ({
      id: `h${i + 1}`,
      text: `t${i + 1}`,
      score: 0.0,
      source: "semantic"
    }));

    await crossRerank("q", hits as any, { maxCandidates: 999, budgetMs: 800 });

    // Expect fetch called once with 128 candidates
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const bodySent = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(bodySent.candidates).toHaveLength(128);
  });
});
