#!/usr/bin/env bash
# Small accuracy smoke: re-score existing LongMemEval smoke predictions using the official evaluator.
# This script sources .env (if present) to set OPENAI_API_KEY, then invokes the scorer.
# Exit codes:
#   0 = success
#   2 = OPENAI_API_KEY missing (skipped)
#   other = runtime error from scorer/evaluator

set -euo pipefail

# Ensure we run from repo root (this file lives at scripts/dev/)
cd "$(dirname "$0")/../.."

echo "[score_smoke_once] Starting..."
echo "[score_smoke_once] Looking for .env at project root to source OPENAI_API_KEY"

if [[ -f ".env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source ".env"
  set +a
  echo "[score_smoke_once] .env sourced"
else
  echo "[score_smoke_once] No .env found; proceeding without sourcing"
fi

if [[ -z "${OPENAI_API_KEY:-}" ]]; then
  echo "[score_smoke_once] OPENAI_API_KEY is not set; LLM-based scorer cannot run."
  echo "[score_smoke_once] Provide OPENAI_API_KEY in .env and re-run. Exiting."
  exit 2
fi

echo "[score_smoke_once] Running scorer on smoke predictions..."
node --import ./scripts/register-ts-node.mjs benchmarks/runners/score_longmemeval.ts \
  --hyp benchmarks/reports/memora_predictions.s.smoke.jsonl \
  --dataset benchmarks/LongMemEval/data/longmemeval_oracle.json \
  --tag gpt-4o

echo "[score_smoke_once] Scoring complete."
