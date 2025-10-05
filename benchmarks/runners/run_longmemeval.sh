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

# Placeholder run: emit a header JSON for the trial (replace this block with actual harness execution)
$NODE_RUNNER -e "
  const entry = {
    ts: new Date().toISOString(),
    op: 'run_longmemeval',
    variant: '${variant}',
    seed: Number(${seed}),
    model_config_path: 'benchmarks/config/llm.json',
    memora_config_path: 'benchmarks/config/memora.json',
    note: 'TODO: integrate LongMemEval harness and append per-step JSONL results here'
  };
  console.log(JSON.stringify(entry));
" > "$out"

echo "Wrote ${out}"
