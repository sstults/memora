#!/usr/bin/env bash
set -euo pipefail

# Usage:
#   ./benchmarks/runners/run_longmemeval.sh --variant A|B|C --seed 42 --out benchmarks/reports/longmemeval.C.42.jsonl
#
# Variants:
#   A = Sliding-window only (no memory)
#   B = Vector RAG baseline (no Memora policies)
#   C = Memora MCP (full)
#
# Note: This is a scaffold. Integrate LongMemEval harness where indicated.
#       This script just writes a JSONL header entry for now so wiring can be validated.

variant="C"
seed="42"
out="benchmarks/reports/longmemeval.${variant}.${seed}.jsonl"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --variant) variant="$2"; shift 2;;
    --seed) seed="$2"; shift 2;;
    --out) out="$2"; shift 2;;
    *) echo "Unknown arg: $1" >&2; exit 1;;
  esac
done

mkdir -p "$(dirname "$out")" || mkdir -p benchmarks/reports

# Ensure ts-node registration is available for TS runners in this repo
NODE_RUNNER="node --import ./scripts/register-ts-node.mjs"

# Build TS to JS and prefer compiled runner; fallback to ts-node if missing
if npm run build >/dev/null 2>&1; then
  :
fi

if [[ -f "dist/benchmarks/runners/longmemeval.js" ]]; then
  node dist/benchmarks/runners/longmemeval.js --variant "${variant}" --seed "${seed}" --out "${out}"
else
  # Fallback to ts-node registration
  $NODE_RUNNER benchmarks/runners/longmemeval.ts --variant "${variant}" --seed "${seed}" --out "${out}"
fi

echo "Wrote ${out}"
