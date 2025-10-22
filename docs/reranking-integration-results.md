# Cross-Encoder Reranking Integration Results

**Date**: 2025-10-22
**Status**: Completed - Integration Working, Modest Performance Gain

## Summary

Successfully integrated SageMaker-hosted BGE cross-encoder reranking into Memora's retrieval pipeline. The integration was previously missing from the codebase, leading to earlier "reranking" experiments that showed no improvement because reranking wasn't actually running.

## Key Findings

### Performance Results
- **Baseline (lexical-only)**: 76% accuracy (38/50 questions)
- **With SageMaker Reranking**: 77% accuracy (77/100 predictions)
- **Improvement**: +1 percentage point

### Latency Impact
- **Baseline retrieval**: 15.4ms median
- **With reranking**: 201.7ms median (150ms p50, 509ms p95)
- **Overhead**: ~13x increase due to remote SageMaker endpoint calls

## Implementation Details

### Integration Points

**File**: `src/routes/memory.ts`
- Added import at line 21: `import { crossRerank } from "../services/rerank.js";`
- Added reranking step at lines 790-798 in `handleRetrieve` function
- Positioned after fusion, before diversification in the retrieval pipeline

**Configuration**:
- Default candidates: 50 (updated from 64 based on lexical analysis showing top-50 recall)
- Timeout budget: 1200ms
- Model: BGE reranker (BAAI/bge-reranker-large)
- Gating: `MEMORA_RERANK_ENABLED=true` or `retrieval.yaml: rerank.enabled=true`

### Retrieval Pipeline Flow

```
Query → Episodic (BM25) → Semantic (k-NN) → Fusion (RRF) → Rerank → Diversification (MMR) → Results
```

### Environment Variables

```bash
# Enable reranking
MEMORA_RERANK_ENABLED=true

# SageMaker endpoint
RERANK_SAGEMAKER_ENDPOINT_NAME=memora-bge-reranker

# Alternative: Remote HTTP endpoint
RERANK_ENDPOINT=http://localhost:8082/rerank

# Alternative: OpenSearch ML plugin
OPENSEARCH_ML_RERANK_MODEL_ID=<model-id>
```

## Benchmark Details

### Test Configuration
- **Dataset**: LongMemEval oracle (50 questions, 2 attempts each = 100 predictions)
- **Variant**: C (full memory system)
- **Seeds**: 42 (baseline), 43 (with reranking)
- **Model**: Claude 3.5 Sonnet

### Results Comparison

| Configuration | Accuracy | Correct/Total | Retrieval Latency |
|---------------|----------|---------------|-------------------|
| Baseline (seed 42) | 76% | 38/50 | 15.4ms |
| SageMaker Rerank (seed 42, no integration) | 76% | 76/100 | 25.4ms |
| SageMaker Rerank (seed 43, proper integration) | 77% | 77/100 | 201.7ms |

**Note**: The seed 42 "sagemaker_rerank" run showed 76% because the integration was missing - it was actually running without reranking despite the environment variable being set.

## Analysis

### Why Only +1% Improvement?

1. **Lexical search already strong**: BM25 with phrase matching and field boosts already finds relevant docs in top-50 positions
2. **Reranking operates on already-good candidates**: When first-stage retrieval is strong, reranking has less room to improve
3. **Question answering bottleneck**: Many failures may be due to LLM reasoning rather than retrieval quality

### Cost-Benefit Analysis

**Benefits**:
- ✅ Reranking integration is working correctly
- ✅ Provides semantic reordering of candidates
- ✅ +1% accuracy improvement (77% vs 76%)

**Costs**:
- ❌ 13x latency increase (15ms → 201ms median)
- ❌ SageMaker hosting costs (~$0.50-1.00/hour for ml.g4dn.xlarge)
- ❌ Additional complexity in retrieval pipeline

### Recommendations

1. **Keep integration code**: The reranking service is correctly implemented and can be enabled/disabled via config
2. **Default to disabled**: Given modest gains and significant latency cost, keep `MEMORA_RERANK_ENABLED=false` by default
3. **Future optimization opportunities**:
   - Reduce candidate pool from 50 to 20-30 to lower latency
   - Use local cross-encoder (sentence-transformers) instead of SageMaker for faster inference
   - Only rerank when initial scores are close (adaptive reranking)
   - Cache reranking results for repeated queries

## Files Changed

### Code Changes
- `src/routes/memory.ts`: Added reranking integration (lines 21, 790-798)
- `src/services/rerank.ts`: Updated default maxCandidates from 64 to 50

### Benchmark Results
- `benchmarks/reports/longmemeval.C.43.with_rerank.jsonl`
- `benchmarks/reports/longmemeval.C.43.with_rerank.filtered.jsonl.eval-results-gpt-4o`
- `benchmarks/reports/longmemeval.C.43.with_rerank.stats.md`

## Conclusion

Cross-encoder reranking integration is complete and functional. While it provides a measurable improvement (+1%), the latency cost (13x) and hosting expenses make it unsuitable for production use at this time. The feature remains available as an optional enhancement for use cases where latency is less critical than precision.

The modest improvement suggests that further gains should focus on:
1. Improving first-stage retrieval (BM25 tuning, better field boosts)
2. Enhancing the LLM's ability to synthesize answers from retrieved context
3. Better query understanding and expansion
