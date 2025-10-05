#!/usr/bin/env bash
set -euo pipefail

# LongMemEval end-to-end runner
# Usage:
#   ./benchmarks/runners/run_longmemeval.sh --variant A|B|C --seed 42 --out benchmarks/reports/longmemeval.C.42.jsonl [--dataset PATH] [--tag TAG]
#
# Variants:
#   A = Sliding-window only (no memory)
#   B = Vector RAG baseline (no Memora policies)
#   C = Memora MCP (full)
#
# This script:
#   1) Runs the TypeScript driver to generate predictions JSONL
#   2) Scores predictions with the Python LongMemEval evaluator
#   3) Aggregates latency/token telemetry into CSV/Markdown

variant="C"
seed="42"
dataset="benchmarks/LongMemEval/data/longmemeval_oracle.json"
tag="memora"
out=""  # if empty, computed from variant+seed

while [[ $# -gt 0 ]]; do
  case "$1" in
    --variant) variant="$2"; shift 2;;
    --seed) seed="$2"; shift 2;;
    --out) out="$2"; shift 2;;
    --dataset) dataset="$2"; shift 2;;
    --tag) tag="$2"; shift 2;;
    *)
      echo "Unknown arg: $1" >&2
      echo "Usage: $0 --variant A|B|C --seed N [--out PATH] [--dataset PATH] [--tag TAG]" >&2
      exit 1;;
  esac
done

if [[ -z "${out}" ]]; then
  out="benchmarks/reports/longmemeval.${variant}.${seed}.jsonl"
fi

mkdir -p "$(dirname "$out")"

# Ensure ts-node registration is available for TS runners in this repo
NODE_RUNNER="node --import ./scripts/register-ts-node.mjs"

echo "=== LongMemEval: Driver ==="
echo "Variant=${variant} Seed=${seed}"
echo "Dataset=${dataset}"
echo "Output=${out}"
$NODE_RUNNER benchmarks/runners/longmemeval_driver.ts \
  --dataset "${dataset}" \
  --out "${out}" \
  --variant "${variant}" \
  --seed "${seed}"

echo "=== LongMemEval: Score ==="
$NODE_RUNNER benchmarks/runners/score_longmemeval.ts \
  --hyp "${out}" \
  --dataset "${dataset}" \
  --tag "${tag}"

echo "=== LongMemEval: Aggregate ==="
$NODE_RUNNER benchmarks/runners/aggregate_longmemeval.ts \
  --in "${out}"

echo "=== Done ==="
echo "Predictions: ${out}"
echo "See adjacent .filtered.jsonl, .eval-results-*, .stats.csv and .stats.md outputs."
