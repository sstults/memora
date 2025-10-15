import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "fs";

// Keep consistent with existing config tests: dynamic import to avoid cache bleed
async function importFresh() {
  const mod = await import("../../../src/services/config");
  return mod as any;
}

const ORIGINAL_READ = fs.readFileSync;

afterEach(async () => {
  // Clean up env to avoid cross-test contamination
  delete process.env.MEMORA_RETRIEVAL_CONFIG_PATH;
  delete process.env.MEMORA_RETRIEVAL_OVERRIDES_FILE;
  delete process.env.MEMORA_RETRIEVAL_OVERRIDES_JSON;

  try {
    const mod = await importFresh();
    if (mod.__resetConfigCaches) mod.__resetConfigCaches();
  } catch {
    // ignore
  }
});

describe("retrieval fallbacks flags (episodic_relax_tags / episodic_recent_docs)", () => {
  it("defaults to false per retrieval.yaml", async () => {
    const { retrievalBoolean, __resetConfigCaches } = await importFresh();
    __resetConfigCaches();

    // Assert default values (retrieval.yaml has both set to false)
    expect(retrievalBoolean("fallbacks.episodic_relax_tags", true)).toBe(false);
    expect(retrievalBoolean("fallbacks.episodic_recent_docs", true)).toBe(false);
  });

  it("honors MEMORA_RETRIEVAL_OVERRIDES_JSON toggles (true)", async () => {
    // Point to actual base config but rely on JSON override precedence
    process.env.MEMORA_RETRIEVAL_OVERRIDES_JSON = JSON.stringify({
      fallbacks: {
        episodic_relax_tags: true,
        episodic_recent_docs: true
      }
    });

    const { retrievalBoolean, __resetConfigCaches } = await importFresh();
    __resetConfigCaches();

    // JSON overrides should flip both to true
    expect(retrievalBoolean("fallbacks.episodic_relax_tags", false)).toBe(true);
    expect(retrievalBoolean("fallbacks.episodic_recent_docs", false)).toBe(true);
  });

  it("honors MEMORA_RETRIEVAL_OVERRIDES_FILE then JSON (JSON wins)", async () => {
    // File sets only one flag to true, JSON flips the other
    process.env.MEMORA_RETRIEVAL_OVERRIDES_FILE = "retrieval.fallbacks.overrides.json";
    process.env.MEMORA_RETRIEVAL_OVERRIDES_JSON = JSON.stringify({
      fallbacks: { episodic_recent_docs: true } // JSON should override/augment
    });

    const fileOverrides = {
      fallbacks: { episodic_relax_tags: true, episodic_recent_docs: false }
    };

    const spy = vi.spyOn(fs, "readFileSync").mockImplementation((p: any, enc?: any) => {
      const path = String(p);
      if (path.endsWith("retrieval.fallbacks.overrides.json")) {
        return JSON.stringify(fileOverrides);
      }
      // Call through to original for all other reads
      return Reflect.apply(ORIGINAL_READ as any, fs as any, [p, enc]);
    });

    const { retrievalBoolean, __resetConfigCaches } = await importFresh();
    __resetConfigCaches();

    // Expect: relax_tags true (from file), recent_docs true (JSON overrides file=false)
    expect(retrievalBoolean("fallbacks.episodic_relax_tags", false)).toBe(true);
    expect(retrievalBoolean("fallbacks.episodic_recent_docs", false)).toBe(true);

    spy.mockRestore();
  });
});
