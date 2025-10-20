#!/usr/bin/env bash
# Run a fast LongMemEval on a slice of sub5 QIDs to speed up iteration.
# Usage:
#   scripts/dev/run_small_eval_batch.sh [OFFSET] [N] [SUFFIX]
# Examples:
#   scripts/dev/run_small_eval_batch.sh                 # OFFSET=0, N=50
#   scripts/dev/run_small_eval_batch.sh 50 50           # OFFSET=50, N=50
#   scripts/dev/run_small_eval_batch.sh 100 50 mf_topk300
#
# Notes:
# - Ensures outputs/longmemeval_sub5.qids.csv exists (built from prior sub5 predictions).
# - Selects a deterministic slice [OFFSET, OFFSET+N) of QIDs.
# - Builds a small dataset and runs Variant C with current config (config/retrieval.yaml).
# - Prints quick metrics (idk_rate, accuracy if eval present).
set -euo pipefail

OFFSET="${1:-0}"
N="${2:-50}"
SUFFIX="${3:-}"
if [[ -n "${SUFFIX}" ]]; then
  SUFFIX=".${SUFFIX}"
fi

IN_PRED="benchmarks/reports/longmemeval.C.42.sub5.mq0.b30.sp1.jsonl"
OUT_QIDS_ALL="outputs/longmemeval_sub5.qids.csv"
OUT_QIDS_SMALL="outputs/longmemeval_sub5.qids.first${N}.off${OFFSET}.csv"
DATASET_IN="benchmarks/LongMemEval/data/longmemeval_s.json"
DATASET_OUT="outputs/longmemeval_s.subset.sub5.first${N}.off${OFFSET}.json"
OUT_PRED="benchmarks/reports/longmemeval.C.42.sub5.mq3.b30.sp1.first${N}.off${OFFSET}${SUFFIX}.jsonl"

mkdir -p outputs

# Ensure full QIDs CSV exists or build it from a prior predictions file
if [[ ! -f "${OUT_QIDS_ALL}" ]]; then
  if [[ ! -f "${IN_PRED}" ]]; then
    echo "Missing prior predictions file: ${IN_PRED}" >&2
    exit 2
  fi
  jq -r 'select(.question_id!=null) | .question_id' "${IN_PRED}" | sort -u | paste -sd, - > "${OUT_QIDS_ALL}"
fi

# Build slice [OFFSET, OFFSET+N)
TOTAL_QIDS=$(tr ',' '\n' < "${OUT_QIDS_ALL}" | wc -l | tr -d '[:space:]')
START=$(( OFFSET + 1 ))
if (( START > TOTAL_QIDS )); then
  echo "OFFSET ${OFFSET} exceeds total QIDs ${TOTAL_QIDS}" >&2
  exit 3
fi
tr ',' '\n' < "${OUT_QIDS_ALL}" | tail -n +"${START}" | head -n "${N}" | paste -sd, - > "${OUT_QIDS_SMALL}"

echo "QIDs slice (offset=${OFFSET}, n=${N}) written to ${OUT_QIDS_SMALL}:"
cat "${OUT_QIDS_SMALL}"

# Build subset dataset for these QIDs from the small S dataset
node --import ./scripts/register-ts-node.mjs scripts/dev/extract_by_qids.mjs \
  --dataset "${DATASET_IN}" \
  --qids "$(cat "${OUT_QIDS_SMALL}")" \
  --out "${DATASET_OUT}"

echo "Subset dataset written: ${DATASET_OUT}"
wc -c "${DATASET_OUT}" || true

echo "Predictions will be written to: ${OUT_PRED}"

# Run Variant C streaming with lexical-focused parameters (baseline settings from config/retrieval.yaml)
bash benchmarks/runners/run_longmemeval.sh \
  --variant C \
  --seed 42 \
  --dataset "${DATASET_OUT}" \
  --out "${OUT_PRED}" \
  --replayMode write \
  --budget 30 \
  --scopeProject 1 \
  --multiQuery 3

# Quick metrics
bash scripts/dev/quick_eval_metrics.sh "${OUT_PRED}" || true
