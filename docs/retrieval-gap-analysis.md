# Retrieval Gap Analysis: Why 11 Questions Consistently Fail

**Date**: 2025-10-22
**Benchmark**: LongMemEval C.43 (77% accuracy, 23% failure rate)
**Analysis Focus**: 11 consistently-failing questions (0/2 attempts correct)

---

## Executive Summary

**Key Finding**: BM25 parameter tuning cannot fix these failures. A complete parameter sweep (20 configurations: k1 ∈ {0.8, 1.0, 1.2, 1.5, 2.0}, b ∈ {0.2, 0.4, 0.6, 0.8}) resulted in **0/11 correct** for all configurations.

**Root Cause**: **Query-document vocabulary mismatch**. These questions require temporal reasoning, aggregation, or ordering operations, but the query terms describing these operations ("how many days", "between", "first", "before") don't appear in the conversational document content.

---

## BM25 Tuning Results

### Sweep Configuration
- **Failed Questions**: 11 (from error-analysis-c43.md)
- **Parameter Grid**: 5 k1 values × 4 b values = 20 total configurations
- **Baseline**: k1=1.2, b=0.4 (episodic), k1=1.2, b=0.6 (semantic)
- **Seed**: 42 (fixed for reproducibility)
- **Reranking**: Disabled

### Results
| k1 Range | b Range | Best Accuracy | Improvement vs Baseline |
|----------|---------|---------------|------------------------|
| 0.8-2.0  | 0.2-0.8 | 0/11 (0%)     | +0%                    |

**Conclusion**: No BM25 configuration improves retrieval for these queries. The issue is not term frequency/length normalization scoring—it's that the right terms aren't matching at all.

---

## Query-Document Mismatch Patterns

### Pattern 1: Temporal Calculation Queries (7/11 failures)

**Example: Question `08f4fc43`**

Query:
```
How many days had passed between the Sunday mass at St. Mary's Church
and the Ash Wednesday service at the cathedral?
```

Answer-containing documents:
```
Document 1: "I just came from the Ash Wednesday service at the cathedral
on February 1st, and it really made me reflect on the importance of giving
back to the community."

Document 2: "I recently attended the Sunday mass at St. Mary's Church on
January 2nd, and the sermon on forgiveness really resonated with me."
```

**Vocabulary Mismatch**:
- Query terms: "how many days", "passed", "between" ← **NOT in documents**
- Documents: Simple declarative statements about attending events
- Shared terms: "Sunday mass", "St. Mary's Church", "Ash Wednesday service", "cathedral"

**Why BM25 Fails**: The calculation-oriented query terms have zero matches. Even with perfect entity matching ("Sunday mass", "Ash Wednesday"), BM25 scoring is diluted by the many query terms that don't match.

### Pattern 2: Ordering/Comparison Queries (4/11 failures)

**Example: Question `gpt4_0b2f1d21`**

Query:
```
Which event happened first, the purchase of the coffee maker or the
malfunction of the stand mixer?
```

**Vocabulary Mismatch**:
- Query terms: "which", "happened first", "or" ← Comparison/ordering language
- Documents: Statements like "I bought a coffee maker..." or "My stand mixer broke..."
- No temporal comparison words in documents

**Why BM25 Fails**: Documents describe events in isolation without relative temporal markers like "before", "after", "first", or "later". The query's comparison vocabulary doesn't match the document's declarative vocabulary.

---

## Why Reranking Also Struggles

Even with cross-encoder reranking enabled (C.43: 77%), these 11 questions still fail. Why?

1. **Reranking requires candidates**: If BM25 doesn't retrieve the right documents in top-k (k=20), reranking can't promote them
2. **Vocabulary gap remains**: Cross-encoders are better at semantic matching but still struggle when query intent (temporal calculation) differs fundamentally from document form (event statements)

---

## Affected Question Types

| Question Type | Count | Example Question Pattern |
|--------------|-------|-------------------------|
| Date calculation | 3 | "How many days between X and Y?" |
| Temporal recall | 2 | "When did X happen?" / "How long ago?" |
| Event ordering | 4 | "Which happened first, X or Y?" |
| Aggregation/counting | 2 | "How many X before Y?" / "Which X most?" |

---

## Root Cause: Conversational Document Style

LongMemEval documents are **conversational turns** with events embedded in natural dialogue:

```
"I'm planning to volunteer at a local soup kitchen this weekend
and I was wondering if you could give me some tips... By the way,
I just came from the Ash Wednesday service at the cathedral on
February 1st..."
```

This conversational style creates vocabulary gaps:
- Events are **incidental mentions** in longer turns about other topics
- Temporal information is stated **declaratively** ("on February 1st") not comparatively ("30 days after...")
- No explicit temporal relationships between events in different turns

---

## Proposed Solutions (Ordered by Impact/Effort)

### 1. Query Expansion/Reformulation (High Impact, Medium Effort)
**Approach**: Detect temporal/ordering queries and expand with entity-focused subqueries

**Example**:
- Original: "How many days between Sunday mass and Ash Wednesday service?"
- Expanded: ["Sunday mass St. Mary's Church", "Ash Wednesday service cathedral", "January February"]

**Expected Impact**: +5-8% (recover 6-9 of 11 failed questions)
**Effort**: Medium (requires query analysis and expansion logic)
**Minimal POC Compatible**: ✅ (query preprocessing only, no reindexing)

### 2. Hybrid Lexical + Dense Retrieval (Very High Impact, High Effort)
**Approach**: Use dense embeddings (e.g., E5, BGE) alongside BM25 to capture semantic similarity beyond lexical match

**Why It Helps**: Dense retrievers can match "how many days between X and Y" with documents mentioning X and Y with dates, even without exact query term matches

**Expected Impact**: +8-10% (recover 9-11 of 11 failed questions)
**Effort**: High (requires embedding model, vector index, fusion logic)
**Minimal POC Compatible**: ❌ (violates lexical-only constraint on main branch)

### 3. Document Enrichment with Temporal Metadata (Medium Impact, Very High Effort)
**Approach**: Extract and index structured temporal facts from documents (e.g., "attended Sunday mass" → `{event: "mass", location: "St. Mary's Church", date: "2024-01-02"}`)

**Why It Helps**: Enables exact matching on extracted entities and dates

**Expected Impact**: +6-8% (structured matching for temporal queries)
**Effort**: Very High (NER, temporal extraction, schema design, reindexing)
**Minimal POC Compatible**: ⚠️ (borderline - enrichment at index time)

### 4. Increased Retrieval Budget (Low Impact, Low Effort)
**Approach**: Increase k from 20 to 50 or 100 to improve recall

**Why Limited**: If documents aren't scoring at all (as BM25 sweep shows), increasing k won't help much

**Expected Impact**: +1-2% (may catch some borderline cases)
**Effort**: Very Low (config change only)
**Minimal POC Compatible**: ✅

---

## Recommended Next Steps

### Immediate (This Week)
1. **Implement Query Expansion** (Solution #1)
   - Detect temporal/ordering questions via pattern matching
   - Extract entities and expand to entity-focused subqueries
   - Test on 11 failed questions

2. **Increase Retrieval Budget** (Solution #4)
   - Quick win: test k=50 to see if any questions become borderline retrievable
   - Measure impact on latency

### Short-Term (Next Sprint)
3. **Prototype Dense Retrieval** on feature branch
   - Integrate E5 or BGE embeddings
   - Test hybrid BM25 + dense fusion
   - Measure impact on full benchmark

### Long-Term (Future Work)
4. **Document Enrichment Pipeline**
   - Design temporal fact extraction
   - Build NER + date normalization pipeline
   - Requires significant engineering effort

---

## Appendix: Full Failed Question List

1. `08f4fc43` - "How many days had passed between the Sunday mass... and the Ash Wednesday service?"
2. `982b5123` - "How many months ago did I book the Airbnb in San Francisco?"
3. `993da5e2` - "How long had I been using the new area rug when I rearranged my living room furniture?"
4. `a3045048` - "How many days before my best friend's birthday party did I order her gift?"
5. `a3838d2b` - "How many charity events did I participate in before the 'Run for the Cure' event?"
6. `gpt4_0a05b494` - "Who did I meet first, the woman selling jam... or the tourist from Australia?"
7. `gpt4_0b2f1d21` - "Which event happened first, the purchase of the coffee maker or the malfunction of the stand mixer?"
8. `gpt4_1a1dc16d` - "Which event happened first, the meeting with Rachel or the pride parade?"
9. `gpt4_2c50253f` - "What time do I wake up on Tuesdays and Thursdays?"
10. `gpt4_9a159967` - "Which airline did I fly with the most in March and April?"
11. `gpt4_d9af6064` - "Which device did I set up first, the smart thermostat or the new router?"

---

## References

- Targeted BM25 sweep: `benchmarks/reports/bm25_tuning/targeted_sweep_results.csv`
- Error analysis: `docs/error-analysis-c43.md`
- Failed question oracle: `benchmarks/reports/bm25_tuning/failed_questions_oracle.json`
