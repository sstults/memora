import { describe, it, expect, vi, afterEach } from "vitest";

async function importFreshWithConfig(yamlStr: string) {
  vi.resetModules();
  vi.doMock("fs", () => {
    return {
      __esModule: true,
      default: { readFileSync: () => yamlStr },
      readFileSync: () => yamlStr
    };
  });
  const mod = await import("../../../src/services/packer");
  return mod;
}

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
});

describe("packer.compressRetrieved without anchor preservation", () => {
  it("truncates by tokens when preserve_anchors is false", async () => {
    const yaml = `
order:
  - retrieved
limits:
  max_tokens: 1000
  max_snippets: 12
  budgets:
    retrieved: 1000
compression:
  retrieved:
    enabled: true
    min_tokens: 10
    preserve_anchors: false
  recent_turns:
    enabled: false
    max_turns: 10
`;
    const { packPrompt } = await importFreshWithConfig(yaml);
    const content = "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen";
    const out = packPrompt([{ name: "retrieved", content }]);
    expect(out).toContain("## Retrieved Memory");
    // Since preserve_anchors is false, compressRetrieved should call truncateByTokens to 10 tokens with ellipsis
    const block = out.split("## Retrieved Memory")[1] || "";
    expect(block.trim().split(/\s+/).length).toBeLessThanOrEqual(12); // 10 tokens + ellipsis glyph
    expect(block).toContain(" …");
  });
});

describe("packer.sectionHeader default branch", () => {
  it("renders unknown section names with default header", async () => {
    const yaml = `
order:
  - custom_section
limits:
  max_tokens: 1000
  max_snippets: 12
  budgets:
    custom_section: 100
compression:
  retrieved:
    enabled: false
    min_tokens: 200
    preserve_anchors: true
  recent_turns:
    enabled: false
    max_turns: 10
`;
    const { packPrompt } = await importFreshWithConfig(yaml);
    const out = packPrompt([{ name: "custom_section", content: "alpha beta gamma" }]);
    expect(out).toContain("## custom_section");
    expect(out).toContain("alpha beta gamma");
  });
});
