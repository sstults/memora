#!/usr/bin/env bash
# OpenSearch diagnostics for Memora indices and episodic lexical probe
# Usage: OPENSEARCH_URL=http://localhost:9200 scripts/dev/os_diag.sh

set -euo pipefail

OS_URL="${OPENSEARCH_URL:-http://localhost:9200}"

section() {
  echo
  echo "=== $1 ==="
}

json_post() {
  local path="$1"
  local body="$2"
  curl -sS -H 'Content-Type: application/json' -XPOST "${OS_URL}${path}" -d "${body}"
}

json_get() {
  local path="$1"
  curl -sS -H 'Content-Type: application/json' -XGET "${OS_URL}${path}"
}

# 1) Indices
section "Indices matching mem-*"
json_get "/_cat/indices?v" | egrep 'mem-(episodic|semantic|facts)' || true

# 2) Counts
section "Count docs per index"
for idx in mem-episodic-* mem-semantic mem-facts; do
  printf "%s -> " "$idx"
  json_post "/${idx}/_count" '{"query":{"match_all":{}}}' | jq -r '.count? // .error?.reason? // "n/a"' || echo "jq-error"
done

# 3) Sample episodic doc with qid tags (strict AND across tags)
section "Sample episodic docs (tags match: qid:2c63a862 AND seed:42 AND variant:C)"
SEARCH_BODY='{
  "size": 3,
  "sort": [{"ts": {"order": "desc"}}],
  "query": {
    "bool": {
      "must": [
        {"term": {"tags": "qid:2c63a862"}},
        {"term": {"tags": "seed:42"}},
        {"term": {"tags": "variant:C"}}
      ]
    }
  }
}'
json_post "/mem-episodic-*/_search" "${SEARCH_BODY}" \
| jq -c '
  if (.hits? and .hits.hits?) then
    (.hits.hits | map(select(type=="object")) | .[] | {
      id: (._id // ""),
      score: (._score // 0),
      tags: (._source.tags // []),
      ts: (._source.ts // ""),
      content: ((._source.content|tostring)[0:140])
    })
  else
    (if .error? then {"error": .error} else {"error":"no hits field"} end)
  end
' || true

# 4) Raw lexical probe against episodic
section "Raw lexical probe against episodic (multi_match on content)"
PROBE_Q='How many days did it take for me to find a house I loved after starting to work with Rachel?'
PROBE_BODY=$(cat <<JSON
{
  "size": 5,
  "query": {
    "multi_match": {
      "query": "${PROBE_Q}",
      "type": "best_fields",
      "fields": ["content^3", "content.shingles^1.2"],
      "tie_breaker": 0.3,
      "lenient": true
    }
  }
}
JSON
)

# Escape newlines for safe JSON post
PROBE_BODY="${PROBE_BODY//$'\n'/ }"
json_post "/mem-episodic-*/_search" "${PROBE_BODY}" \
| jq -c '
  if (.hits? and .hits.hits?) then
    (.hits.hits | map(select(type=="object")) | .[] | {
      id: (._id // ""),
      score: (._score // 0),
      tags: (._source.tags // []),
      content: ((._source.content|tostring)[0:160])
    })
  else
    (if .error? then {"error": .error} else {"error":"no hits field"} end)
  end
' || true

echo
echo "Done."
