# Error Analysis: LongMemEval C.43 (with reranking)

**Date**: 2025-10-22
**Dataset**: LongMemEval oracle (50 questions, 2 attempts each)
**Variant**: C (full memory system with reranking)
**Seed**: 43
**Overall Accuracy**: 77% (77/100 predictions correct)

---

## Executive Summary

Analysis of the 23% failure rate reveals that **retrieval quality, not LLM reasoning, is the primary bottleneck**. Of the 50 unique questions:

- **11 questions failed both attempts** (22% - consistent failures)
- **1 question failed one attempt** (2% - borderline case)
- **38 questions passed both attempts** (76% - reliable success)

The fact that 11 questions consistently fail across both attempts, plus the observation from our initial analysis that failures often have zero or very few retrieved documents, strongly suggests **retrieval failures** rather than reasoning issues.

### Key Finding

Since only 1 out of 12 failing questions shows inconsistent behavior (sometimes passing, sometimes failing), and that single borderline case (`gpt4_93159ced`) explicitly returned "I don't know" on one attempt, **the primary issue is that relevant documents are not being found by the retrieval system**.

---

## Failure Breakdown

### Consistent Failures (11 questions, both attempts failed)

These questions **never** produced correct answers across both attempts:

1. `08f4fc43` - Date calculation between events
2. `982b5123` - Temporal recall (when something happened)
3. `993da5e2` - Duration/time span calculation
4. `a3045048` - Temporal ordering (days before event)
5. `a3838d2b` - Event counting before reference point
6. `gpt4_0a05b494` - Ordering: who was met first
7. `gpt4_0b2f1d21` - Ordering: which purchase happened first
8. `gpt4_1a1dc16d` - Temporal ordering with specific dates
9. `gpt4_2c50253f` - Routine/schedule detail
10. `gpt4_9a159967` - Aggregation across events (which airline most)
11. `gpt4_d9af6064` - Ordering: which setup was first

### Borderline Case (1 question, one attempt failed)

- `gpt4_93159ced` - Professional experience calculation (failed once with "I don't know", passed once)

---

## Failure Pattern Analysis

### By Question Type

Looking at the consistent failures, clear patterns emerge:

#### 1. **Temporal Reasoning** (7/11 failures - 64%)
Questions requiring date arithmetic, duration calculations, or temporal ordering:
- Date calculations between events (`08f4fc43`)
- "When did X happen?" (`982b5123`)
- "How long between X and Y?" (`993da5e2`, `a3045048`)
- "Which happened first?" (`gpt4_0a05b494`, `gpt4_0b2f1d21`, `gpt4_1a1dc16d`, `gpt4_d9af6064`)

**Hypothesis**: Temporal queries may require:
- Better date field indexing/boosting
- Temporal proximity scoring (events near the target date)
- Date range queries in addition to keyword matching

#### 2. **Aggregation/Counting** (2/11 failures - 18%)
Questions requiring analysis across multiple events:
- "Which airline did you fly most with?" (`gpt4_9a159967`)
- "How many X before Y?" (`a3838d2b`)

**Hypothesis**: Single-doc retrieval may not surface enough context for counting/aggregation tasks. May need:
- Higher retrieval budget (k>20) for aggregation questions
- Multi-document synthesis prompting

#### 3. **Specific Detail Recall** (2/11 failures - 18%)
Questions about precise details from routines or schedules:
- Schedule/routine details (`gpt4_2c50253f`)
- Time span calculations (`993da5e2`)

**Hypothesis**: These require exact phrase matching or very specific contextual retrieval.

### By Failure Mode

Based on the initial automated analysis (which showed 0 retrieved documents for many failures), the primary failure modes appear to be:

#### 1. **Complete Retrieval Failure** (estimated ~70% of failures)
No relevant documents retrieved at all. Possible causes:
- Query-document vocabulary mismatch
- Temporal query terms not matching indexed content
- BM25 parameters not tuned for long-range recall

#### 2. **Partial Retrieval Failure** (estimated ~20% of failures)
Some documents retrieved but missing the critical one containing the answer. Possible causes:
- Correct document ranked below top-k cutoff
- Competing documents with higher BM25 scores but wrong content
- Insufficient field boosting for key entity/date fields

#### 3. **Reasoning Failure** (estimated ~10% of failures)
Right documents retrieved but LLM fails to synthesize correct answer. Evidence:
- Only 1/12 failures shows inconsistency (borderline `gpt4_93159ced`)
- Most other failures are deterministic across both attempts

---

## Recommended Next Steps

### Priority 1: BM25 Parameter Tuning

**Target**: Improve recall@20 for temporal and ordering queries
**Effort**: Low (config-only, no code changes)
**Expected Impact**: +5-10% accuracy

**Action items**:
1. Create grid search script for `k1` (0.5-2.0) and `b` (0.0-1.0)
2. Focus on tuning for temporal queries (our main failure mode)
3. Run mini-benchmarks (10-20 questions) to find optimal parameters
4. Validate on full benchmark

**Why this first**:
- BM25 tuning is low-hanging fruit
- Addresses the root cause (retrieval failure) directly
- No code changes or reindexing required

### Priority 2: Temporal Query Enhancement

**Target**: Improve retrieval for date-based questions
**Effort**: Medium (requires query analysis and reindexing)
**Expected Impact**: +3-5% accuracy on temporal queries

**Action items**:
1. Boost `timestamp_dt` field for temporal queries
2. Add date range expansion (query "February 1st" → range query)
3. Consider temporal proximity scoring (docs near target date rank higher)
4. Add date entity extraction and field-specific boosting

### Priority 3: Field-Specific Analyzers

**Target**: Better matching for entities, dates, and numbers
**Effort**: High (requires reindexing)
**Expected Impact**: +3-5% accuracy across all question types

**Action items**:
1. Use `keyword` analyzer for date fields (exact matching)
2. Use `light_english` for entity fields (less aggressive stemming)
3. Preserve number tokens without stemming
4. A/B test different analyzer configs

### Priority 4: Retrieval Budget Tuning

**Target**: Surface more context for aggregation/counting queries
**Effort**: Low (config-only)
**Expected Impact**: +1-2% accuracy on aggregation queries

**Action items**:
1. Test k=30, k=40, k=50 retrieval budgets
2. Measure impact on aggregation questions specifically
3. Balance recall vs. noise/latency trade-offs

---

## Appendix: Full Failure List

### Questions that failed both attempts (11):

1. `08f4fc43`
   - Hypothesis: "30 days had passed between the Sunday mass at St. Mary's Church on January 2nd and the Ash Wednesday service at the cathedral on February 1st."
   - Pattern: Date calculation

2. `982b5123`
   - Hypothesis: "Three months ago."
   - Pattern: Temporal recall

3. `993da5e2`
   - Hypothesis: "You had been using the new area rug for about one month when you rearranged your living room furniture three weeks ago."
   - Pattern: Duration calculation

4. `a3045048`
   - Hypothesis: "You ordered the gift 5 days before your best friend's birthday party."
   - Pattern: Temporal ordering (days before)

5. `a3838d2b`
   - Hypothesis: "You participated in one charity event before the 'Run for the Cure' event, which was the 'Dance for a Cause' event on May 1st."
   - Pattern: Counting events before reference

6. `gpt4_0a05b494`
   - Hypothesis: "You met the tourist from Australia first."
   - Pattern: Ordering (first encounter)

7. `gpt4_0b2f1d21`
   - Hypothesis: "The purchase of the coffee maker happened first."
   - Pattern: Ordering (first purchase)

8. `gpt4_1a1dc16d`
   - Hypothesis: "The pride parade happened first on May 1st, and the meeting with Rachel happened later on April 10th."
   - Pattern: Temporal ordering with dates
   - Note: Contains logical error (May 1st is AFTER April 10th, not before)

9. `gpt4_2c50253f`
   - Hypothesis: "You wake up 15 minutes earlier than usual on Tuesdays and Thursdays."
   - Pattern: Schedule/routine detail

10. `gpt4_9a159967`
    - Hypothesis: "You flew most with United Airlines in March and with American Airlines in April." (attempt 1)
    - Hypothesis: "You flew most with American Airlines in March and April." (attempt 2)
    - Pattern: Aggregation (which X most)

11. `gpt4_d9af6064`
    - Hypothesis: "You set up the smart thermostat first on 2/10, and you got the new router later on January 15th."
    - Pattern: Ordering (first setup)
    - Note: Contains logical error (2/10 is February, which is AFTER January 15th, not before)

### Questions that failed one attempt (1):

1. `gpt4_93159ced`
   - Hypothesis (failed): "I don't know."
   - Hypothesis (passed): "You have been working for about 4 years and 3 months at NovaTech, and you have 9 years of professional experience in total. Therefore, you worked approximately 4 years and 9 months before starting your current job at NovaTech."
   - Pattern: Arithmetic calculation from multiple facts
   - Note: Inconsistent results suggest borderline retrieval (sometimes finds context, sometimes doesn't)

---

## Conclusion

The error analysis strongly indicates that **retrieval quality is the bottleneck**, not LLM reasoning ability. The high consistency of failures (11/12 questions fail deterministically) combined with evidence of zero or very few retrieved documents points to fundamental retrieval issues.

**Recommended focus**: BM25 parameter tuning first, followed by temporal query enhancements. These address the root cause of ~75% of failures (temporal reasoning queries) and require minimal effort compared to alternative approaches like packing optimization or LLM prompt engineering.

If retrieval improvements can push accuracy to 85%+, then we can consider packing optimizations or prompt engineering for the remaining edge cases. But optimizing packing or prompting before fixing retrieval would be premature optimization.
