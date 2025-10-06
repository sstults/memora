#!/usr/bin/env bash
set -euo pipefail

# MemoryAgentBench end-to-end runner
# Usage:
#   ./benchmarks/runners/run_memoryagentbench.sh \
#     [--source 'longmemeval_s*'] \
#     [--split Accurate_Retrieval] \
#     [--seed 42] \
#     [--judge gpt-4o] \
#     [--limit 50]
#
# Notes:
# - Driver writes predictions JSON to: outputs/memora/{split}/{source}_SEED{seed}.json
# - Scorer writes evaluation logs to: outputs/memora/{split}/.eval-results-memora-{fileTag}
# - Requires: OPENAI_API_KEY for scoring (judge), Python 'datasets' pkg for HF data.

source_pattern="longmemeval_s*"
split="Accurate_Retrieval"
seed="42"
judge="gpt-4o"
limit=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --source) source_pattern="$2"; shift 2;;
    --split) split="$2"; shift 2;;
    --seed) seed="$2"; shift 2;;
    --judge) judge="$2"; shift 2;;
    --limit) limit="$2"; shift 2;;
    *)
      echo "Unknown arg: $1" >&2
      echo "Usage: $0 [--source 'longmemeval_s*'] [--split Accurate_Retrieval] [--seed 42] [--judge gpt-4o] [--limit N]" >&2
      exit 1;;
  esac
done

# Derived paths
PRED_DIR="outputs/memora/${split}"
PRED_FILE="${PRED_DIR}/${source_pattern}_SEED${seed}.json"

mkdir -p "${PRED_DIR}"

# Logging
LOG_DIR="benchmarks/logs"
mkdir -p "${LOG_DIR}"
TAG_SAFE="$(echo "${source_pattern}" | tr -s '*' 'x')"
RUN_TAG="mab.${split}.seed${seed}.${TAG_SAFE}"
DRIVER_LOG="${LOG_DIR}/${RUN_TAG}.driver.log"
SCORE_LOG="${LOG_DIR}/${RUN_TAG}.score.log"

echo "=== MemoryAgentBench: Build ==="
npm run build

echo "=== MemoryAgentBench: Driver ==="
echo "Source='${source_pattern}' Split='${split}' Seed=${seed} Limit='${limit:-none}'"
NODE_RUNNER="node --import ./scripts/register-ts-node.mjs"
if [[ -n "${limit}" ]]; then
  ${NODE_RUNNER} benchmarks/runners/mab_driver.ts \
    --source "${source_pattern}" \
    --split "${split}" \
    --seed "${seed}" \
    --limit "${limit}" \
    --out "${PRED_FILE}" >> "${DRIVER_LOG}" 2>&1
else
  ${NODE_RUNNER} benchmarks/runners/mab_driver.ts \
    --source "${source_pattern}" \
    --split "${split}" \
    --seed "${seed}" \
    --out "${PRED_FILE}" >> "${DRIVER_LOG}" 2>&1
fi

echo "Predictions: ${PRED_FILE}"

echo "=== MemoryAgentBench: Score ==="
if [[ -z "${OPENAI_API_KEY:-}" ]]; then
  echo "WARNING: OPENAI_API_KEY not set; skipping scoring step." | tee -a "${SCORE_LOG}"
else
  ${NODE_RUNNER} benchmarks/runners/score_mab.ts \
    --method memora \
    --source "${source_pattern}" \
    --split "${split}" \
    --seed "${seed}" \
    --pred "${PRED_FILE}" \
    --judge "${judge}" >> "${SCORE_LOG}" 2>&1
fi

echo "=== Done ==="
echo "Driver log: ${DRIVER_LOG}"
echo "Score log: ${SCORE_LOG}"
