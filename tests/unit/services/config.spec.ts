import { describe, it, expect } from "vitest";

async function importFresh() {
  // Ensure we load a fresh copy (caches reset by module on demand)
  const mod = await import("../../../src/services/config");
  return mod;
}

describe("config readers - real YAML", () => {
  it("reads retrieval numbers from config/retrieval.yaml", async () => {
    const { retrievalNumber } = await importFresh();
    expect(retrievalNumber("stages.episodic.top_k", 0)).toBe(25);
    expect(retrievalNumber("stages.semantic.ann_candidates", 0)).toBe(200);
    expect(retrievalNumber("fusion.rrf_k", 0)).toBe(60);
  });

  it("reads retrieval arrays from config/retrieval.yaml", async () => {
    const { retrievalArray } = await importFresh();
    expect(retrievalArray("filters.exclude_tags", [])).toEqual(["secret", "sensitive"]);
  });

  it("reads policies from config/memory_policies.yaml", async () => {
    const { policyNumber, policyArray } = await importFresh();
    expect(policyNumber("salience.min_score", 0)).toBeCloseTo(0.6, 5);
    expect(policyNumber("ttl.semantic_days", 0)).toBe(180);
    expect(policyArray("scopes.valid_scopes", [])).toEqual(["this_task", "project", "global"]);
  });

  it("returns defaults for unknown paths", async () => {
    const { retrievalNumber, retrievalArray, policyNumber, policyArray } = await importFresh();
    expect(retrievalNumber("stages.missing.value", 123)).toBe(123);
    expect(retrievalArray("filters.missing_list", ["a"])).toEqual(["a"]);
    expect(policyNumber("ttl.missing", 42)).toBe(42);
    expect(policyArray("scopes.missing", ["x"])).toEqual(["x"]);
  });

  it("exposes packing config loader (smoke test only)", async () => {
    const { getPackingConfig } = await importFresh();
    const packing = getPackingConfig();
    expect(packing).toBeTruthy();
    // Known keys from config/packing.yaml
    expect(Array.isArray(packing.order)).toBe(true);
    expect(typeof packing.limits?.max_tokens).toBe("number");
  });
});
