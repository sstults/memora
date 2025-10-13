#!/usr/bin/env bash
# Register and deploy an OpenSearch ML Commons cross-encoder reranker model, print model_id on stdout.
# Usage:
#   OPENSEARCH_URL=http://localhost:9200 bash scripts/dev/register_reranker_model.sh
# Optional env:
#   OPENSEARCH_USERNAME / OPENSEARCH_PASSWORD  (if security enabled)
#   RERANKER_MODEL_NAME=cross-encoder/ms-marco-MiniLM-L-6-v2
#   RERANKER_MODEL_VERSION=1.0.0
#   RERANKER_MODEL_FORMAT=TORCH_SCRIPT  # TORCH_SCRIPT or ONNX depending on OS model support
set -euo pipefail

OS_URL="${OPENSEARCH_URL:-http://localhost:9200}"
MODEL_NAME="${RERANKER_MODEL_NAME:-cross-encoder/ms-marco-MiniLM-L-6-v2}"
MODEL_VERSION="${RERANKER_MODEL_VERSION:-1.0.0}"
MODEL_FORMAT="${RERANKER_MODEL_FORMAT:-TORCH_SCRIPT}"

CURL_AUTH=()
if [[ -n "${OPENSEARCH_USERNAME:-}" && -n "${OPENSEARCH_PASSWORD:-}" ]]; then
  CURL_AUTH=(-u "${OPENSEARCH_USERNAME}:${OPENSEARCH_PASSWORD}")
fi

jq --version >/dev/null 2>&1 || { echo "jq is required on PATH" >&2; exit 1; }

wait_for_os() {
  local timeout="${1:-120}"
  local start=$(date +%s)
  until curl -sS "${CURL_AUTH[@]}" "${OS_URL}" >/dev/null; do
    sleep 2
    local now=$(date +%s)
    if (( now - start >= timeout )); then
      echo "OpenSearch not reachable at ${OS_URL} after ${timeout}s" >&2
      exit 1
    fi
  done
}

echo "[info] Waiting for OpenSearch at ${OS_URL}..." >&2
wait_for_os 180

echo "[info] Registering reranker model: name='${MODEL_NAME}', version='${MODEL_VERSION}', format='${MODEL_FORMAT}'" >&2
reg_payload=$(jq -n --arg name "$MODEL_NAME" --arg version "$MODEL_VERSION" --arg format "$MODEL_FORMAT" '{name:$name, version:$version, model_format:$format, model_task_type:"RERANKING"}')
reg_resp=$(curl -sS "${CURL_AUTH[@]}" -H 'Content-Type: application/json' -X POST "${OS_URL}/_plugins/_ml/models/_register" -d "$reg_payload" || true)
echo "[register] ${reg_resp}" >&2

model_id=$(echo "$reg_resp" | jq -r '(.model_id // .model?.model_id // .task?.model_id // empty)')
task_id=$(echo "$reg_resp" | jq -r '(.task_id // .task?.task_id // empty)')

if [[ -z "${model_id}" && -n "${task_id}" ]]; then
  echo "[info] Polling registration task_id=${task_id}" >&2
  for i in {1..120}; do
    task_resp=$(curl -sS "${CURL_AUTH[@]}" -X GET "${OS_URL}/_plugins/_ml/tasks/${task_id}" || true)
    state=$(echo "$task_resp" | jq -r '(.state // .task?.state // "UNKNOWN")')
    model_id=$(echo "$task_resp" | jq -r '(.model_id // .task?.model_id // .model?.model_id // empty)')
    echo "[register.poll] state=${state} model_id=${model_id}" >&2
    if [[ "${state}" == "COMPLETED" && -n "${model_id}" ]]; then
      break
    fi
    if [[ "${state}" == "FAILED" ]]; then
      echo "[error] Registration task failed: ${task_resp}" >&2
      exit 2
    fi
    sleep 1
  done
fi

if [[ -z "${model_id}" ]]; then
  echo "[error] Could not resolve model_id from registration response/task" >&2
  exit 3
fi

encoded_model_id=$(printf '%s' "$model_id" | jq -sRr @uri)

echo "[info] Deploying model_id=${model_id}" >&2
dep_resp=$(curl -sS "${CURL_AUTH[@]}" -X POST "${OS_URL}/_plugins/_ml/models/${encoded_model_id}/_deploy" || true)
echo "[deploy] ${dep_resp}" >&2
dep_task=$(echo "$dep_resp" | jq -r '(.task_id // .task?.task_id // empty)')
if [[ -n "${dep_task}" ]]; then
  echo "[info] Polling deploy task_id=${dep_task}" >&2
  for i in {1..180}; do
    t=$(curl -sS "${CURL_AUTH[@]}" -X GET "${OS_URL}/_plugins/_ml/tasks/${dep_task}" || true)
    state=$(echo "$t" | jq -r '(.state // .task?.state // "UNKNOWN")')
    echo "[deploy.poll] state=${state}" >&2
    if [[ "${state}" == "COMPLETED" ]]; then
      break
    fi
    if [[ "${state}" == "FAILED" ]]; then
      echo "[error] Deploy task failed: ${t}" >&2
      exit 4
    fi
    sleep 1
  done
fi

# Output the model id for downstream use
echo "${model_id}"
