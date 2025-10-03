import { describe, it, expect } from "vitest";
import {
  normalizePerSource,
  rrfFuse,
  mmrDiversity,
  dedupeById,
  fuseAndDiversify,
  type Hit
} from "../../../src/domain/fusion";

function makeHit(id: string, score: number, source: "episodic" | "semantic" | "facts", tags?: string[], emb?: number[]): Hit {
  return { id, score, source, tags, meta: emb ? { embedding: emb } : undefined };
}

describe("fusion primitives", () => {
  it("normalizePerSource z-score normalizes and assigns rank", () => {
    const lists: Hit[][] = [
      [makeHit("a", 10, "episodic"), makeHit("b", 20, "episodic"), makeHit("c", 30, "episodic")],
      [makeHit("d", 1, "semantic"), makeHit("e", 2, "semantic")]
    ];
    const norm = normalizePerSource(lists);
    // Ranks are 1-based
    expect(norm[0][0].rank).toBe(1);
    expect(norm[0][2].rank).toBe(3);
    // Mean should be ~0 (approximate due to float)
    const mean0 = norm[0].reduce((s, h) => s + h.score, 0) / norm[0].length;
    expect(Math.abs(mean0)).toBeLessThan(1e-7);
  });

  it("rrfFuse fuses by reciprocal rank and sorts high to low", () => {
    const episodic = [makeHit("a", 5, "episodic"), makeHit("b", 4, "episodic")]; // implicit ranks 1,2
    const semantic = [makeHit("b", 0.5, "semantic"), makeHit("c", 0.3, "semantic")]; // ranks 1,2
    const fused = rrfFuse([episodic, semantic], 60);
    // b appears in both lists, should rank first
    expect(fused[0].id).toBe("b");
    // All unique ids present
    expect(new Set(fused.map(h => h.id))).toEqual(new Set(["a", "b", "c"]));
  });

  it("dedupeById keeps highest score and merges tags/meta", () => {
    const list: Hit[] = [
      { id: "x", score: 1, source: "episodic", tags: ["t1"], meta: { a: 1 } },
      { id: "x", score: 2, source: "semantic", tags: ["t2"], meta: { b: 2 } },
      { id: "y", score: 3, source: "facts" }
    ];
    const out = dedupeById(list);
    const x = out.find(h => h.id === "x")!;
    expect(x.score).toBe(2);
    expect(x.tags?.sort()).toEqual(["t1", "t2"]);
    expect(x.meta).toMatchObject({ a: 1, b: 2 });
    expect(out.find(h => h.id === "y")).toBeTruthy();
  });

  it("mmrDiversity selects up to k with per-tag caps and novelty", () => {
    // Build candidates with embeddings to simulate near-duplicates
    const base = [1, 0, 0, 0, 0];
    const near = [0.98, 0.01, 0, 0, 0];
    const far = [0, 1, 0, 0, 0];

    const candidates: Hit[] = [
      makeHit("a1", 0.9, "semantic", ["error"], base),
      makeHit("a2", 0.85, "semantic", ["error"], near), // near-duplicate of a1
      makeHit("b1", 0.8, "semantic", ["design"], far),
      makeHit("c1", 0.7, "semantic", ["error"], [0, 0, 1, 0, 0])
    ];

    const selected = mmrDiversity(candidates.slice(), 3, 0.7, 0.2, 2);
    expect(selected.length).toBe(3);
    // Should not pick both a1 and a2 before b1 due to novelty and per-tag caps
    const ids = selected.map(s => s.id);
    expect(ids).toContain("a1");
    expect(ids).toContain("b1");
  });
});

describe("fuseAndDiversify (end-to-end)", () => {
  it("normalizes, fuses, dedupes, applies MMR, and returns limit", () => {
    const episodic = [
      makeHit("evt:1", 10, "episodic", ["log"]),
      makeHit("evt:2", 9, "episodic", ["log"])
    ];
    const semantic = [
      makeHit("mem:1", 0.9, "semantic", ["fact"], [1, 0, 0]),
      makeHit("mem:2", 0.8, "semantic", ["error"], [0, 1, 0]),
      makeHit("evt:2", 0.7, "semantic", ["overlap"], [0, 0, 1]) // duplicate id across lists (intentional)
    ];
    const facts = [
      makeHit("fact:1", 0.6, "facts", ["fact"]),
      makeHit("fact:2", 0.5, "facts", ["fact"])
    ];

    const out = fuseAndDiversify(episodic, semantic, facts, {
      limit: 3,
      rrfK: 60,
      normalizeScores: true,
      dedupe: true,
      mmr: { enabled: true, lambda: 0.7, minDistance: 0.2, maxPerTag: 2 }
    });

    expect(out.length).toBe(3);
    // Duplicate id evt:2 should be deduped
    const ids = out.map(h => h.id);
    expect(ids.filter(id => id === "evt:2").length).toBeLessThanOrEqual(1);
  });

  it("when mmr disabled, returns top-K slice of fused list", () => {
    const episodic = [makeHit("e1", 2, "episodic"), makeHit("e2", 1, "episodic")];
    const semantic = [makeHit("s1", 3, "semantic")];
    const out = fuseAndDiversify(episodic, semantic, [], {
      limit: 2,
      normalizeScores: false,
      mmr: { enabled: false }
    });
    expect(out.length).toBe(2);
  });
});
