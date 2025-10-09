#!/usr/bin/env bash
set -euo pipefail

# Register or update the OpenSearch search pipeline for RRF using the JSON file in config/opensearch/pipelines/memora_rrf.json
# Usage:
#   ./scripts/dev/register_rrf_pipeline.sh [PIPELINE_NAME]
# Env:
#   OPENSEARCH_URL (default: http://localhost:19200)
#   OPENSEARCH_USERNAME / OPENSEARCH_PASSWORD (optional basic auth)
#   OPENSEARCH_SSL_REJECT_UNAUTHORIZED=false to skip TLS verify (if using https with self-signed)
#
# Example:
#   OPENSEARCH_URL=http://localhost:19200 ./scripts/dev/register_rrf_pipeline.sh memora_rrf

PIPELINE_NAME="${1:-memora_rrf}"
OS_URL="${OPENSEARCH_URL:-http://localhost:19200}"
JSON_PATH="config/opensearch/pipelines/memora_rrf.json"

if [[ ! -f "$JSON_PATH" ]]; then
  echo "ERROR: $JSON_PATH not found. Run from repo root and ensure the file exists." >&2
  exit 1
fi

CURL_OPTS=()
if [[ -n "${OPENSEARCH_USERNAME:-}" && -n "${OPENSEARCH_PASSWORD:-}" ]]; then
  CURL_OPTS+=(-u "${OPENSEARCH_USERNAME}:${OPENSEARCH_PASSWORD}")
fi
if [[ "${OPENSEARCH_SSL_REJECT_UNAUTHORIZED:-true}" == "false" ]]; then
  CURL_OPTS+=(-k)
fi

echo "Registering search pipeline '${PIPELINE_NAME}' at ${OS_URL} using ${JSON_PATH} ..."
curl -sS "${CURL_OPTS[@]}" -H 'Content-Type: application/json' \
  -X PUT "${OS_URL%/}/_search/pipeline/${PIPELINE_NAME}" \
  --data-binary @"${JSON_PATH}"

echo
echo "Done."
