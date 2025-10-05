#!/usr/bin/env bash
set -euo pipefail

# OpenSearch base URL (default local dev port)
OS="${OS:-http://localhost:9200}"

# Semantic index naming and aliasing
SEMANTIC_INDEX="${MEMORA_SEMANTIC_INDEX:-mem-semantic-384}"
ALIAS_NAME="${MEMORA_SEMANTIC_ALIAS:-mem-semantic}"

# 1) Apply episodic index template
curl -s -XPUT "$OS/_index_template/mem-episodic" \
  -H 'Content-Type: application/json' \
  --data-binary @config/index-templates/mem-episodic.json

# 2) Create semantic index (384-dim, lucene+cosinesimil) from template body
curl -s -XPUT "$OS/$SEMANTIC_INDEX" \
  -H 'Content-Type: application/json' \
  --data-binary @config/index-templates/mem-semantic.json

# 3) Create facts index
curl -s -XPUT "$OS/mem-facts" \
  -H 'Content-Type: application/json' \
  --data-binary @config/index-templates/mem-facts.json

# 4) Attach alias for client stability (mem-semantic -> mem-semantic-384)
# If an index exists with the alias name, skip to avoid conflict
if [[ "$(curl -s -o /dev/null -w "%{http_code}" "$OS/$ALIAS_NAME")" == "200" ]]; then
  echo "Indices ready. Skipped alias '${ALIAS_NAME}' because an index with the same name exists." >&2
else
  curl -s -XPOST "$OS/_aliases" \
    -H 'Content-Type: application/json' \
    -d "{\"actions\":[{\"remove\":{\"index\":\"*\",\"alias\":\"$ALIAS_NAME\"}},{\"add\":{\"index\":\"$SEMANTIC_INDEX\",\"alias\":\"$ALIAS_NAME\"}}]}"
  echo "Indices ready. Alias ${ALIAS_NAME} -> ${SEMANTIC_INDEX}"
fi
