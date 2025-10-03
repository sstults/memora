import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const originalEnv = { ...process.env };
const savedFetch: any = (globalThis as any).fetch;

async function importFresh() {
  vi.resetModules();
  // Import fresh after env changes so module-level constants pick them up
  return await import("../../../src/services/embedder");
}

describe("embedder", () => {

  afterEach(() => {
    process.env = { ...originalEnv };
    (globalThis as any).fetch = savedFetch;
    vi.restoreAllMocks();
  });

  it("falls back to deterministic local embeddings when no endpoint is configured", async () => {
    delete process.env.EMBEDDING_ENDPOINT;
    const { embed, embedBatch } = await importFresh();

    const v = await embed("hello", 64);
    expect(v.length).toBe(64);
    // Unit normalized
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    expect(Math.abs(norm - 1)).toBeLessThan(1e-6);

    // Deterministic
    const v2 = await embed("hello", 64);
    expect(v).toEqual(v2);

    // Batch shape
    const b = await embedBatch(["a", "b"], 32);
    expect(b.length).toBe(2);
    expect(b[0].length).toBe(32);
    expect(b[1].length).toBe(32);
  });

  it("uses remote endpoint when configured and falls back on failure", async () => {
    process.env.EMBEDDING_ENDPOINT = "http://localhost:65535/does-not-exist";
    (globalThis as any).fetch = vi.fn().mockRejectedValue(new Error("network down"));
    const { embed } = await importFresh();

    const vec = await embed("remote-fail-text", 16);
    // Should have fallen back to local path; still normalized with correct dim
    expect(vec.length).toBe(16);
    const norm = Math.sqrt(vec.reduce((s, x) => s + x * x, 0));
    expect(Math.abs(norm - 1)).toBeLessThan(1e-6);
  });

  it("accepts well-formed remote response and normalizes vectors", async () => {
    process.env.EMBEDDING_ENDPOINT = "http://example.com/embed";
    // Mock a valid remote response with non-normalized vectors
    (globalThis as any).fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ vectors: [[2, 0, 0, 0], [0, 3, 0, 0]] })
    });

    const { embedBatch } = await importFresh();
    const out = await embedBatch(["x", "y"], 4);
    expect(out.length).toBe(2);
    // Should be normalized
    const n0 = Math.sqrt(out[0].reduce((s, x) => s + x * x, 0));
    const n1 = Math.sqrt(out[1].reduce((s, x) => s + x * x, 0));
    expect(Math.abs(n0 - 1)).toBeLessThan(1e-6);
    expect(Math.abs(n1 - 1)).toBeLessThan(1e-6);
  });
});
