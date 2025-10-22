# Benchmark Framework Improvements

**Date**: October 2025
**Context**: Confusion during enhanced prompting experiment revealed systematic issues with benchmark comparability and result interpretation

---

## Problems Identified

### 1. Inconsistent Dataset Selection

**Current Behavior**:
```bash
# run_longmemeval.sh automatically selects dataset based on existence
if [ -f "benchmarks/LongMemEval/data/longmemeval_oracle_50q.json" ]; then
    DATASET="benchmarks/LongMemEval/data/longmemeval_oracle_50q.json"
else
    DATASET="benchmarks/LongMemEval/data/longmemeval_oracle.json"
fi
```

**Issues**:
- Same seed produces different question sets depending on which file exists
- No way to know which dataset was used without checking logs
- Creates non-comparable results across runs

**Example Confusion**:
- Seed 60 with semantic search: Used `longmemeval_oracle.json` (500 questions)
- Seed 60 with enhanced prompting: Used `longmemeval_oracle_50q.json` (100 questions)
- Results: 21/500 vs 86/100 - completely different question sets!

### 2. Missing Result Metadata

**Current State**:
Output files contain only predictions, no metadata about:
- Which dataset was used
- What configuration was active (semantic enabled, rerank enabled, etc.)
- Timestamp of run
- System configuration (BM25 params, model version)

**Impact**:
- Cannot determine comparability after the fact
- Must cross-reference logs manually
-易于混淆 results from different experiments

### 3. Fragile Result Parsing

**Current Approach**:
```bash
# My failed attempt
cat file.eval-results-gpt-4o | awk '{sum+=$1; if($1==1) yes++; else no++} ...'
```

**Actual Format**:
```json
{"question_id": "...", "hypothesis": "...", "autoeval_label": {"model": "...", "label": true}}
```

**Issues**:
- No standard parsing utility
- Silent failures (awk returned 0 instead of error)
- Requires manual jq/grep commands
- Easy to make mistakes (as I did)

### 4. Unclear Dataset Naming

**Current Files**:
- `longmemeval_oracle.json` - Full dataset (size unknown without reading)
- `longmemeval_oracle_50q.json` - 50 contexts, 100 questions (2 per context)

**Issues**:
- `50q` means "50 contexts" not "50 questions"
- No indication of total question count in filename
- No version or date information

### 5. No Validation or Warnings

**Current Behavior**:
- Can compare results from different datasets with same seed
- No warnings about incompatible comparisons
- No checks that configuration matches intended comparison

---

## Proposed Solutions

### Priority 1: Explicit Dataset Parameter (CRITICAL)

**Change**: Make dataset selection explicit and required

**Implementation**:
```bash
# run_longmemeval.sh
DATASET=""
DATASET_NAME=""

while [[ $# -gt 0 ]]; do
  case $1 in
    --dataset)
      DATASET="$2"
      shift 2
      ;;
    --dataset-name)
      DATASET_NAME="$2"
      shift 2
      ;;
    # ... other params
  esac
done

# Require explicit dataset
if [ -z "$DATASET" ]; then
  echo "Error: --dataset parameter is required"
  echo "Available datasets:"
  ls benchmarks/LongMemEval/data/longmemeval_*.json
  exit 1
fi

# Auto-detect dataset name if not provided
if [ -z "$DATASET_NAME" ]; then
  DATASET_NAME=$(basename "$DATASET" .json)
fi
```

**Usage**:
```bash
# Explicit, clear, unambiguous
./run_longmemeval.sh \
  --variant C \
  --seed 60 \
  --dataset benchmarks/LongMemEval/data/longmemeval_oracle_50q.json \
  --out benchmarks/reports/longmemeval.C.60.baseline.jsonl

# Or with short name
./run_longmemeval.sh \
  --variant C \
  --seed 60 \
  --dataset-name oracle_50q \
  --out benchmarks/reports/longmemeval.C.60.baseline.jsonl
```

**Benefits**:
- Forces explicit dataset choice
- Clear from command what's being tested
- Eliminates implicit behavior
- Easy to review in command history

### Priority 2: Embed Metadata in Output Files (HIGH)

**Change**: Add metadata header to all output JSONL files

**Implementation**:
```typescript
// At start of benchmark run, write metadata line
const metadata = {
  _metadata: {
    timestamp: new Date().toISOString(),
    dataset: datasetPath,
    dataset_name: datasetName,
    variant: variant,
    seed: seed,
    config: {
      bm25: { k1: 1.2, b: 0.6 },
      semantic_enabled: false,
      rerank_enabled: false,
      query_expansion_enabled: true,
      model: "gpt-4.1-mini",
      // ... other relevant config
    },
    git_commit: gitCommitHash,
    memora_version: packageVersion
  }
};

// Write as first line (but skip during eval)
fs.writeFileSync(outputFile, JSON.stringify(metadata) + '\n');
```

**Example Metadata**:
```json
{
  "_metadata": {
    "timestamp": "2025-10-22T09:20:00.000Z",
    "dataset": "benchmarks/LongMemEval/data/longmemeval_oracle_50q.json",
    "dataset_name": "oracle_50q",
    "dataset_size": {"contexts": 50, "questions": 100},
    "variant": "C",
    "seed": 60,
    "config": {
      "bm25": {"k1": 1.2, "b": 0.6},
      "semantic_enabled": false,
      "rerank_enabled": false,
      "query_expansion_enabled": true,
      "model": "gpt-4.1-mini",
      "temperature": 0.0
    },
    "git_commit": "7e7a095",
    "memora_version": "0.1.0"
  }
}
```

**Benefits**:
- Self-documenting results
- Can verify comparability programmatically
- No need to cross-reference logs
- Clear audit trail

### Priority 3: Standardized Result Parsing Utility (HIGH)

**Change**: Create `scripts/parse_benchmark_results.ts` utility

**Implementation**:
```typescript
#!/usr/bin/env npx tsx
// scripts/parse_benchmark_results.ts

import * as fs from 'fs';

interface BenchmarkResult {
  metadata?: any;
  total_questions: number;
  correct: number;
  accuracy: number;
  by_question: Array<{
    question_id: string;
    correct: boolean;
    hypothesis: string;
  }>;
}

function parseBenchmarkResults(evalResultsPath: string): BenchmarkResult {
  const lines = fs.readFileSync(evalResultsPath, 'utf-8').split('\n').filter(l => l.trim());

  let metadata = null;
  const results = [];

  for (const line of lines) {
    const obj = JSON.parse(line);

    // Check for metadata line
    if (obj._metadata) {
      metadata = obj._metadata;
      continue;
    }

    // Parse eval result
    results.push({
      question_id: obj.question_id,
      correct: obj.autoeval_label?.label === true,
      hypothesis: obj.hypothesis
    });
  }

  const correct = results.filter(r => r.correct).length;

  return {
    metadata,
    total_questions: results.length,
    correct,
    accuracy: correct / results.length,
    by_question: results
  };
}

function compareResults(baseline: BenchmarkResult, experiment: BenchmarkResult) {
  // Check comparability
  if (baseline.metadata?.dataset !== experiment.metadata?.dataset) {
    console.warn('⚠️  WARNING: Different datasets!');
    console.warn(`  Baseline: ${baseline.metadata?.dataset_name}`);
    console.warn(`  Experiment: ${experiment.metadata?.dataset_name}`);
  }

  if (baseline.total_questions !== experiment.total_questions) {
    console.error('❌ ERROR: Different number of questions - results not comparable');
    process.exit(1);
  }

  // Compare
  console.log('=== Comparison ===');
  console.log(`Baseline:   ${baseline.correct}/${baseline.total_questions} (${(baseline.accuracy * 100).toFixed(1)}%)`);
  console.log(`Experiment: ${experiment.correct}/${experiment.total_questions} (${(experiment.accuracy * 100).toFixed(1)}%)`);
  console.log(`Difference: ${experiment.correct - baseline.correct > 0 ? '+' : ''}${experiment.correct - baseline.correct} questions (${((experiment.accuracy - baseline.accuracy) * 100).toFixed(1)}%)`);

  // Show which questions changed
  const improved = [];
  const regressed = [];

  for (let i = 0; i < baseline.total_questions; i++) {
    if (baseline.by_question[i].question_id !== experiment.by_question[i].question_id) {
      console.error('❌ ERROR: Question order mismatch - results not comparable');
      process.exit(1);
    }

    const b = baseline.by_question[i].correct;
    const e = experiment.by_question[i].correct;

    if (!b && e) improved.push(baseline.by_question[i].question_id);
    if (b && !e) regressed.push(baseline.by_question[i].question_id);
  }

  if (improved.length > 0) {
    console.log(`\n✅ Improved (${improved.length}):`);
    improved.forEach(id => console.log(`  - ${id}`));
  }

  if (regressed.length > 0) {
    console.log(`\n❌ Regressed (${regressed.length}):`);
    regressed.forEach(id => console.log(`  - ${id}`));
  }
}

// CLI
const command = process.argv[2];

if (command === 'parse') {
  const result = parseBenchmarkResults(process.argv[3]);
  console.log(JSON.stringify(result, null, 2));
} else if (command === 'compare') {
  const baseline = parseBenchmarkResults(process.argv[3]);
  const experiment = parseBenchmarkResults(process.argv[4]);
  compareResults(baseline, experiment);
} else {
  console.log('Usage:');
  console.log('  parse_benchmark_results.ts parse <eval-results-file>');
  console.log('  parse_benchmark_results.ts compare <baseline-file> <experiment-file>');
}
```

**Usage**:
```bash
# Parse single result
npx tsx scripts/parse_benchmark_results.ts parse \
  benchmarks/reports/longmemeval.C.60.baseline.filtered.jsonl.eval-results-gpt-4o

# Compare two results
npx tsx scripts/parse_benchmark_results.ts compare \
  benchmarks/reports/longmemeval.C.60.baseline.filtered.jsonl.eval-results-gpt-4o \
  benchmarks/reports/longmemeval.C.60.enhanced.filtered.jsonl.eval-results-gpt-4o
```

**Benefits**:
- Consistent, reliable parsing
- Automatic comparability checks
- Clear error messages
- Shows specific improvements/regressions

### Priority 4: Improved Dataset Naming (MEDIUM) - ✅ IMPLEMENTED

**Change**: Rename datasets to be self-describing

**Implemented Naming**:
All datasets have been renamed with descriptive names that clearly indicate question counts:

```
longmemeval_oracle_v1_500q.json          # Oracle dataset, 500 questions
longmemeval_oracle_v1_50q.json           # Oracle dataset, 50 questions
longmemeval_m_v1_500q.json               # M variant, 500 questions
longmemeval_s_v1_500q.json               # S variant, 500 questions
longmemeval_multisession_v1_50q.json     # Multi-session dataset, 50 questions
longmemeval_preferences_v1_30q.json      # Preferences dataset, 30 questions
longmemeval_temporal_v1_10q.json         # Temporal reasoning dataset, 10 questions
```

**Migration**:
Backward-compatible symlinks have been created:
```bash
longmemeval_oracle.json -> longmemeval_oracle_v1_500q.json
longmemeval_oracle_50q.json -> longmemeval_oracle_v1_50q.json
longmemeval_m.json -> longmemeval_m_v1_500q.json
longmemeval_s.json -> longmemeval_s_v1_500q.json
longmemeval_multisession_50q.json -> longmemeval_multisession_v1_50q.json
longmemeval_preferences_30q.json -> longmemeval_preferences_v1_30q.json
longmemeval_test_10_temporal.json -> longmemeval_temporal_v1_10q.json
```

**Benefits**:
- Clear what each dataset contains
- Easy to understand size/scope at a glance
- Versioning for future changes
- Full backward compatibility via symlinks

### Priority 5: Validation and Warnings (MEDIUM)

**Change**: Add validation to benchmark runner

**Implementation**:
```bash
# In run_longmemeval.sh, before starting benchmark

# Check dataset exists
if [ ! -f "$DATASET" ]; then
  echo "❌ Error: Dataset not found: $DATASET"
  exit 1
fi

# Warn if comparing across different configs
if [ -f "$OUTPUT.filtered.jsonl.eval-results-gpt-4o" ]; then
  echo "⚠️  WARNING: Output file already exists"
  echo "  This may indicate you're comparing different configurations"
  echo "  Previous result will be overwritten"
  read -p "Continue? (y/n) " -n 1 -r
  echo
  if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    exit 1
  fi
fi

# Validate seed is reasonable
if [ $SEED -lt 1 ] || [ $SEED -gt 1000 ]; then
  echo "⚠️  WARNING: Unusual seed value: $SEED"
  echo "  Seeds typically 1-100 for reproducibility"
fi
```

**Benefits**:
- Catches common mistakes
- Prevents accidental overwrites
- Improves user awareness

---

## Implementation Plan

### Phase 1: Critical Fixes (Immediate) - ✅ COMPLETE
1. ✅ Make dataset parameter required (Priority 1)
2. ✅ Create result parsing utility (Priority 3)
3. ✅ Add validation checks (Priority 5)

### Phase 2: Metadata & Infrastructure (Next Week) - ✅ COMPLETE
4. ✅ Add metadata to output files (Priority 2)
5. ✅ Rename datasets with descriptive names (Priority 4)
6. ✅ Create symlinks for backward compatibility

### Phase 3: Polish (Future)
7. Create benchmark result dashboard
8. Automated regression detection

---

## Backward Compatibility

**Concerns**:
- Existing scripts may break with required dataset parameter
- Existing result files have no metadata

**Solutions**:
- Provide migration script to add metadata to existing results
- Keep old dataset names as symlinks
- Parsing utility handles both old and new formats
- Clear migration guide in CHANGELOG

---

## Testing Plan

1. **Unit tests** for parsing utility
2. **Integration tests** for benchmark runner with new parameters
3. **Regression tests** comparing old vs new output formats
4. **Manual testing** of common workflows:
   - Run baseline benchmark
   - Run experiment
   - Compare results
   - Detect incompatible comparisons

---

## Success Criteria

✅ Can run benchmark with explicit dataset and understand what's being tested
✅ Can compare two results and get clear, accurate difference
✅ System warns when comparing incompatible results
✅ No more silent failures or confusing outputs
✅ Easy to audit what configuration produced which results

---

## Open Questions

1. Should we version the metadata schema for future evolution?
2. How to handle results from before metadata was added?
3. Should comparison tool generate visual diffs (e.g., HTML report)?
4. Where should we store "blessed" baseline results for CI/CD?

---

## Example Improved Workflow

**Before** (Current, Confusing):
```bash
# Unclear what dataset will be used
./run_longmemeval.sh --variant C --seed 60 --out baseline.jsonl

# Hard to parse results
cat baseline.filtered.jsonl.eval-results-gpt-4o | grep '"label": true' | wc -l
# Result: 21 ... out of how many? What dataset?

# Compare with another run
./run_longmemeval.sh --variant C --seed 60 --out experiment.jsonl
# Wait, why are these different question counts?
```

**After** (Improved, Clear):
```bash
# Explicit dataset selection
./run_longmemeval.sh \
  --variant C \
  --seed 60 \
  --dataset-name oracle_50ctx_100q \
  --out benchmarks/reports/baseline.jsonl

# Easy, reliable parsing
npx tsx scripts/parse_benchmark_results.ts parse \
  benchmarks/reports/baseline.filtered.jsonl.eval-results-gpt-4o
# Output: 86/100 correct (86.0%)

# Run experiment
./run_longmemeval.sh \
  --variant C \
  --seed 60 \
  --dataset-name oracle_50ctx_100q \
  --out benchmarks/reports/experiment.jsonl

# Clear comparison
npx tsx scripts/parse_benchmark_results.ts compare \
  benchmarks/reports/baseline.filtered.jsonl.eval-results-gpt-4o \
  benchmarks/reports/experiment.filtered.jsonl.eval-results-gpt-4o

# Output:
# === Comparison ===
# Baseline:   86/100 (86.0%)
# Experiment: 89/100 (89.0%)
# Difference: +3 questions (+3.0%)
#
# ✅ Improved (3):
#   - question_abc123
#   - question_def456
#   - question_ghi789
```

---

## Conclusion

These improvements will eliminate the confusion we experienced and make benchmark results:
- **Reproducible**: Clear what dataset and config was used
- **Comparable**: Validation ensures apples-to-apples comparison
- **Auditable**: Metadata provides full provenance
- **Reliable**: Standard parsing eliminates silent failures

The most critical fix is making dataset selection explicit (Priority 1), which we should implement immediately.
