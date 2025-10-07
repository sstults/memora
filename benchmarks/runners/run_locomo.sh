#!/usr/bin/env bash
set -euo pipefail

# LoCoMo-style Long-Context QA end-to-end runner
# Usage:
#   ./benchmarks/runners/run_locomo.sh \
#     [--dataset_id some_org/LoCoMo] \
#     [--from_file path/to/local.json] \
#     [--split test] \
#     [--seed 42] \
#     [--judge gpt-4o] \
#     [--limit 50]
#
# Notes:
# - Driver writes predictions JSON to: outputs/memora/LoCoMo/<tag>_SEED{seed}.json
#   where <tag> is derived from dataset_id or basename(from_file)
# - Scorer writes evaluation logs to: outputs/memora/LoCoMo/.eval-results-memora-{fileTag}
# - Requires: OPENAI_API_KEY for scoring (judge), Python 'datasets' pkg for HF data (when using --dataset_id)

dataset_id=""
from_file=""
split="test"
seed="42"
judge="gpt-4o"
limit=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dataset_id) dataset_id="$2"; shift 2;;
    --from_file) from_file="$2"; shift 2;;
    --split) split="$2"; shift 2;;
    --seed) seed="$2"; shift 2;;
    --judge) judge="$2"; shift 2;;
    --limit) limit="$2"; shift 2;;
    *)
      echo "Unknown arg: $1" >&2
      echo "Usage: $0 [--dataset_id some_org/LoCoMo] [--from_file path/to/local.json] [--split test] [--seed 42] [--judge gpt-4o] [--limit N]" >&2
      exit 1;;
  esac
done

# Validate inputs
if [[ -z "${dataset_id}" && -z "${from_file}" ]]; then
  echo "ERROR: Provide one of --dataset_id or --from_file" >&2
  exit 2
fi
if [[ -n "${dataset_id}" && -n "${from_file}" ]]; then
  echo "ERROR: Provide only one of --dataset_id or --from_file (not both)" >&2
  exit 2
fi

# Load .env from repo root if present (export variables to subprocesses)
if [[ -f ".env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source ./.env
  set +a
fi

# Derived output path components
PRED_DIR="outputs/memora/LoCoMo"
mkdir -p "${PRED_DIR}"

if [[ -n "${from_file}" ]]; then
  TAG_SAFE="$(basename "${from_file}" | tr -s '*' 'x')"
else
  # Transform dataset_id into a safe tag (replace / and : with .)
  TAG_SAFE="$(echo -n "${dataset_id}" | sed 's/[\/:]/./g' | tr -s '*' 'x')"
fi

PRED_FILE="${PRED_DIR}/${TAG_SAFE}_SEED${seed}.json"

# Logging
LOG_DIR="benchmarks/logs"
mkdir -p "${LOG_DIR}"
RUN_TAG="locomo.seed${seed}.${TAG_SAFE}"
DRIVER_LOG="${LOG_DIR}/${RUN_TAG}.driver.log"
SCORE_LOG="${LOG_DIR}/${RUN_TAG}.score.log"

echo "=== LoCoMo: Build ==="
npm run build

echo "=== LoCoMo: Driver ==="
echo "DatasetID='${dataset_id:-none}' FromFile='${from_file:-none}' Split='${split}' Seed=${seed} Limit='${limit:-none}'"
NODE_RUNNER="node --import ./scripts/register-ts-node.mjs"

if [[ -n "${from_file}" ]]; then
  DRIVER_ARGS=(benchmarks/runners/locomo_driver.ts --from_file "${from_file}" --split "${split}" --seed "${seed}" --out "${PRED_FILE}")
else
  DRIVER_ARGS=(benchmarks/runners/locomo_driver.ts --dataset_id "${dataset_id}" --split "${split}" --seed "${seed}" --out "${PRED_FILE}")
fi
if [[ -n "${limit}" ]]; then
  DRIVER_ARGS+=("--limit" "${limit}")
fi

${NODE_RUNNER} "${DRIVER_ARGS[@]}" >> "${DRIVER_LOG}" 2>&1

echo "Predictions: ${PRED_FILE}"

echo "=== LoCoMo: Score ==="
if [[ -z "${OPENAI_API_KEY:-}" ]]; then
  echo "WARNING: OPENAI_API_KEY not set; skipping scoring step." | tee -a "${SCORE_LOG}"
else
  ${NODE_RUNNER} benchmarks/runners/score_locomo.ts \
    --method memora \
    --pred "${PRED_FILE}" \
    --judge "${judge}" >> "${SCORE_LOG}" 2>&1
fi

echo "=== Done ==="
echo "Driver log: ${DRIVER_LOG}"
echo "Score log: ${SCORE_LOG}"
