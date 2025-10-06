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

# Configure Memora for accurate retrieval when running Variant C:
# - Use OpenSearch ML ingest pipeline for embeddings (replaces local fallback)
# - Attach ingest pipeline as index default (ensures embeddings computed on write)
# - Enable reranker (falls back to lexical if remote rerank is not configured)
# - Align embedding dimension with index mapping (384)
# - Point client to local OpenSearch started via docker-compose
if [[ "${variant}" == "C" ]]; then
  export MEMORA_BOOTSTRAP_OS=1
  export MEMORA_EMBED_PROVIDER=opensearch_pipeline
  export MEMORA_OS_DEFAULT_PIPELINE_ATTACH=true
  export MEMORA_OS_AUTO_REGISTER_MODEL="${MEMORA_OS_AUTO_REGISTER_MODEL:-true}"
  export MEMORA_RERANK_ENABLED="${MEMORA_RERANK_ENABLED:-true}"
  export MEMORA_SEMANTIC_INDEX="${MEMORA_SEMANTIC_INDEX:-mem-semantic}"
  export MEMORA_EMBED_DIM="${MEMORA_EMBED_DIM:-384}"
  export OPENSEARCH_URL="${OPENSEARCH_URL:-http://localhost:19200}"
fi

echo "=== LongMemEval: Driver ==="
echo "Variant=${variant} Seed=${seed}"
echo "Dataset=${dataset}"
echo "Output=${out}"
# Build the project to ensure dist/ exists for compiled MCP server used by the driver
npm run build

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
