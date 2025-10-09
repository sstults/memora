import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "fs";

describe("config readers - booleans, defaults, and cache reset", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("coerces booleans from YAML values and respects defaults", async () => {
    const mod = await import("../../../src/services/config");
    const { retrievalBoolean, policyBoolean, retrievalArray } = mod as any;

    // True booleans from YAML
    expect(retrievalBoolean("stages.episodic.enabled", false)).toBe(true);
    expect(retrievalBoolean("stages.semantic.enabled", false)).toBe(true);
    expect(retrievalBoolean("diversity.enabled", false)).toBe(true);
    expect(retrievalBoolean("rerank.enabled", false)).toBe(true);

    // Numeric -> boolean coercion (non-zero => true)
    expect(retrievalBoolean("stages.episodic.top_k", false)).toBe(true);

    // Non-boolean string returns default
    expect(retrievalBoolean("fusion.method", true)).toBe(true);

    // Policies booleans from YAML
    expect(policyBoolean("ttl.renew_on_use", false)).toBe(true);
    expect(policyBoolean("promotion.require_human_for_global", false)).toBe(true);
    expect(policyBoolean("compression.enabled", false)).toBe(true);

    // Non-array path returns provided default
    expect(retrievalArray("rerank.model", ["x"])).toEqual(["x"]);
  });

  it("__resetConfigCaches() reloads YAML from disk on next access", async () => {
    const mod = await import("../../../src/services/config");
    const {
      retrievalNumber,
      retrievalBoolean,
      retrievalArray,
      __resetConfigCaches
    } = mod as any;

    // Prime caches with real file values
    expect(retrievalNumber("stages.semantic.top_k", 0)).toBe(150);

    // Mock a different YAML payload for subsequent reads
    const mockedYaml = `
stages:
  episodic:
    enabled: false
  semantic:
    top_k: 9
filters:
  exclude_tags: ["foo"]
`;
    const spy = vi.spyOn(fs, "readFileSync").mockReturnValue(mockedYaml);

    // Reset caches so next call re-loads from fs
    __resetConfigCaches();

    // Verify values reflect mocked YAML
    expect(retrievalNumber("stages.semantic.top_k", 0)).toBe(9);
    expect(retrievalBoolean("stages.episodic.enabled", true)).toBe(false);
    expect(retrievalArray("filters.exclude_tags", [])).toEqual(["foo"]);

    spy.mockRestore();
  });
});
