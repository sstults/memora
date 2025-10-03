import { describe, it, expect } from "vitest";
import { packPrompt } from "../../../src/services/packer";

function approxTokens(s: string) {
  return Math.ceil(s.length / 4);
}

describe("packer.packPrompt", () => {
  it("packs sections in configured order and respects per-section budgets", () => {
    const sections = [
      { name: "recent_turns", content: "turn1\n---TURN---\nturn2\n---TURN---\nturn3" },
      { name: "system", content: "system content".repeat(10) },
      { name: "task_frame", content: "task content".repeat(10) },
      { name: "tool_state", content: "tool content".repeat(10) },
      { name: "retrieved", content: "retrieved line 1\nretrieved line 2\nsome/anchor.txt\nERROR-1234\n" + "x".repeat(2000) }
    ];

    const out = packPrompt(sections);
    // Order headers should appear in configured sequence
    const sysIdx = out.indexOf("## System");
    const taskIdx = out.indexOf("## Task");
    const toolIdx = out.indexOf("## Tools");
    const retrIdx = out.indexOf("## Retrieved Memory");
    const turnsIdx = out.indexOf("## Recent Turns");
    expect(sysIdx).toBeGreaterThanOrEqual(0);
    expect(taskIdx).toBeGreaterThan(sysIdx);
    expect(toolIdx).toBeGreaterThan(taskIdx);
    expect(retrIdx).toBeGreaterThan(toolIdx);
    expect(turnsIdx).toBeGreaterThan(retrIdx);

    // Should not exceed global max_tokens from config (approx check)
    expect(approxTokens(out)).toBeLessThanOrEqual(16384);
  });

  it("applies retrieved compression and preserves anchors", () => {
    const long = [
      "foo/bar.txt some long content that will be compressed",
      "ERROR-99 should be preserved",
      "A very long line: " + "Z".repeat(3000)
    ].join("\n");
    const out = packPrompt([
      { name: "retrieved", content: long }
    ]);
    const retrievedBlock = out.split("## Retrieved Memory")[1] || "";
    expect(retrievedBlock).toContain("foo/bar.txt");
    expect(retrievedBlock).toContain("ERROR-99");
    // Very long line should have been truncated with an ellipsis
    expect(retrievedBlock).toContain("…");
  });

  it("trims recent turns beyond max_turns", () => {
    const turns = Array.from({ length: 15 }, (_, i) => `turn${i + 1}`).join("\n---TURN---\n");
    const out = packPrompt([{ name: "recent_turns", content: turns }]);
    const recentBlock = out.split("## Recent Turns")[1] || "";
    // Expect only last 10 turns to be present
    expect(recentBlock).toContain("turn6");
    expect(recentBlock).toContain("turn15");
    // Ensure exact-turn exclusion (avoid substring matches like "turn10")
    expect(recentBlock).not.toMatch(/\bturn1\b/);
    expect(recentBlock).not.toMatch(/\bturn5\b/);
  });
});
