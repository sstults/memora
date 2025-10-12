#!/usr/bin/env bash
# Filter large retrieve.ndjson safely and verify episodic persistence in OpenSearch.
# Usage:
#   TRACE_FILE=outputs/memora/trace/retrieve.ndjson TAIL_N=8000 PRINT_N=80 OPENSEARCH_URL=http://localhost:19200 bash scripts/dev/filter_trace.sh
set -euo pipefail

TRACE_FILE="${TRACE_FILE:-outputs/memora/trace/retrieve.ndjson}"
TAIL_N="${TAIL_N:-5000}"
PRINT_N="${PRINT_N:-60}"
OS_URL="${OPENSEARCH_URL:-http://localhost:19200}"

if [[ ! -f "$TRACE_FILE" ]]; then
  echo "Trace file not found: $TRACE_FILE" >&2
  exit 1
fi

echo "== Filtered trace events (last ${PRINT_N} of last ${TAIL_N} lines) =="
tail -n "${TAIL_N}" "${TRACE_FILE}" | jq -c 'select(
  .event=="episodic.index.request" or
  .event=="episodic.index.ok" or
  .event=="index.request" or
  .event=="index.response" or
  .event=="episodic.request" or
  .event=="episodic.response" or
  .event=="retrieve.end"
) | {
  ts,
  event,
  index:(.index // .idx // null),
  id:(.id // null),
  result:(.result // null),
  statusCode:(.statusCode // null),
  total:(.total.value? // .total // null),
  count:(.count // null),
  snippets:(.snippets // null),
  took:(.took // null)
}' | tail -n "${PRINT_N}"

echo
echo "== OpenSearch episodic index counts (UTC date) =="
TODAY="$(date -u +%F)"
INDEX="mem-episodic-${TODAY}"

echo "-- Count in index ${INDEX} (all docs) --"
curl -s "${OS_URL}/${INDEX}/_count" \
  -H 'Content-Type: application/json' \
  -d '{"query":{"match_all":{}}}' | jq -r '.count // "index not found or zero"'

echo "-- Count in index ${INDEX} for tenant=memora, project=benchmarks --"
curl -s "${OS_URL}/${INDEX}/_count" \
  -H 'Content-Type: application/json' \
  -d '{"query":{"bool":{"must":[{"term":{"tenant_id":"memora"}},{"term":{"project_id":"benchmarks"}}]}}}' | jq -r '.count // "index not found or zero"'

echo "-- Sample latest episodic doc (truncated) --"
curl -s "${OS_URL}/mem-episodic-*/_search" \
  -H 'Content-Type: application/json' \
  -d '{"size":1,"sort":[{"ts":{"order":"desc"}}]}' \
  | jq -r '.hits.hits[0]._source | {tenant_id,project_id,context_id,task_id,ts,content: (.content[0:120])}'
