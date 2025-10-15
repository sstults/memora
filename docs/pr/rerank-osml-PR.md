# PR: Rerank Stage (feature/rerank-osml) — Gated, Off by Default

Summary
- Wire an optional rerank stage into memory.retrieve.
- Fully gated via config/env; Minimal POC defaults remain unchanged on main.
- Backend priority:
  1) OpenSearch ML cross-encoder (OPENSEARCH_ML_RERANK_MODEL_ID)
  2) Remote HTTP endpoint (RERANK_ENDPOINT, optional RERANK_API_KEY)
  3) Local deterministic fallback (lexical Jaccard + optional cosine blend if embeddings exist)

Why
- Improve candidate ordering when lexical top-k is noisy or multiple sources contribute.
- Keep off-by-default to preserve Minimal POC invariants on main.

Changes
1) Retrieval code (src/routes/memory.ts)
   - Import: { crossRerank } from ../services/rerank.js
   - After fusing candidates, apply rerank when enabled:
     - Config (config/retrieval.yaml defaults already present):
       - rerank.enabled: false
       - rerank.max_candidates: 32
       - rerank.budget_ms: 1200
       - rerank.model: "cross-encoder-mini"
     - Env override: MEMORA_RERANK_ENABLED=true forces enable
     - Backends:
       - OS-ML when OPENSEARCH_ML_RERANK_MODEL_ID is set
       - Otherwise remote endpoint via RERANK_ENDPOINT
       - Otherwise local fallback

2) Configuration
   - No default change on main; rerank.enabled remains false.

3) Tests
   - Unit tests passing on branch (15 files, 77 tests).

Operator Impact
- Default behavior unchanged on main.
- To enable for experiments:
  - Env:
    export MEMORA_RERANK_ENABLED=true
  - Or YAML:
    rerank:
      enabled: true
      max_candidates: 32
      budget_ms: 1200
      model: cross-encoder-mini
  - For OpenSearch ML:
    export OPENSEARCH_ML_RERANK_MODEL_ID=<model-id>
  - For remote rerank:
    export RERANK_ENDPOINT=http://localhost:8081/rerank
    export RERANK_API_KEY=<optional>

Validation
- Unit: npm run test:unit → 15 files, 77 tests — passing.
- Optional manual smoke: scripts/dev/run_smokes_and_tail.sh

Notes
- Minimal POC invariants preserved: only memory.write and memory.retrieve registered on main; rerank disabled by default.
- README diagnostics gating remains accurate; no change to Minimal API surface.

Commit Message Suggestion
feat(rerank): wire rerank stage in memory.retrieve gated by config/env; defaults off; unit tests pass
