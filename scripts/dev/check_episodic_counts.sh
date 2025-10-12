#!/usr/bin/env bash
# Small helper to compare today's episodic index counts across OpenSearch ports.
# Usage:
#   TENANT=memora PROJECT=benchmarks PORTS="19200 9200" HOST=localhost DATE_UTC=2025-10-12 bash scripts/dev/check_episodic_counts.sh
# Defaults:
#   TENANT=memora, PROJECT=benchmarks, PORTS="19200 9200", HOST=localhost, DATE_UTC=$(date -u +%F)
set -euo pipefail

TENANT="${TENANT:-memora}"
PROJECT="${PROJECT:-benchmarks}"
PORTS="${PORTS:-19200 9200}"
HOST="${HOST:-localhost}"
DATE_UTC="${DATE_UTC:-$(date -u +%F)}"
INDEX_PREFIX="${INDEX_PREFIX:-mem-episodic-}"
CONNECT_TIMEOUT="${CONNECT_TIMEOUT:-2}"
MAX_TIME="${MAX_TIME:-4}"

# Use curl options with sensible timeouts so we don't hang on closed ports
CURL_OPTS=(--silent --show-error --connect-timeout "${CONNECT_TIMEOUT}" --max-time "${MAX_TIME}")

INDEX="${INDEX_PREFIX}${DATE_UTC}"
echo "[check_episodic_counts] UTC date: ${DATE_UTC}, index: ${INDEX}"
echo "[check_episodic_counts] Host: ${HOST}, Ports: ${PORTS}"
echo "[check_episodic_counts] Tenant/Project: ${TENANT}/${PROJECT}"

count_all() {
  local base="$1"
  local url="${base}/${INDEX}/_count"
  local data='{"query":{"match_all":{}}}'
  local resp
  if ! resp="$(curl "${CURL_OPTS[@]}" -H 'Content-Type: application/json' -d "${data}" "${url}" 2>/dev/null)"; then
    echo "unreachable"
    return
  fi
  echo "${resp}" | jq -r '.count // "index missing"'
}

count_tenant_project() {
  local base="$1"
  local url="${base}/${INDEX}/_count"
  local data
  data=$(cat <<JSON
{"query":{"bool":{"must":[{"term":{"tenant_id":"${TENANT}"}},{"term":{"project_id":"${PROJECT}"}}]}}}
JSON
)
  local resp
  if ! resp="$(curl "${CURL_OPTS[@]}" -H 'Content-Type: application/json' -d "${data}" "${url}" 2>/dev/null)"; then
    echo "unreachable"
    return
  fi
  echo "${resp}" | jq -r '.count // "index missing"'
}

latest_sample() {
  local base="$1"
  local url="${base}/${INDEX_PREFIX}*/_search"
  local data='{"size":1,"sort":[{"ts":{"order":"desc"}}]}'
  local resp
  if ! resp="$(curl "${CURL_OPTS[@]}" -H 'Content-Type: application/json' -d "${data}" "${url}" 2>/dev/null)"; then
    echo "unreachable"
    return
  fi
  echo "${resp}" | jq -r '.hits.hits[0]._source | {tenant_id,project_id,context_id,task_id,ts,content: (.content[0:120])}'
}

for P in ${PORTS}; do
  BASE="http://${HOST}:${P}"
  echo
  echo "-- ${BASE}/${INDEX} --"
  echo "all: $(count_all "${BASE}")"
  echo "tenant=${TENANT} project=${PROJECT}: $(count_tenant_project "${BASE}")"
  echo "latest sample:"
  latest_sample "${BASE}"
done
