#!/usr/bin/env bash
# Test episodic retrieval directly against OpenSearch with temporal-friendly query
# Usage:
#   OPENSEARCH_URL=http://localhost:19200 bash scripts/dev/test_episodic_query.sh
set -euo pipefail

OS="${OPENSEARCH_URL:-http://localhost:19200}"
IDX="mem-episodic-*"
QFILE="$(mktemp /tmp/episodic_query.XXXXXX.json)"

cat > "$QFILE" <<'JSON'
{
  "size": 5,
  "query": {
    "bool": {
      "filter": [
        {"term": {"tenant_id": "memora"}},
        {"term": {"project_id": "benchmarks"}},
        {"term": {"context_id": "longmemeval-42-C-driver"}},
        {"term": {"task_id": "longmemeval-42"}}
      ],
      "should": [
        {
          "multi_match": {
            "query": "How many days did it take for me to find a house I loved after starting to work with Rachel?",
            "type": "best_fields",
            "fields": ["content^3","content.shingles^1.2","tags^2","artifacts^1","content.raw^0.5"],
            "tie_breaker": 0.3
          }
        },
        {
          "simple_query_string": {
            "query": "day OR days OR week OR weeks OR month OR months OR jan* OR feb* OR mar* OR apr* OR may OR jun* OR jul* OR aug* OR sep* OR oct* OR nov* OR dec* OR /",
            "fields": ["content^1","content.raw^0.5"]
          }
        }
      ],
      "minimum_should_match": 1
    }
  }
}
JSON

echo "[test_episodic_query] OS=$OS"
echo "[test_episodic_query] Index pattern: $IDX"
echo "[test_episodic_query] Query file: $QFILE"
echo "----- Query -----"
cat "$QFILE"
echo "-----------------"

echo "[test_episodic_query] Response:"
curl -sS -H "Content-Type: application/json" -X POST "$OS/$IDX/_search" --data-binary @"$QFILE" | jq -r '
  .hits.total,
  (.hits.hits[] | {index:._index,id:._id,score:._score,tags:._source.tags,content:._source.content})'

rm -f "$QFILE"
