import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Hit as FusedHit } from "../../../src/domain/fusion";

// IMPORTANT: Mock the OS-ML module BEFORE importing rerank.ts (which imports ./os-ml.js)
vi.mock("../../../src/services/os-ml.js", () => {
  return {
    predictRerankScores: vi.fn()
  };
});

async function importRerank() {
  // Dynamic import to ensure env vars and mocks are applied
  return await import("../../../src/services/rerank");
}

describe("rerank service — OpenSearch ML path", () => {
  beforeEach(() => {
    vi.resetModules();
    // Clean global fetch by default; tests will set if needed
    delete (globalThis as any).fetch;

    // Default envs
    process.env.RERANK_TIMEOUT_MS = "1500";
    process.env.RERANK_MAX_RETRIES = "0";
    process.env.MEMORA_RERANK_ENABLED = "true";

    // Ensure remote endpoint is disabled unless a test needs it
    delete process.env.RERANK_ENDPOINT;
    delete process.env.RERANK_API_KEY;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.MEMORA_RERANK_ENABLED;
    delete process.env.OPENSEARCH_ML_RERANK_MODEL_ID;
    delete process.env.OPENSEARCH_ML_RERANK_TIMEOUT_MS;
    delete process.env.RERANK_ENDPOINT;
    delete process.env.RERANK_API_KEY;
  });

  it("uses OpenSearch ML rerank when OPENSEARCH_ML_RERANK_MODEL_ID is set", async () => {
    // Enable OS-ML rerank with model id
    process.env.OPENSEARCH_ML_RERANK_MODEL_ID = "abc-model";
    process.env.OPENSEARCH_ML_RERANK_TIMEOUT_MS = "1200";
    // Ensure remote endpoint is absent so only OS-ML path is exercised
    delete process.env.RERANK_ENDPOINT;

    // Configure OS-ML mock to return scores for first 3 candidates
    const osml = await import("../../../src/services/os-ml");
    (osml as any).predictRerankScores.mockResolvedValue([0.2, 0.9, 0.1]);

    const { crossRerank } = await importRerank();

    const hits: FusedHit[] = [
      { id: "h1", text: "t1", score: 0.0, source: "semantic" },
      { id: "h2", text: "t2", score: 0.0, source: "semantic" },
      { id: "h3", text: "t3", score: 0.0, source: "semantic" },
      { id: "h4", text: "t4", score: 0.0, source: "semantic" },
      { id: "h5", text: "t5", score: 0.0, source: "semantic" }
    ];

    const out = await crossRerank("q", hits as any, { maxCandidates: 3, budgetMs: 800 });

    // Expect OS-ML called once
    expect((osml as any).predictRerankScores).toHaveBeenCalledTimes(1);
    const args = (osml as any).predictRerankScores.mock.calls[0][0];
    expect(args.modelId).toBe("abc-model");
    expect(Array.isArray(args.texts)).toBe(true);
    expect(args.texts).toHaveLength(3);

    // Candidates reordered by scores from OS-ML: h2 (0.9), h1 (0.2), h3 (0.1)
    const expectedHead = ["h2", "h1", "h3"];
    expect(out.slice(0, 3).map(h => h.id)).toEqual(expectedHead);

    // Tail preserved in original order for non-candidates
    expect(out.slice(3).map(h => h.id)).toEqual(["h4", "h5"]);
  });

  it("falls back to remote rerank when OS-ML predict throws, then uses remote scores", async () => {
    process.env.MEMORA_RERANK_ENABLED = "true";
    process.env.OPENSEARCH_ML_RERANK_MODEL_ID = "abc-model";
    process.env.RERANK_ENDPOINT = "http://localhost:8081/rerank";

    // OS-ML throws -> triggers fallback
    const osml = await import("../../../src/services/os-ml");
    (osml as any).predictRerankScores.mockRejectedValue(new Error("os-ml boom"));

    // Remote endpoint mock returns deterministic scores
    const remoteScores = [0.7, 0.3];
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ scores: remoteScores })
    });
    (globalThis as any).fetch = fetchMock;

    const { crossRerank } = await importRerank();

    const hits: FusedHit[] = [
      { id: "x1", text: "foo", score: 0.0, source: "semantic" },
      { id: "x2", text: "bar", score: 0.0, source: "semantic" }
    ];

    const out = await crossRerank("beta", hits as any, { maxCandidates: 2, budgetMs: 600 });

    // Ensure remote was called since OS-ML failed
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const sentBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(sentBody.candidates).toHaveLength(2);

    // Remote scores reorder: x1 (0.7), x2 (0.3)
    expect(out.map(h => h.id)).toEqual(["x1", "x2"]);
  });

  it("falls back to local rerank when both OS-ML and remote fail or are absent", async () => {
    process.env.MEMORA_RERANK_ENABLED = "true";
    process.env.OPENSEARCH_ML_RERANK_MODEL_ID = "abc-model";
    // No remote endpoint set
    delete process.env.RERANK_ENDPOINT;

    // OS-ML fails
    const osml = await import("../../../src/services/os-ml");
    (osml as any).predictRerankScores.mockRejectedValue(new Error("os-ml fail"));

    const { crossRerank } = await importRerank();

    const hits: FusedHit[] = [
      { id: "a", text: "alpha delta", score: 0.2, source: "semantic" },
      { id: "b", text: "beta beta marker", score: 0.1, source: "semantic" },
      { id: "c", text: "gamma epsilon", score: 0.9, source: "semantic" }
    ];

    const out = await crossRerank("beta marker", hits as any, { maxCandidates: 3, budgetMs: 800 });

    // Local fallback should prefer "b" due to lexical overlap
    expect(out[0].id).toBe("b");
    const ids = out.map(h => h.id).sort();
    expect(ids).toEqual(["a", "b", "c"].sort());
  });
});
