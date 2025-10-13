#!/usr/bin/env bash
set -euo pipefail

# Rebuild the semantic index with the updated mapping/settings.
# Strategy:
#   1) Create a new TEMP index with current config/index-templates/mem-semantic.json
#   2) Reindex from the existing semantic index into TEMP
#   3) Optional: delete the old semantic index
#   4) Create a fresh semantic index with the updated body (same name as before)
#   5) Reindex back from TEMP into the new semantic index
#   6) Optional: delete TEMP
#
# This avoids alias complexity and preserves the canonical index name.
#
# Usage:
#   ./scripts/dev/reindex_semantic_v2.sh
#
# Env:
#   OPENSEARCH_URL (default: http://localhost:9200)
#   OPENSEARCH_USERNAME / OPENSEARCH_PASSWORD (optional)
#   OPENSEARCH_SSL_REJECT_UNAUTHORIZED=false to skip TLS verify (https dev)
#   MEMORA_SEMANTIC_INDEX (default: mem-semantic)
#
# Notes:
# - This script pauses for confirmations before destructive steps.
# - Ensure your service is quiesced (no writes) or accept a small window of missed writes.

OS_URL="${OPENSEARCH_URL:-http://localhost:9200}"
SEM_INDEX="${MEMORA_SEMANTIC_INDEX:-mem-semantic}"
JSON_PATH="config/index-templates/mem-semantic.json"
TEMP_INDEX="${SEM_INDEX}-v2-$(date +%Y%m%d%H%M%S)"

if [[ ! -f "$JSON_PATH" ]]; then
  echo "ERROR: $JSON_PATH not found. Run from repo root." >&2
  exit 1
fi

CURL_OPTS=()
if [[ -n "${OPENSEARCH_USERNAME:-}" && -n "${OPENSEARCH_PASSWORD:-}" ]]; then
  CURL_OPTS+=(-u "${OPENSEARCH_USERNAME}:${OPENSEARCH_PASSWORD}")
fi
if [[ "${OPENSEARCH_SSL_REJECT_UNAUTHORIZED:-true}" == "false" ]]; then
  CURL_OPTS+=(-k)
fi

echo "Step 1) Create TEMP index: ${TEMP_INDEX}"
curl -sS "${CURL_OPTS[@]}" -H 'Content-Type: application/json' \
  -X PUT "${OS_URL%/}/${TEMP_INDEX}" \
  --data-binary @"${JSON_PATH}" || {
    echo
    echo "If index exists already, this step may be a no-op."
  }
echo

echo "Step 2) Reindex from ${SEM_INDEX} -> ${TEMP_INDEX}"
REINDEX_PAYLOAD=$(cat <<JSON
{
  "source": { "index": "${SEM_INDEX}" },
  "dest":   { "index": "${TEMP_INDEX}" }
}
JSON
)
curl -sS "${CURL_OPTS[@]}" -H 'Content-Type: application/json' \
  -X POST "${OS_URL%/}/_reindex?wait_for_completion=true" \
  --data-binary "${REINDEX_PAYLOAD}"
echo
echo "Verify TEMP index doc count before continuing."
read -r -p "Continue to swap? This will DELETE '${SEM_INDEX}' and recreate it. Type 'yes' to continue: " CONFIRM
if [[ "$CONFIRM" != "yes" ]]; then
  echo "Aborting before destructive step."
  exit 1
fi

echo "Step 3) DELETE old ${SEM_INDEX}"
curl -sS "${CURL_OPTS[@]}" -X DELETE "${OS_URL%/}/${SEM_INDEX}" || true
echo

echo "Step 4) Create fresh ${SEM_INDEX} with updated body"
curl -sS "${CURL_OPTS[@]}" -H 'Content-Type: application/json' \
  -X PUT "${OS_URL%/}/${SEM_INDEX}" \
  --data-binary @"${JSON_PATH}"
echo

echo "Step 5) Reindex back: ${TEMP_INDEX} -> ${SEM_INDEX}"
REINDEX_BACK=$(cat <<JSON
{
  "source": { "index": "${TEMP_INDEX}" },
  "dest":   { "index": "${SEM_INDEX}" }
}
JSON
)
curl -sS "${CURL_OPTS[@]}" -H 'Content-Type: application/json' \
  -X POST "${OS_URL%/}/_reindex?wait_for_completion=true" \
  --data-binary "${REINDEX_BACK}"
echo

read -r -p "Optionally delete TEMP index '${TEMP_INDEX}' now? Type 'yes' to delete: " CONFIRM2
if [[ "$CONFIRM2" == "yes" ]]; then
  curl -sS "${CURL_OPTS[@]}" -X DELETE "${OS_URL%/}/${TEMP_INDEX}" || true
  echo "TEMP index deleted."
else
  echo "TEMP index kept: ${TEMP_INDEX}"
fi

echo "Done. '${SEM_INDEX}' now uses the updated mapping/settings."
