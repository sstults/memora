#!/usr/bin/env bash
# Forced V2 write-mode run with explicit trace to validate episodic index + retrieve.end snippets
# Follows .clinerules guidance: operate on tails via jq/head/tail rather than reading large files entirely.

set -euo pipefail

# cd to repo root
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")"/../.. && pwd)"
cd "$ROOT_DIR"

# Env and paths
export OPENSEARCH_URL="${OPENSEARCH_URL:-http://localhost:9200}"
TRACE_DIR="outputs/memora/trace"
TRACE_FILE="${TRACE_DIR}/retrieve.ndjson"
mkdir -p "${TRACE_DIR}"

TENANT="${TENANT:-memora}"
PROJECT="${PROJECT:-benchmarks}"
TODAY_UTC="$(date -u +%F)"
export TODAY_INDEX="mem-episodic-${TODAY_UTC}"

# Helper to print a section header
section() {
  echo
  echo "=== $* ==="
}

section "Diag from V2.single jsonl (tail)"
if [[ -f benchmarks/reports/memora_predictions.s.5q.V2.single.jsonl ]]; then
  tail -n 2000 benchmarks/reports/memora_predictions.s.5q.V2.single.jsonl \
    | jq -rc 'select(.op=="diag") | {stage, qid, mode, attempted, written, k, snippets, packed_len}' \
    | tail -n 20 || true
else
  echo "File not found: benchmarks/reports/memora_predictions.s.5q.V2.single.jsonl"
fi

section "Diag from V2 jsonl (tail)"
if [[ -f benchmarks/reports/memora_predictions.s.5q.V2.jsonl ]]; then
  tail -n 5000 benchmarks/reports/memora_predictions.s.5q.V2.jsonl \
    | jq -rc 'select(.op=="diag") | {stage, qid, mode, attempted, written, k, snippets, packed_len}' \
    | tail -n 20 || true
else
  echo "File not found: benchmarks/reports/memora_predictions.s.5q.V2.jsonl"
fi

section "Running forced V2 write-mode with trace"
if [[ -f "${TRACE_FILE}" ]]; then
  mv "${TRACE_FILE}" "${TRACE_DIR}/retrieve.prev.$(date -u +%s).ndjson" || true
fi

set +e
MEMORA_QUERY_TRACE=true MEMORA_TRACE_FILE="${TRACE_FILE}" DEBUG=memora:* MEMORA_FORCE_EPI_DIRECT_WRITE=1 \
  node --import ./scripts/register-ts-node.mjs benchmarks/runners/longmemeval_driver.ts \
    --dataset benchmarks/LongMemEval/data/longmemeval_s.json \
    --out benchmarks/reports/memora_predictions.s.5q.V2.single.jsonl \
    --variant C \
    --seed 42 \
    --qids "6ade9755,75499fd8,86f00804,853b0a1d,4100d0a0" \
    --replayMode write \
    --budget 20 \
    --scopeProject 1
RET=$?
set -e
if [[ "${RET}" -ne 0 ]]; then
  echo "[warn] longmemeval_driver.ts returned non-zero. Continuing with trace checks."
fi

section "Index request matches (tail) for node=${OPENSEARCH_URL} and index=${TODAY_INDEX}"
if [[ -f "${TRACE_FILE}" ]]; then
  MATCHES=$(tail -n 200000 "${TRACE_FILE}" | jq -rc \
    'select((.event=="index.request" or .event=="episodic.index.request")
            and (.node==env.OPENSEARCH_URL)
            and (((.index // "") == env.TODAY_INDEX) or ((.idx // "") == env.TODAY_INDEX)))' \
    | wc -l | awk '{print $1}')
  echo "Matches: ${MATCHES}"
  tail -n 200000 "${TRACE_FILE}" | jq -rc \
    'select((.event=="index.request" or .event=="episodic.index.request")
            and (.node==env.OPENSEARCH_URL)
            and (((.index // "") == env.TODAY_INDEX) or ((.idx // "") == env.TODAY_INDEX)))
     | {ts,event,node,index:(.index // .idx // null),id:(.id // null),statusCode:(.statusCode // null),result:(.result // null)}' \
    | tail -n 5 || true
else
  echo "Trace file not found: ${TRACE_FILE}"
fi

section "Recent retrieve.end stats (tail)"
if [[ -f "${TRACE_FILE}" ]]; then
  tail -n 200000 "${TRACE_FILE}" | jq -rc \
    'select(.event=="retrieve.end") | {ts,event,snippets:(.snippets // null),total:(.total // .total.value? // null)}' \
    | tail -n 10 || true
  V2_SNIPPETS=$(tail -n 200000 "${TRACE_FILE}" | jq -rc 'select(.event=="retrieve.end") | .snippets // 0' | tail -n 20 | awk '{s+=$1} END {print s}')
  echo "Sum of last 20 retrieve.end snippets: ${V2_SNIPPETS}"
else
  echo "Trace file not found: ${TRACE_FILE}"
fi

section "Final episodic counts across ports (for visibility)"
TENANT="${TENANT}" PROJECT="${PROJECT}" bash scripts/dev/check_episodic_counts.sh

echo
echo "Done."
