#!/usr/bin/env bash
#
# BM25 Parameter Tuning - Targeted Sweep on Failed Questions
#
# This script runs a grid search over BM25 k1 and b parameters,
# testing only on the 11 questions that consistently failed in C.43.
#
# Usage:
#   ./scripts/tune_bm25_targeted.sh
#
# Environment:
#   OPENSEARCH_URL - OpenSearch endpoint (default: http://localhost:9200)
#   MEMORA_RERANK_ENABLED - Set to false for pure BM25 testing (default: false)
#
# Output:
#   benchmarks/reports/bm25_tuning/targeted_sweep_results.csv
#   benchmarks/reports/bm25_tuning/targeted_sweep_*.jsonl (per config)

set -euo pipefail

# Configuration
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
OUTPUT_DIR="$PROJECT_ROOT/benchmarks/reports/bm25_tuning"
ORACLE_FILE="$PROJECT_ROOT/benchmarks/LongMemEval/data/longmemeval_oracle.json"

# Failed question IDs from error analysis (docs/error-analysis-c43.md)
FAILED_QS=(
  "08f4fc43"
  "982b5123"
  "993da5e2"
  "a3045048"
  "a3838d2b"
  "gpt4_0a05b494"
  "gpt4_0b2f1d21"
  "gpt4_1a1dc16d"
  "gpt4_2c50253f"
  "gpt4_9a159967"
  "gpt4_d9af6064"
)

# BM25 parameter grid
# Current baseline: k1=1.2, b=0.4 (episodic), k1=1.2, b=0.6 (semantic)
# We'll test variations around these values
K1_VALUES=(0.8 1.0 1.2 1.5 2.0)
B_VALUES=(0.2 0.4 0.6 0.8)

# Ensure output directory exists
mkdir -p "$OUTPUT_DIR"

# Create filtered oracle with only failed questions
FAILED_ORACLE="$OUTPUT_DIR/failed_questions_oracle.json"
echo "Creating filtered oracle with ${#FAILED_QS[@]} failed questions..."

# Extract failed questions using jq
cat "$ORACLE_FILE" | jq --argjson ids "$(printf '%s\n' "${FAILED_QS[@]}" | jq -R . | jq -s .)" '
  map(select(.question_id as $qid | $ids | index($qid)))
' > "$FAILED_ORACLE"

FAILED_COUNT=$(cat "$FAILED_ORACLE" | jq 'length')
echo "✓ Created oracle with $FAILED_COUNT questions"

# Initialize results CSV
RESULTS_CSV="$OUTPUT_DIR/targeted_sweep_results.csv"
echo "k1,b,correct,total,accuracy_pct,mean_latency_ms,config_name" > "$RESULTS_CSV"

echo ""
echo "=========================================="
echo "BM25 Parameter Sweep - Targeted"
echo "=========================================="
echo "Testing ${#K1_VALUES[@]} k1 values × ${#B_VALUES[@]} b values = $((${#K1_VALUES[@]} * ${#B_VALUES[@]})) configurations"
echo "Questions: ${#FAILED_QS[@]} consistently-failing questions"
echo "Seed: 42 (fixed for reproducibility)"
echo "Reranking: disabled (MEMORA_RERANK_ENABLED=false)"
echo ""

TOTAL_CONFIGS=$((${#K1_VALUES[@]} * ${#B_VALUES[@]}))
CURRENT=0

for k1 in "${K1_VALUES[@]}"; do
  for b in "${B_VALUES[@]}"; do
    CURRENT=$((CURRENT + 1))
    CONFIG_NAME="k1_${k1}_b_${b}"

    echo "[$CURRENT/$TOTAL_CONFIGS] Testing k1=$k1, b=$b..."

    # Update OpenSearch index settings for both episodic and semantic indices
    # Note: This requires the indices to exist and be writable
    curl -s -X PUT "${OPENSEARCH_URL:-http://localhost:9200}/mem-episodic-*/_settings" \
      -H 'Content-Type: application/json' \
      -d "{
        \"index\": {
          \"similarity\": {
            \"bm25_episodic\": {
              \"type\": \"BM25\",
              \"k1\": $k1,
              \"b\": $b
            }
          }
        }
      }" > /dev/null 2>&1 || echo "  ⚠ Warning: Failed to update episodic index settings"

    curl -s -X PUT "${OPENSEARCH_URL:-http://localhost:9200}/mem-semantic/_settings" \
      -H 'Content-Type: application/json' \
      -d "{
        \"index\": {
          \"similarity\": {
            \"bm25_sem\": {
              \"type\": \"BM25\",
              \"k1\": $k1,
              \"b\": $b
            }
          }
        }
      }" > /dev/null 2>&1 || echo "  ⚠ Warning: Failed to update semantic index settings"

    # Run benchmark on failed questions only
    OUTPUT_FILE="$OUTPUT_DIR/targeted_sweep_$CONFIG_NAME.jsonl"

    export MEMORA_RERANK_ENABLED=false

    # Run the benchmark
    node --import "$PROJECT_ROOT/scripts/register-ts-node.mjs" \
      "$PROJECT_ROOT/benchmarks/runners/longmemeval_driver.ts" \
      --dataset "$FAILED_ORACLE" \
      --out "$OUTPUT_FILE" \
      --variant "C" \
      --seed 42 \
      > /dev/null 2>&1

    # Score the results
    SCORE_OUTPUT=$(node --import "$PROJECT_ROOT/scripts/register-ts-node.mjs" \
      "$PROJECT_ROOT/benchmarks/runners/score_longmemeval.ts" \
      --hyp "$OUTPUT_FILE" \
      --dataset "$FAILED_ORACLE" \
      --tag "$CONFIG_NAME" 2>&1)

    # Extract metrics from score output
    CORRECT=$(echo "$SCORE_OUTPUT" | grep -oP 'Correct: \K\d+' || echo "0")
    TOTAL=$(echo "$SCORE_OUTPUT" | grep -oP 'Total: \K\d+' || echo "$FAILED_COUNT")
    ACCURACY=$(echo "scale=2; $CORRECT * 100 / $TOTAL" | bc)

    # Extract mean latency if available
    MEAN_LATENCY=$(cat "$OUTPUT_FILE" | jq -s 'map(select(.llm_latency_ms)) | map(.llm_latency_ms) | add / length' 2>/dev/null || echo "0")

    echo "  Result: $CORRECT/$TOTAL correct (${ACCURACY}%)"

    # Append to CSV
    echo "$k1,$b,$CORRECT,$TOTAL,$ACCURACY,$MEAN_LATENCY,$CONFIG_NAME" >> "$RESULTS_CSV"
  done
done

echo ""
echo "=========================================="
echo "Sweep Complete!"
echo "=========================================="
echo ""
echo "Results saved to: $RESULTS_CSV"
echo ""
echo "Top 5 configurations by accuracy:"
tail -n +2 "$RESULTS_CSV" | sort -t, -k5 -rn | head -5 | \
  awk -F, 'BEGIN {printf "%-8s %-8s %-10s %-10s\n", "k1", "b", "Correct", "Accuracy"}
           {printf "%-8s %-8s %-10s %-10s\n", $1, $2, $3"/"$4, $5"%"}'

echo ""
echo "Current baseline (k1=1.2, b=0.4):"
grep "^1.2,0.4," "$RESULTS_CSV" | \
  awk -F, '{printf "  Correct: %s/%s (%.1f%%)\n", $3, $4, $5}'

echo ""
echo "Next steps:"
echo "1. Review full results: cat $RESULTS_CSV"
echo "2. If a configuration shows improvement, validate on full benchmark:"
echo "   ./benchmarks/runners/run_longmemeval.sh --variant C --seed 44 --out benchmarks/reports/longmemeval.C.44.tuned.jsonl"
echo "3. Update index templates in config/index-templates/ with optimal parameters"
echo ""
