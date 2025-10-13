# Retrieval Tuning Plan (BM25 + kNN + Fusion) for Memora

This document captures the tuning changes implemented before testing a cross-encoder reranker. It explains what changed, how to migrate safely, and how to validate improvements.

Overview of changes
- Lexical (BM25):
  - Added shingle (bigrams) analyzer and keyword subfields.
  - Introduced multi_match guardrails (tie_breaker, minimum_should_match).
  - Added optional time-decay on episodic timestamps to prefer fresher events among ties.
- Vector (kNN/HNSW):
  - Confirmed cosine space and 384-dim embeddings.
  - Increased ef_search to 200 (higher recall).
  - Increased semantic top_k to 150.
- Fusion (hybrid):
  - Continue in-process RRF and MMR.
  - Added optional soft recency preference in semantic scores.
  - Provided an OpenSearch RRF search pipeline for A/B testing.

What changed in the repo
- config/retrieval.yaml
  - episodic.top_k: 100; semantic.top_k: 150.
  - lexical section: multi_match_type=best_fields, tie_breaker=0.3, min_should_match_pct=60, use_shingles=true.
  - time_decay section: enabled=true, episodic(ts): half_life=45d, weight=0.25; semantic(last_used): half_life=45d, weight=0.15.
- Index templates
  - config/index-templates/mem-episodic.json
    - Added english_shingle analyzer, bm25_episodic similarity (k1=1.2, b=0.4).
    - content has subfields content.shingles and content.raw.
  - config/index-templates/mem-semantic.json
    - ef_search=200; english_shingle analyzer; bm25_sem similarity (k1=1.2, b=0.6).
    - title/text have .shingles and .raw subfields.
- Query pipeline (src/routes/memory.ts)
  - Episodic: multi_match(type=best_fields) over content^3, content.shingles^1.2, tags^2, artifacts^1, content.raw^0.5 with tie_breaker and min_should_match guardrails. Optional gauss ts decay.
  - Semantic: script_score(knn_score) preserved; increased size; optional soft recency post-adjust using last_used.
- Optional OS RRF search pipeline:
  - config/opensearch/pipelines/memora_rrf.json (RRF rank_constant=60; rank_window_size=200).
  - scripts/dev/register_rrf_pipeline.sh to create/overwrite a search pipeline independent of service env.

Migration and rollout
1) Increase kNN search window online
   - No reindex required.
   - Run:
     - scripts/dev/update_semantic_ef_search.sh
     - or: curl -X PUT "$OS/$INDEX/_settings" -d '{"knn.algo_param.ef_search":200}'
2) Apply new episodic template
   - New daily indices will use it automatically.
   - Reindex historical episodic indices only if you need shingles on older data (optional).
3) Rebuild semantic index with new mapping
   - Mapping changes require reindex. Use:
     - scripts/dev/reindex_semantic_v2.sh
   - This script:
     - Creates TEMP index with updated body
     - Reindexes mem-semantic -> TEMP
     - Deletes mem-semantic
     - Recreates mem-semantic from updated body
     - Reindexes TEMP -> mem-semantic
     - Optionally deletes TEMP
   - Ensure Memora is quiesced during the swap (or accept a small write gap).
4) Enable/disable features via config
   - config/retrieval.yaml toggles lexical.use_shingles and time_decay.enabled.
   - You can tune tie_breaker, min_should_match_pct, half-life, and weights without code changes.
5) Optional: server-side RRF pipeline (A/B)
   - Register:
     - OPENSEARCH_URL=http://localhost:9200 ./scripts/dev/register_rrf_pipeline.sh memora_rrf
   - Use this pipeline by issuing OpenSearch searches with ?search_pipeline=memora_rrf or attaching index.search.default_pipeline, OR set MEMORA_OS_SEARCH_PIPELINE_BODY_JSON and let src/services/os-ml.ts create/attach a pipeline (requires pipeline body provided via env). The current Memora default continues to rely on in-process RRF/MMR.

A/B and validation checklist

OS-ML rerank smoke (dev)
- Purpose: sanity-check an ML Commons cross-encoder reranker model_id for latency and stability before enabling in-service rerank.
- Prereqs:
  - OpenSearch running with ML Commons and your reranker deployed
  - Export OPENSEARCH_ML_RERANK_MODEL_ID
- Run:
  - npm run dev:rerank:smoke -- --iters 30 --k 64 --timeout 1500
  - Optional flags:
    - --iters N          number of requests (default 30)
    - --k K              candidates per request, capped at 128 (default 64)
    - --timeout MS       per-request timeoutMs (default OPENSEARCH_ML_RERANK_TIMEOUT_MS or 1500)
    - --query "text"     query string (default: find relevant project notes about opensearch ml reranking)
- Output:
  - Prints JSON summary to stdout with iters/ok/fail and latency stats (min/mean/p50/p95/max)
  - Logs each iteration to stderr with tookMs; non-zero exit if any failures
- Acceptance (from ActiveContext):
  - p95 ≤ 1200 ms
  - 0 failures
- Notes:
  - In-service rerank stage now logs timing and rank deltas when DEBUG includes memora:rerank. Look for:
    - osml.ok, osml.delta, osml.end (OpenSearch ML path)
    - remote.ok, remote.delta, remote.end (HTTP path)
    - local and local.delta (local fallback)
- Pre/post benchmark runs (with fixed seeds)
  - LongMemEval:
    - ./benchmarks/runners/run_longmemeval.sh
    - Use variants to tag before/after configs; compare metrics via:
      - node benchmarks/runners/score_longmemeval.ts
      - outputs under benchmarks/reports/
  - MAB/Locomo (if applicable):
    - ./benchmarks/runners/run_locomo.sh
    - ./benchmarks/runners/run_memoryagentbench.sh
- Parameter sweeps to try:
  - episodic.top_k: 50 ↔ 100
  - semantic.top_k: 100 ↔ 150
  - lexical.tie_breaker: 0.2 ↔ 0.4
  - lexical.min_should_match_pct: 50 ↔ 70 (applies on queries with >=4 terms)
  - time_decay: half_life 30 ↔ 60; weight 0.1 ↔ 0.25
  - diversity.lambda: 0.8 ↔ 0.9
  - ef_search: 128 ↔ 200
- Explain API spot checks (BM25 portion)
  - Identify “should-have-hit” queries with weak episodic matches.
  - Get the doc ID from search results; then:
    - curl -X GET "$OS/mem-episodic-*/_explain/<doc_id>" -H 'Content-Type: application/json' -d '{
        "query": {
          "multi_match": {
            "query": "YOUR QUERY",
            "type": "best_fields",
            "fields": ["content^3","content.shingles^1.2","tags^2","artifacts^1","content.raw^0.5"],
            "tie_breaker": 0.3,
            "minimum_should_match": "60%"
          }
        }
      }'
  - Inspect clause contributions; adjust boosts, tie_breaker, and min_should_match accordingly.

Operational notes
- Embeddings
  - MEMORA_EMBED_DIM=384; vectors are unit-normalized; mapping dimension is 384; space_type is cosinesimil.
- Filters
  - Ensure relevant filters (tenant/project/context, etc.) are applied before retrieval in both episodic and semantic paths to reduce candidate space and improve precision/latency.
- Chunking
  - Keep chunks 300–600 tokens with 10–15% overlap to balance BM25 specificity and embedding signal.
- Roles and tags
  - Episodic indexing already stores role, tags; queries now boost tags and support exact matching via content.raw when needed.

Quick commands
- Update kNN ef_search online:
  - ./scripts/dev/update_semantic_ef_search.sh
- Reindex semantic with new mapping:
  - ./scripts/dev/reindex_semantic_v2.sh
- Register RRF search pipeline:
  - OPENSEARCH_URL=http://localhost:9200 ./scripts/dev/register_rrf_pipeline.sh memora_rrf

Finalize rollout (one-time)
1) Increase HNSW search window (no reindex required)
   - ./scripts/dev/update_semantic_ef_search.sh
   - Or: curl -X PUT "$OS/$INDEX/_settings" -H 'Content-Type: application/json' -d '{"knn.algo_param.ef_search":200}'
2) Rebuild semantic index with updated mapping/settings (required for title/text shingles + BM25 similarity)
   - Ensure Memora is quiesced (or accept a small write gap)
   - ./scripts/dev/reindex_semantic_v2.sh
3) Episodic template
   - New daily indices automatically use shingles and bm25_episodic; reindex historical episodic indices only if you need shingles on old data
4) Optional: register server-side RRF pipeline for A/B
   - OPENSEARCH_URL=http://localhost:9200 ./scripts/dev/register_rrf_pipeline.sh memora_rrf
   - Use via ?search_pipeline=memora_rrf or attach as index.search.default_pipeline (optional)
5) Restart service to reload retrieval.yaml (config is cached at runtime)
   - Stop/start the service after modifying config/retrieval.yaml so new knobs are applied

Testing plan (A/B knob tuning)
Goal: compare retrieval quality, diversity, and latency across parameter sweeps using existing benchmark runners and targeted Explain checks.

A) Establish baseline
- Ensure reranker remains disabled for this phase (MEMORA_RERANK_ENABLED=false or retrieval.yaml rerank.enabled=false)
- Confirm ef_search current value (scripts/dev/update_semantic_ef_search.sh without args prints intent) and semantic/episodic top_k in config
- Run baseline benchmarks (fixed seeds)
  - ./benchmarks/runners/run_longmemeval.sh
  - node benchmarks/runners/score_longmemeval.ts
  - Optionally: ./benchmarks/runners/run_locomo.sh and ./benchmarks/runners/run_memoryagentbench.sh
- Save baseline reports under benchmarks/reports with a distinct tag in filenames

B) 1-D parameter sweeps (change one family at a time)
- Vector recall:
  - ef_search: 128 → 200 (scripts/dev/update_semantic_ef_search.sh); record retrieval latency and recall metrics
  - semantic.top_k: 100 ↔ 150 (config/retrieval.yaml); restart service; re-run benchmark
- Lexical control:
  - episodic.top_k: 50 ↔ 100
  - lexical.min_should_match_pct: 50 ↔ 70 (applies to queries with ≥4 terms)
  - lexical.tie_breaker: 0.2 ↔ 0.4
- Time-aware tie-break:
  - time_decay.episodic: half_life_days 30/45/60; weight 0.1/0.2/0.25
  - time_decay.semantic: half_life_days 30/45/60; weight 0.1/0.15/0.2
- Fusion diversity:
  - diversity.lambda: 0.8 ↔ 0.9

For each change:
- Edit config/retrieval.yaml (and/or ef_search), restart service, re-run benchmark, and compare against baseline with score_* runners
- Track:
  - Top-1/Top-K retrieval accuracy metrics
  - Near-duplicate rate (MMR/diversity impact)
  - Stage timing logs (enable DEBUG=memora:* to see episodic/semantic stage durations)

C) Targeted Explain API loop (lexical quality)
- For a set of “should-have-hit” queries:
  - Identify a candidate doc id and run _explain to see scoring contributions
  - Adjust field boosts, tie_breaker, and min_should_match based on explain output
- Example:
  - curl -X GET "$OS/mem-episodic-*/_explain/<doc_id>" -H 'Content-Type: application/json' -d '{
      "query": {
        "multi_match": {
          "query": "YOUR QUERY",
          "type": "best_fields",
          "fields": ["content^3","content.shingles^1.2","tags^2","artifacts^1","content.raw^0.5"],
          "tie_breaker": 0.3,
          "minimum_should_match": "60%"
        }
      }
    }'

D) Optional server-side fusion A/B (OpenSearch RRF pipeline)
- Register: OPENSEARCH_URL=http://localhost:9200 ./scripts/dev/register_rrf_pipeline.sh memora_rrf
- Compare:
  - In-process fusion (current default) vs search_pipeline=memora_rrf
  - Measure latency and retrieval metrics; select the simpler path that meets goals

Backout
- config toggles allow quickly disabling shingles usage and time-aware boosts.
- ef_search can be lowered online with the same script.
- Rebuild semantic index back to old mapping if necessary (reverse the reindex procedure).

After these tightenings plateau, consider an in-cluster cross-encoder reranker via ML Commons in a search pipeline (top-K ~30–100) as a subsequent step.

Automation — running parameter sweeps

Quick start (small sweep)
- npm run dev:tune:small
  - Uses scripts/dev/scenarios/retrieval_sweep.small.json
  - Writes reports under benchmarks/reports/memora_predictions.<scenario>.jsonl
  - Scores via benchmarks/runners/score_longmemeval.ts and tags results per scenario

Scenarios format
- Each scenario supports:
  - name: label for output tagging
  - overrides: JSON object merged into retrieval.yaml at runtime (MEMORA_RETRIEVAL_OVERRIDES_JSON)
  - env: additional environment, e.g.:
    - MEMORA_RERANK_ENABLED=true|false (takes precedence over retrieval.yaml)
    - KNN_EF_SEARCH=128|200 (applies ef_search online via scripts/dev/update_semantic_ef_search.sh)

Examples
- Base (fusion only): {"name":"base","overrides":{},"env":{"MEMORA_RERANK_ENABLED":"false"}}
- semantic.top_k=150: {"name":"sem150","overrides":{"stages":{"semantic":{"top_k":150}}},"env":{"MEMORA_RERANK_ENABLED":"false"}}
- ef_search=200 online: {"name":"ef200","overrides":{},"env":{"MEMORA_RERANK_ENABLED":"false","KNN_EF_SEARCH":"200"}}
- Rerank 32 candidates: {"name":"rerank32","overrides":{"rerank":{"enabled":true,"max_candidates":32}},"env":{"MEMORA_RERANK_ENABLED":"true"}}

Manual single-run (no scenarios)
- Set overrides without editing YAML:
  - export MEMORA_RETRIEVAL_OVERRIDES_JSON='{"stages":{"semantic":{"top_k":150}},"fusion":{"rrf_k":60},"diversity":{"lambda":0.9}}'
  - node --import ./scripts/register-ts-node.mjs benchmarks/runners/longmemeval_driver.ts --dataset benchmarks/LongMemEval/data/longmemeval_oracle.json --out benchmarks/reports/memora_predictions.custom.jsonl --variant C --seed 42
  - node --import ./scripts/register-ts-node.mjs benchmarks/runners/score_longmemeval.ts --hyp benchmarks/reports/memora_predictions.custom.jsonl --dataset benchmarks/LongMemEval/data/longmemeval_oracle.json --tag custom
- Optional ef_search adjustment prior to run:
  - bash scripts/dev/update_semantic_ef_search.sh 200
- Notes:
  - You can also run: npm run dev:tune:small to execute a predefined scenario sweep.
  - Or run the fusion+rerank sweep: npm run dev:tune:fusion (scenarios in scripts/dev/scenarios/retrieval_sweep.fusion_rerank.json; requires OPENSEARCH_ML_RERANK_MODEL_ID set)
  - Restart the service if you changed config/retrieval.yaml (config is cached at runtime).
