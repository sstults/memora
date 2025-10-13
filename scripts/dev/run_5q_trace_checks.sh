#!/usr/bin/env bash
# Purpose:
#   Run the 5-question debug with explicit, server-visible trace to the unified OS node,
#   verify index.request events for today's episodic index, and check episodic counts.
#   If trace shows zero index.request matches or counts did not increase, run V2 (write mode) once and expect retrieve.end.snippets > 0.
#
# Usage:
#   bash scripts/dev/run_5q_trace_checks.sh
#
# Notes:
# - This script gracefully ignores the scoring failure in longmemeval_debug_5q.sh
#   (which requires OPENAI_API_KEY). We only need the retrieval + indexing + trace.
# - It tails the trace file (per .clinerules) rather than reading it entirely.

set -euo pipefail

# cd to repo root
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")"/../.. && pwd)"
cd "$ROOT_DIR"

# Load .env if present (OPENSEARCH_URL, OPENAI_API_KEY, etc.)
if [[ -f ".env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

# Defaults
export OPENSEARCH_URL="${OPENSEARCH_URL:-http://localhost:19200}"
TRACE_DIR="outputs/memora/trace"
TRACE_FILE="${TRACE_DIR}/retrieve.ndjson"
mkdir -p "${TRACE_DIR}"

TENANT="${TENANT:-memora}"
PROJECT="${PROJECT:-benchmarks}"
TODAY_UTC="$(date -u +%F)"
export TODAY_INDEX="mem-episodic-${TODAY_UTC}"

# QIDs and dataset used by the 5-question debug (mirrors longmemeval_debug_5q.sh)
QIDS="6ade9755,75499fd8,86f00804,853b0a1d,4100d0a0"
DATASET_S="benchmarks/LongMemEval/data/longmemeval_s.json"

# Helper: JSON count for (tenant, project) on port 19200
count_tp_19200() {
  local base="http://localhost:19200"
  local idx="${TODAY_INDEX}"
  local data
  data=$(cat <<JSON
{"query":{"bool":{"must":[{"term":{"tenant_id":"${TENANT}"}},{"term":{"project_id":"${PROJECT}"}}]}}}
JSON
)
  curl -s --connect-timeout 2 --max-time 4 -H "Content-Type: application/json" -d "${data}" "${base}/${idx}/_count" | jq -r '.count // 0' 2>/dev/null || echo 0
}

# Helper: show matching index requests in the trace (tail only)
show_index_requests() {
  echo "== Matches for node=${OPENSEARCH_URL} and index=${TODAY_INDEX} (trace tail) =="
  if [[ -f "${TRACE_FILE}" ]]; then
    # Only tail to honor the .clinerules guidance
    local matches
    matches=$(tail -n 200000 "${TRACE_FILE}" | jq -rc \
      'select((.event=="index.request" or .event=="episodic.index.request")
              and (.node==env.OPENSEARCH_URL)
              and (((.index // "") == env.TODAY_INDEX) or ((.idx // "") == env.TODAY_INDEX)))' \
      | wc -l | awk '{print $1}')
    echo "Matches: ${matches}"
    tail -n 200000 "${TRACE_FILE}" | jq -rc \
      'select((.event=="index.request" or .event=="episodic.index.request")
              and (.node==env.OPENSEARCH_URL)
              and (((.index // "") == env.TODAY_INDEX) or ((.idx // "") == env.TODAY_INDEX)))
       | {ts,event,node,index:(.index // .idx // null),id:(.id // null),statusCode:(.statusCode // null),result:(.result // null)}' \
      | tail -n 5 || true
  else
    echo "Trace file not found: ${TRACE_FILE}"
  fi
}

# New helper: get count of index request matches in trace (tail only)
get_index_request_matches() {
  if [[ -f "${TRACE_FILE}" ]]; then
    tail -n 200000 "${TRACE_FILE}" | jq -rc \
      'select((.event=="index.request" or .event=="episodic.index.request")
              and (.node==env.OPENSEARCH_URL)
              and (((.index // "") == env.TODAY_INDEX) or ((.idx // "") == env.TODAY_INDEX)))' \
      | wc -l | awk '{print $1}'
  else
    echo 0
  fi
}

# Helper: show recent retrieve.end stats (tail only)
show_retrieve_end_stats() {
  echo "== Recent retrieve.end events (snippets, total) =="
  if [[ -f "${TRACE_FILE}" ]]; then
    tail -n 200000 "${TRACE_FILE}" | jq -rc \
      'select(.event=="retrieve.end") | {ts,event,snippets:(.snippets // null),total:(.total // .total.value? // null)}' \
      | tail -n 10 || true
  else
    echo "Trace file not found: ${TRACE_FILE}"
  fi
}

# Step 0: Baseline count
echo "-- Checking initial episodic count (tenant=${TENANT}, project=${PROJECT}) on 19200 --"
COUNT_BEFORE="$(count_tp_19200)"
echo "COUNT_BEFORE=${COUNT_BEFORE}"

# Step 1: Run the 5-question debug with explicit trace
echo
echo "-- Running 5-question debug with explicit trace (this may fail on scoring if OPENAI_API_KEY is not set; that is OK) --"
if [[ -f "${TRACE_FILE}" ]]; then
  mv "${TRACE_FILE}" "${TRACE_DIR}/retrieve.prev.$(date -u +%s).ndjson" || true
fi

# Always record explicit query trace to a file
set +e
MEMORA_QUERY_TRACE=true MEMORA_TRACE_FILE="${TRACE_FILE}" DEBUG=memora:* \
  bash scripts/dev/longmemeval_debug_5q.sh
RET=$?
set -e
if [[ "${RET}" -ne 0 ]]; then
  echo "[warn] longmemeval_debug_5q.sh returned non-zero (likely scoring error without OPENAI_API_KEY). Continuing with trace checks."
fi

# Step 2: Trace verification and counts
echo
show_index_requests
echo
show_retrieve_end_stats
echo
echo "-- Checking episodic counts after run --"
COUNT_AFTER="$(count_tp_19200)"
echo "COUNT_AFTER=${COUNT_AFTER}"

# Decide if counts increased
INCREASED=0
if [[ "${COUNT_AFTER}" =~ ^[0-9]+$ ]] && [[ "${COUNT_BEFORE}" =~ ^[0-9]+$ ]]; then
  if (( COUNT_AFTER > COUNT_BEFORE )); then
    INCREASED=1
  fi
fi

# Compute index.request match count from trace (tail-only) and whether counts are unchanged
MATCHES="$(get_index_request_matches)"
if [[ -z "${MATCHES}" ]]; then MATCHES=0; fi

EQUAL_COUNTS=0
if [[ "${COUNT_AFTER}" =~ ^[0-9]+$ ]] && [[ "${COUNT_BEFORE}" =~ ^[0-9]+$ ]]; then
  if (( COUNT_AFTER == COUNT_BEFORE )); then
    EQUAL_COUNTS=1
  fi
fi

if (( MATCHES == 0 )) || (( EQUAL_COUNTS == 1 )); then
  echo
  echo "== No index.request matches (${MATCHES}) or counts unchanged (${COUNT_BEFORE} -> ${COUNT_AFTER}). Running V2 write mode once to verify retrieve.end.snippets > 0 =="
  OUT_V2="benchmarks/reports/memora_predictions.s.5q.V2.single.jsonl"
  echo "Running V2 write mode (single) ..."
  MEMORA_QUERY_TRACE=true MEMORA_TRACE_FILE="${TRACE_FILE}" DEBUG=memora:* \
    node --import ./scripts/register-ts-node.mjs benchmarks/runners/longmemeval_driver.ts \
      --dataset "${DATASET_S}" \
      --out "${OUT_V2}" \
      --variant C \
      --seed 42 \
      --qids "${QIDS}" \
      --replayMode write \
      --budget 20 \
      --scopeProject 1

  echo
  echo "-- Checking retrieve.end snippets after V2 write mode --"
  if [[ -f "${TRACE_FILE}" ]]; then
    V2_SNIPPETS=$(tail -n 200000 "${TRACE_FILE}" | jq -rc 'select(.event=="retrieve.end") | .snippets // 0' | tail -n 20 | awk '{s+=$1} END {print s}')
    echo "Sum of last 20 retrieve.end snippets: ${V2_SNIPPETS}"
  else
    echo "Trace file not found to check snippets: ${TRACE_FILE}"
  fi
else
  echo
  echo "== Index request matches present (${MATCHES}) and counts increased (${COUNT_BEFORE} -> ${COUNT_AFTER}). Skipping V2 write pass. =="
fi

echo
echo "-- Final episodic counts across ports (for visibility) --"
TENANT="${TENANT}" PROJECT="${PROJECT}" bash scripts/dev/check_episodic_counts.sh

echo
echo "Done."
