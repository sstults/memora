import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "fs";

async function importFresh() {
  // Dynamic import to avoid module cache across tests
  const mod = await import("../../../src/services/config");
  return mod as any;
}

const ORIGINAL_READ = fs.readFileSync;

afterEach(async () => {
  vi.restoreAllMocks();
  // Clean up env vars to avoid cross-test contamination
  delete process.env.MEMORA_RETRIEVAL_CONFIG_PATH;
  delete process.env.MEMORA_RETRIEVAL_OVERRIDES_FILE;
  delete process.env.MEMORA_RETRIEVAL_OVERRIDES_JSON;

  // Reset caches if module already loaded
  try {
    const mod = await importFresh();
    if (mod.__resetConfigCaches) mod.__resetConfigCaches();
  } catch {
    // ignore if import fails
  }
});

describe("retrieval config overrides", () => {
  it("loads from MEMORA_RETRIEVAL_CONFIG_PATH and applies MEMORA_RETRIEVAL_OVERRIDES_JSON", async () => {
    process.env.MEMORA_RETRIEVAL_CONFIG_PATH = "retrieval.alt.yaml";
    process.env.MEMORA_RETRIEVAL_OVERRIDES_JSON = JSON.stringify({
      stages: { semantic: { top_k: 123 } },
      rerank: { enabled: true }
    });

    const altYaml = `
stages:
  episodic:
    enabled: true
  semantic:
    top_k: 77
rerank:
  enabled: false
`;

    const spy = vi.spyOn(fs, "readFileSync").mockImplementation((p: any, enc?: any) => {
      const path = String(p);
      if (path.endsWith("retrieval.alt.yaml")) {
        return altYaml;
      }
      // Fallback to original for any other reads (e.g., policies/packing)
      // Call through to original reader for other files
      return Reflect.apply(ORIGINAL_READ as any, fs as any, [p, enc]);
    });

    const {
      retrievalNumber,
      retrievalBoolean,
      __resetConfigCaches
    } = await importFresh();

    // Ensure caches start fresh
    __resetConfigCaches();

    // JSON overrides should take precedence over file/base values
    expect(retrievalNumber("stages.semantic.top_k", 0)).toBe(123);
    // Boolean remains true from base YAML despite JSON not touching it
    expect(retrievalBoolean("stages.episodic.enabled", false)).toBe(true);
    // JSON overrides toggles rerank.enabled to true (base said false)
    expect(retrievalBoolean("rerank.enabled", false)).toBe(true);

    spy.mockRestore();
  });

  it("applies MEMORA_RETRIEVAL_OVERRIDES_FILE then MEMORA_RETRIEVAL_OVERRIDES_JSON (JSON precedence)", async () => {
    process.env.MEMORA_RETRIEVAL_CONFIG_PATH = "retrieval.base.yaml";
    process.env.MEMORA_RETRIEVAL_OVERRIDES_FILE = "overrides.json";
    process.env.MEMORA_RETRIEVAL_OVERRIDES_JSON = JSON.stringify({
      stages: { semantic: { top_k: 200 } } // JSON should override file's value
    });

    const baseYaml = `
stages:
  semantic:
    top_k: 10
rerank:
  enabled: false
`;

    const fileOverrides = {
      stages: { semantic: { top_k: 50 } },
      rerank: { enabled: true }
    };

    const spy = vi.spyOn(fs, "readFileSync").mockImplementation((p: any, enc?: any) => {
      const path = String(p);
      if (path.endsWith("retrieval.base.yaml")) {
        return baseYaml;
      }
      if (path.endsWith("overrides.json")) {
        return JSON.stringify(fileOverrides);
      }
      // Call through to original reader for other files
      return Reflect.apply(ORIGINAL_READ as any, fs as any, [p, enc]);
    });

    const {
      retrievalNumber,
      retrievalBoolean,
      __resetConfigCaches
    } = await importFresh();

    __resetConfigCaches();

    // Expect JSON override (200) to win over file override (50) and base (10)
    expect(retrievalNumber("stages.semantic.top_k", 0)).toBe(200);
    // Expect file override to apply for keys not touched by JSON
    expect(retrievalBoolean("rerank.enabled", false)).toBe(true);

    spy.mockRestore();
  });
});
