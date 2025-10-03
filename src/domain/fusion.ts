// src/domain/fusion.ts
// Score fusion (RRF) + optional diversification (MMR) for multi-stage retrieval.

export type Source = "episodic" | "semantic" | "facts";

export interface Hit {
  id: string;                 // unique doc id (e.g., mem:abc or evt:xyz)
  text?: string;              // snippet text (optional at this layer)
  score: number;              // source-specific score (higher is better)
  rank?: number;              // 1-based rank within its source list
  source: Source;
  tags?: string[];
  why?: string;               // short reason/explanation
  meta?: Record<string, any>; // arbitrary metadata
}

export interface FusionOptions {
  // Reciprocal Rank Fusion params
  rrfK?: number;              // typical default 60
  normalizeScores?: boolean;  // z-score normalization within each source
  // Deduplication
  dedupe?: boolean;           // remove duplicate ids across sources
  // MMR diversity
  mmr?: {
    enabled: boolean;
    lambda?: number;          // relevance vs novelty tradeoff (0..1). higher favors relevance
    minDistance?: number;     // if cosine distance below this, treat as near-duplicate
    maxPerTag?: number;       // cap per tag (e.g., avoid "error" dominating)
  };
  // Final selection
  limit?: number;             // top-K to return
}

const DEFAULT_OPTS: Required<FusionOptions> = {
  rrfK: 60,
  normalizeScores: true,
  dedupe: true,
  mmr: { enabled: true, lambda: 0.7, minDistance: 0.2, maxPerTag: 3 },
  limit: 12
};

/** Z-score normalize scores per source list (mutates copies) */
export function normalizePerSource(lists: Hit[][]): Hit[][] {
  return lists.map(list => {
    if (list.length === 0) return list;
    const mean = list.reduce((s, h) => s + h.score, 0) / list.length;
    const variance = list.reduce((s, h) => s + Math.pow(h.score - mean, 2), 0) / Math.max(1, list.length - 1);
    const std = Math.sqrt(variance) || 1;
    return list.map((h, i) => ({ ...h, score: (h.score - mean) / std, rank: i + 1 }));
  });
}

/** Reciprocal Rank Fusion over multiple ranked lists */
export function rrfFuse(lists: Hit[][], rrfK = 60): Hit[] {
  const scores: Record<string, { hit: Hit; score: number }> = {};
  for (const list of lists) {
    list.forEach((h, idx) => {
      const rank = (h.rank ?? idx + 1);
      const rrfScore = 1 / (rrfK + rank);
      const slot = scores[h.id];
      if (slot) {
        slot.score += rrfScore;
        // Prefer the highest-scoring provenance for fields like text/why
        if ((h.score ?? 0) > (slot.hit.score ?? 0)) slot.hit = h;
      } else {
        scores[h.id] = { hit: h, score: rrfScore };
      }
    });
  }
  return Object.values(scores)
    .map(({ hit, score }) => ({ ...hit, score })) // replace score with fused score
    .sort((a, b) => b.score - a.score);
}

/** Cosine similarity between two dense vectors (expects in meta.embedding) */
function cosineSim(a?: number[], b?: number[]): number {
  if (!a || !b || a.length !== b.length || a.length === 0) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Maximal Marginal Relevance diversification */
export function mmrDiversity(
  candidates: Hit[],
  k: number,
  lambda = 0.7,
  minDistance = 0.2,
  maxPerTag = 3
): Hit[] {
  const selected: Hit[] = [];
  const tagCounts = new Map<string, number>();

  while (selected.length < k && candidates.length > 0) {
    let bestIdx = 0;
    let bestScore = -Infinity;

    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i];

      // Enforce per-tag caps
      if (c.tags && c.tags.length > 0) {
        const overCap = c.tags.some(t => (tagCounts.get(t) ?? 0) >= maxPerTag);
        if (overCap) continue;
      }

      // Novelty = 1 - max cosine similarity to any selected
      let maxSim = 0;
      for (const s of selected) {
        const sim = cosineSim(c.meta?.embedding, s.meta?.embedding);
        if (sim > maxSim) maxSim = sim;
      }
      const novelty = 1 - Math.max(maxSim, 1 - minDistance); // clamp near-duplicates
      const mmr = lambda * c.score + (1 - lambda) * novelty;

      if (mmr > bestScore) { bestScore = mmr; bestIdx = i; }
    }

    const chosen = candidates.splice(bestIdx, 1)[0];
    selected.push(chosen);
    // update tag counts
    chosen.tags?.forEach(t => tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1));
  }

  return selected;
}

/** Merge duplicate ids within a list by keeping highest score and merging metadata */
export function dedupeById(list: Hit[]): Hit[] {
  const map = new Map<string, Hit>();
  for (const h of list) {
    const ex = map.get(h.id);
    if (!ex) {
      // First time seeing this id
      map.set(h.id, { ...h });
      continue;
    }

    if (h.score > ex.score) {
      // Replace with higher-scoring hit but merge tags/meta from previous
      map.set(h.id, {
        ...ex,
        ...h,
        tags: mergeTags(ex.tags, h.tags),
        meta: { ...(ex.meta || {}), ...(h.meta || {}) }
      });
    } else {
      // Keep existing winner; merge incremental info from current
      ex.tags = mergeTags(ex.tags, h.tags);
      ex.why = ex.why ?? h.why;
      ex.meta = { ...(ex.meta || {}), ...(h.meta || {}) };
    }
  }
  return Array.from(map.values());
}

function mergeTags(a?: string[], b?: string[]): string[] | undefined {
  if (!a && !b) return undefined;
  return Array.from(new Set([...(a ?? []), ...(b ?? [])]));
}

/** End-to-end helper: normalize → RRF fuse → dedupe → (optional) MMR diversify → top-K */
export function fuseAndDiversify(
  episodic: Hit[],
  semantic: Hit[],
  facts: Hit[],
  options?: FusionOptions
): Hit[] {
  const opts = { ...DEFAULT_OPTS, ...(options || {}), mmr: { ...DEFAULT_OPTS.mmr, ...(options?.mmr || {}) } };

  const lists = opts.normalizeScores ? normalizePerSource([episodic, semantic, facts]) : [episodic, semantic, facts];

  let fused = rrfFuse(lists, opts.rrfK);
  if (opts.dedupe) fused = dedupeById(fused);

  if (opts.mmr.enabled) {
    // MMR expects candidate embeddings in meta.embedding; if missing, it still uses scores for relevance.
    fused = mmrDiversity(fused, opts.limit, opts.mmr.lambda, opts.mmr.minDistance, opts.mmr.maxPerTag);
  } else {
    fused = fused.slice(0, opts.limit);
  }

  return fused;
}
