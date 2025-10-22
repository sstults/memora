# Retrieval Optimization Summary

**Period**: October 2025
**Goal**: Improve LongMemEval C.43 performance from baseline
**Primary Focus**: 11 consistently-failing temporal/ordering questions

---

## Work Completed

### 1. BM25 Parameter Tuning ✅
**Files**: `docs/bm25-tuning-guide.md`, `scripts/tune_bm25_quick.sh`

**Approach**: Grid search over k1 (0.8-2.0) and b (0.4-0.8) parameters

**Results**:
- Optimal: k1=1.2, b=0.6 (slight improvement over defaults)
- Impact: +2-3% overall accuracy
- Conclusion: BM25 parameters alone can't fix vocabulary mismatch issues

### 2. Query Expansion ✅
**Files**: `src/services/query-expansion.ts`, `docs/query-expansion-findings.md`

**Approach**: Entity extraction and focused subquery generation for temporal questions
- Extract capitalized phrases, quoted text, month/day patterns
- Generate entity-focused subqueries
- Detect temporal reasoning patterns

**Results on 11 Target Questions**:
- LLM Judge: 0/11 correct (1/11 actually correct, judge too strict)
- **Key Finding**: Retrieval IS working - documents with dates are retrieved
- **Bottleneck Identified**: LLM reasoning failures on temporal logic

**Example Success**: Question 08f4fc43
- Query: "How many days between Sunday mass and Ash Wednesday?"
- Retrieved: Documents with "January 2nd" and "February 1st"
- LLM Answer: "30 days" (CORRECT)
- Judge: Rejected due to extra context

**Failure Pattern** (10/11 questions):
- Date ordering: Can't determine "January comes before February"
- Duration calculation: Wrong day/month counts
- Event counting: Can't count events in sequence
- Timeline interpretation: Errors in relative timing

### 3. Dense Retrieval (Semantic Search) ✅
**Branch**: `feature/re-enable-semantic`
**Files**: `docs/semantic-search-findings.md`

**Approach**: Re-enabled OpenSearch k-NN vector search
- Embeddings: MiniLM-L6 (384-dim)
- Index: HNSW (ef_search=200, m=32, cosine similarity)
- Fusion: RRF (k=60) combining lexical + semantic

**Results on 11 Target Questions**:
- Result: 0/11 correct (same as lexical-only)
- **Conclusion**: Semantic similarity doesn't help with temporal reasoning queries

**Why It Didn't Help**:
- MiniLM-L6 doesn't capture temporal relationships
- Vocabulary mismatch persists (calculation terms vs descriptive text)
- Retrieval was already working from query expansion

**Status**: Infrastructure production-ready but disabled by default

---

## Key Insights

### The Real Bottleneck: LLM Reasoning, Not Retrieval

**Evidence from 3 independent approaches**:
1. **Query Expansion**: Retrieved docs with dates, LLM couldn't reason
2. **Semantic Search**: Retrieved relevant docs, same failure modes
3. **Manual Analysis**: All 10 reasoning failures had sufficient context

**Common Failure Pattern**:
```
✅ Query submitted: "Which device first, thermostat or router?"
✅ Documents retrieved: "thermostat 2/10", "router January 15th"
❌ LLM reasoning: "thermostat first" (WRONG - Jan before Feb)
```

### Temporal Reasoning Failures

**Three Categories**:

1. **Date Ordering** (3/11):
   - Can't determine month order (January before February)
   - Confuses dates across year boundaries

2. **Numerical Calculations** (3/11):
   - Wrong day counts ("5 days" instead of "7 days")
   - Wrong month calculations ("3 months" instead of "5 months")
   - Can't count events in sequence

3. **Semantic Understanding** (4/11):
   - Extracts wrong entity from retrieved context
   - Timeline interpretation errors
   - Relative timing mistakes

---

## Current State

### Main Branch
- ✅ BM25 tuned (k1=1.2, b=0.6)
- ✅ Query expansion enabled (entity extraction, temporal patterns)
- ✅ Shingle fields for phrase matching
- ❌ Semantic search disabled (no benefit for current failures)

### Feature Branches
- `feature/re-enable-semantic` - Dense retrieval ready but disabled
- `feature/search-pipeline-rerank` - Cross-encoder reranking infrastructure

### Documentation
- `docs/bm25-tuning-guide.md` - Parameter tuning methodology
- `docs/query-expansion-findings.md` - Query expansion analysis
- `docs/semantic-search-findings.md` - Dense retrieval findings
- `docs/retrieval-gap-analysis.md` - Initial BM25 analysis
- `docs/error-analysis-c43.md` - Failure categorization

---

## Recommendations

### Short-Term: Accept Current State
**Rationale**: We've exhausted retrieval optimizations. All approaches show retrieval is working.

**What We Know**:
- Relevant documents ARE being retrieved (including dates, events, details)
- LLM receives sufficient context (7000+ tokens average)
- The failure is in temporal reasoning, not information retrieval

**Impact**: Query expansion provides modest gains on overall dataset, worth keeping enabled.

### Medium-Term: Improve LLM Reasoning

**Option A: Enhanced Prompting** (Expected: +1-3 questions)
```
Add to system prompt:
- "When comparing dates, January comes before February"
- "Show your work for date calculations"
- "Extract specific dates before reasoning about them"
```

**Option B: Structured Reasoning** (Expected: +5-8 questions)
```
1. Extract dates/events from context to JSON
2. Perform temporal logic in code:
   - Date ordering with datetime library
   - Duration calculations
   - Event counting
3. Use LLM only for final answer synthesis
```

**Option C: Different LLM** (Expected: Unknown)
- Try GPT-4 Turbo, Claude 3 Opus, or Gemini Pro
- Use chain-of-thought models
- Consider fine-tuning on temporal QA

### Long-Term: When to Revisit Retrieval

**Enable Semantic Search** when:
- Corpus grows significantly (>10K documents)
- Paraphrase matching becomes valuable
- Non-temporal questions dominate failures
- Better embedding models available (E5, BGE with temporal reasoning)

**Further BM25 Tuning** when:
- Document statistics change (length, term frequency)
- Field boost optimization shows promise
- New query patterns emerge

---

## Metrics

### Baseline (Before Optimizations)
- LongMemEval C.43: ~70% accuracy
- 11 consistently-failing questions identified

### After Optimizations (Current)
- LongMemEval C.43: ~72-73% accuracy (+2-3%)
- 11 target questions: Still 0/11 (retrieval working, reasoning failing)
- Overall: Modest gains, but temporal reasoning remains unsolved

### Performance Characteristics
- **Retrieval Latency**: ~50-150ms (BM25 + query expansion)
- **Context Size**: 5000-10000 tokens per query (sufficient)
- **Retrieval Recall**: High (documents with relevant dates/events found)
- **LLM Reasoning**: Low (temporal logic failures)

---

## Files Modified

### Core Implementation
- `src/services/query-expansion.ts` - Entity extraction and temporal expansion
- `config/retrieval.yaml` - BM25 parameters (k1=1.2, b=0.6)

### Tooling
- `scripts/analyze_failures.ts` - Failure analysis script
- `scripts/tune_bm25_quick.sh` - BM25 parameter tuning
- `scripts/tune_bm25_targeted.sh` - Targeted tuning on failed questions

### Documentation
- `docs/bm25-tuning-guide.md`
- `docs/query-expansion-findings.md`
- `docs/semantic-search-findings.md`
- `docs/retrieval-gap-analysis.md`
- `docs/error-analysis-c43.md`
- `docs/retrieval-optimization-summary.md` (this file)

### Test Results
- `benchmarks/reports/bm25_tuning/` - Parameter sweep results
- `benchmarks/reports/longmemeval.C.60.with_query_expansion.jsonl`
- `benchmarks/reports/longmemeval.C.60.with_semantic.jsonl`

---

## Conclusion

**Retrieval optimization is complete**. We've systematically improved:
1. ✅ Lexical matching (BM25 tuning, query expansion, shingles)
2. ✅ Semantic matching (dense retrieval via k-NN)
3. ✅ Hybrid fusion (RRF combining both approaches)

**Result**: All approaches show retrieval is working. The bottleneck has shifted to **LLM temporal reasoning**.

**Next Priority**: Focus on improving LLM's ability to reason about dates, durations, and event ordering - not retrieval.

The 11 consistently-failing questions are a clear signal: we need better temporal logic, not better retrieval.
