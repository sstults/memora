#!/usr/bin/env bash
# Run 4 diagnostic variants over 5 single-session-user questions to isolate accuracy issues.
# Variants:
#   V1: replay=salient, budget=20, scopeProject=1 (baseline)
#   V2: replay=write,   budget=20, scopeProject=1 (tests salience gating)
#   V3: replay=salient, budget=20, scopeProject=0 (tests scope noise)
#   V4: replay=salient, budget=50, scopeProject=1 (tests retrieval/pack budget)
set -euo pipefail

# cd to repo root
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

# Load .env if present (for OPENAI_API_KEY, OPENSEARCH_URL, etc.)
if [[ -f ".env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

# Ensure OpenSearch URL default is set for local dev
export OPENSEARCH_URL="${OPENSEARCH_URL:-http://localhost:19200}"

QIDS="6ade9755,75499fd8,86f00804,853b0a1d,4100d0a0"
DATASET_S="benchmarks/LongMemEval/data/longmemeval_s.json"
DATASET_ORACLE="benchmarks/LongMemEval/data/longmemeval_oracle.json"
OUT_DIR="benchmarks/reports"
mkdir -p "$OUT_DIR"

echo "Building project..."
npm run -s build

run_case() {
  local NAME="$1"       # V1/V2/V3/V4
  local REPLAY="$2"     # salient|write
  local BUDGET="$3"     # numeric
  local SCOPE="$4"      # 1 or 0 (include project scope)
  local OUT="$OUT_DIR/memora_predictions.s.5q.$NAME.jsonl"

  echo "==== CASE $NAME replay=$REPLAY budget=$BUDGET scopeProject=$SCOPE ===="
  node --import ./scripts/register-ts-node.mjs benchmarks/runners/longmemeval_driver.ts \
    --dataset "$DATASET_S" \
    --out "$OUT" \
    --variant C \
    --seed 42 \
    --qids "$QIDS" \
    --replayMode "$REPLAY" \
    --budget "$BUDGET" \
    --scopeProject "$SCOPE"

  echo "Scoring $OUT ..."
  node --import ./scripts/register-ts-node.mjs benchmarks/runners/score_longmemeval.ts \
    --hyp "$OUT" \
    --dataset "$DATASET_ORACLE" \
    --tag gpt-4o
}

run_case V1 salient 20 1
run_case V2 write   20 1
run_case V3 salient 20 0
run_case V4 salient 50 1

echo "==== Diagnostics summary (diag lines) ===="
for name in V1 V2 V3 V4; do
  OUT="$OUT_DIR/memora_predictions.s.5q.$name.jsonl"
  echo "-- $name --"
  if [[ -f "$OUT" ]]; then
    grep -E '"op":"diag"' "$OUT" || true
  else
    echo "Missing: $OUT"
  fi
done

echo "Done."
