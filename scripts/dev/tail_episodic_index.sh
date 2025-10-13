#!/usr/bin/env bash
# Tail episodic index-related trace events safely from retrieve.ndjson.
# This uses tail and jq per .clinerules guidance (do not read the entire file directly).
#
# Usage examples:
#   bash scripts/dev/tail_episodic_index.sh
#   TRACE_FILE=outputs/memora/trace/retrieve.ndjson TAIL_N=4000 PRINT_N=80 bash scripts/dev/tail_episodic_index.sh
#   FOLLOW=1 TRACE_FILE=outputs/memora/trace/retrieve.ndjson bash scripts/dev/tail_episodic_index.sh
#
# Env vars:
#   TRACE_FILE  - path to retrieve.ndjson (default: outputs/memora/trace/retrieve.ndjson)
#   TAIL_N      - how many lines from end to scan before filtering (default: 5000)
#   PRINT_N     - how many filtered lines to print (default: 60)
#   FOLLOW      - if set to 1, follow new events (streaming); ignores TAIL_N/PRINT_N

set -euo pipefail

TRACE_FILE="${TRACE_FILE:-outputs/memora/trace/retrieve.ndjson}"
TAIL_N="${TAIL_N:-5000}"
PRINT_N="${PRINT_N:-60}"
FOLLOW="${FOLLOW:-0}"

if [[ ! -f "$TRACE_FILE" ]]; then
  echo "Trace file not found: $TRACE_FILE" >&2
  exit 1
fi

jq_filter='select(
  .event=="episodic.index.request" or
  .event=="episodic.index.response" or
  .event=="episodic.index.ok" or
  .event=="episodic.index.fail"
) | {
  ts,
  event,
  index:(.index // .idx // null),
  id:(.id // null),
  result:(.result // null),
  statusCode:(.statusCode // null),
  error:(.error // null)
}'

if [[ "$FOLLOW" == "1" ]]; then
  echo "== Following episodic index events (Ctrl-C to stop) =="
  # Only stream new lines to avoid scanning the entire file repeatedly.
  tail -n 0 -F "$TRACE_FILE" | jq -c "$jq_filter"
else
  echo "== Episodic index events (last ${PRINT_N} of last ${TAIL_N} lines) =="
  tail -n "$TAIL_N" "$TRACE_FILE" | jq -c "$jq_filter" | tail -n "$PRINT_N"
fi
