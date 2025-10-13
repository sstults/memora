#!/usr/bin/env bash
set -euo pipefail

# Update ef_search on the semantic index without reindexing.
# This increases recall for HNSW queries by widening the search window.
#
# Usage:
#   ./scripts/dev/update_semantic_ef_search.sh [INDEX] [EF_SEARCH]
#
# Defaults:
#   INDEX: ${MEMORA_SEMANTIC_INDEX:-mem-semantic}
#   EF_SEARCH: 200
#
# Env:
#   OPENSEARCH_URL (default: http://localhost:9200)
#   OPENSEARCH_USERNAME / OPENSEARCH_PASSWORD (optional basic auth)
#   OPENSEARCH_SSL_REJECT_UNAUTHORIZED=false to skip TLS verify (if using https with self-signed)

INDEX="${1:-${MEMORA_SEMANTIC_INDEX:-mem-semantic}}"
EF_SEARCH="${2:-200}"
OS_URL="${OPENSEARCH_URL:-http://localhost:9200}"

echo "Setting knn.algo_param.ef_search=${EF_SEARCH} on index '${INDEX}' at ${OS_URL}"

CURL_OPTS=()
if [[ -n "${OPENSEARCH_USERNAME:-}" && -n "${OPENSEARCH_PASSWORD:-}" ]]; then
  CURL_OPTS+=(-u "${OPENSEARCH_USERNAME}:${OPENSEARCH_PASSWORD}")
fi
if [[ "${OPENSEARCH_SSL_REJECT_UNAUTHORIZED:-true}" == "false" ]]; then
  CURL_OPTS+=(-k)
fi

JSON_PAYLOAD=$(cat <<JSON
{
  "knn.algo_param.ef_search": ${EF_SEARCH}
}
JSON
)

curl -sS "${CURL_OPTS[@]}" -H 'Content-Type: application/json' \
  -X PUT "${OS_URL%/}/${INDEX}/_settings" \
  --data-binary "${JSON_PAYLOAD}"

echo
echo "Done."
