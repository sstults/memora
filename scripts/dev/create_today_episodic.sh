#!/usr/bin/env bash
set -euo pipefail

# Target OpenSearch endpoint (defaults to dev cluster)
OS="${OPENSEARCH_URL:-${OS:-http://localhost:9200}}"
IDX="mem-episodic-$(date -u +%F)"

echo "[create_today_episodic] Target OpenSearch: $OS"

# 1) Apply episodic index template (idempotent)
echo "[create_today_episodic] Applying episodic index template..."
curl -sS -H 'Content-Type: application/json' -X PUT "$OS/_index_template/mem-episodic" \
  --data-binary @config/index-templates/mem-episodic.json >/dev/null || true

# 2) Create today's episodic index from the template body (settings+mappings)
echo "[create_today_episodic] Creating index $IDX from template body..."
jq -c '.template' config/index-templates/mem-episodic.json | \
  curl -sS -H 'Content-Type: application/json' -X PUT "$OS/$IDX" -d @- || true

# 3) Show count to verify creation
echo "[create_today_episodic] Count in $IDX:"
curl -sS "$OS/$IDX/_count"
echo

# 4) Run the single-query analyzer to ingest and retrieve
echo "[create_today_episodic] Running analyzer to ingest and retrieve..."
OPENSEARCH_URL="$OS" MEMORA_EMBED_DIM="${MEMORA_EMBED_DIM:-384}" \
  node --import ./scripts/register-ts-node.mjs scripts/dev/analyze_query_2c63a862.ts
