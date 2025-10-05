#!/usr/bin/env bash
set -euo pipefail

# scripts/run_integration.sh
# Purpose: Run integration tests with a safe default search pipeline JSON and consistent env setup.
# Usage:
#   bash scripts/run_integration.sh            # run with default settings (no default attachment)
#   bash scripts/run_integration.sh --attach   # also set MEMORA_OS_SEARCH_DEFAULT_PIPELINE_ATTACH=true
#
# Notes:
# - Requires OpenSearch running and indices created (see README: docker compose + scripts/create_indices.sh).
# - You can override any exported env var below before invoking this script.

# Enable integration suite
export INTEGRATION=1

# Provider and index naming
export MEMORA_EMBED_PROVIDER="${MEMORA_EMBED_PROVIDER:-opensearch_pipeline}"
export MEMORA_SEMANTIC_INDEX="${MEMORA_SEMANTIC_INDEX:-mem-semantic}"

# Search pipeline env
export MEMORA_OS_SEARCH_PIPELINE_NAME="${MEMORA_OS_SEARCH_PIPELINE_NAME:-mem-search}"
export MEMORA_OS_SEARCH_DEFAULT_PIPELINE_ATTACH="${MEMORA_OS_SEARCH_DEFAULT_PIPELINE_ATTACH:-false}"

# Provide a minimal valid search pipeline body if not supplied by the user.
# This uses a trivial filter_query request processor for smoke validation.
if [[ -z "${MEMORA_OS_SEARCH_PIPELINE_BODY_JSON:-}" ]]; then
  export MEMORA_OS_SEARCH_PIPELINE_BODY_JSON='{"request_processors":[{"filter_query":{"description":"integration smoke","query":{"match_all":{}}}}],"response_processors":[]}'
fi

# Optional flag to attach pipeline as index.search.default_pipeline
if [[ "${1:-}" == "--attach" ]]; then
  export MEMORA_OS_SEARCH_DEFAULT_PIPELINE_ATTACH=true
fi

# OpenSearch endpoint (defaults to local Docker Compose remap)
export OPENSEARCH_URL="${OPENSEARCH_URL:-http://localhost:19200}"

echo "[memora] Running integration tests with:"
echo "  OPENSEARCH_URL=$OPENSEARCH_URL"
echo "  MEMORA_SEMANTIC_INDEX=$MEMORA_SEMANTIC_INDEX"
echo "  MEMORA_OS_SEARCH_PIPELINE_NAME=$MEMORA_OS_SEARCH_PIPELINE_NAME"
echo "  MEMORA_OS_SEARCH_DEFAULT_PIPELINE_ATTACH=$MEMORA_OS_SEARCH_DEFAULT_PIPELINE_ATTACH"
echo "  MEMORA_OS_SEARCH_PIPELINE_BODY_JSON=$MEMORA_OS_SEARCH_PIPELINE_BODY_JSON"

npm run test:integration
