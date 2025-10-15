#!/usr/bin/env bash
set -euo pipefail

echo "==> Starting OpenSearch via docker compose (detached)..."
( cd docker && docker compose up -d )

echo "==> Building TypeScript dist..."
npm run build

echo "==> Running smoke:write with bootstrap to create today's episodic index and write a DIAG event..."
MEMORA_BOOTSTRAP_OS=1 MEMORA_BOOTSTRAP_CREATE_TODAY=true npm run smoke:write

TRACE_FILE="outputs/memora/trace/retrieve.ndjson"
echo "==> Tail episodic index traces (request/response/ok) from: ${TRACE_FILE}"
if [[ -f "${TRACE_FILE}" ]]; then
  # Show the most recent episodic index traces
  tail -n 300 "${TRACE_FILE}" | grep -E 'episodic\.index\.(request|response|ok)' || true
else
  echo "Trace file not found: ${TRACE_FILE}"
fi

echo "==> Running smoke:retrieve to verify retrieval markers and non-zero snippets..."
npm run smoke:retrieve

echo "==> Tail retrieve and episodic search markers (begin/guard/post_context/finally/end + episodic request/response/fallback/body_once)"
if [[ -f "${TRACE_FILE}" ]]; then
  tail -n 400 "${TRACE_FILE}" | grep -E 'retrieve\.(begin|post_context|guard|finally|end)|episodic\.(request|response|fallback|body_once)' || true
else
  echo "Trace file not found: ${TRACE_FILE}"
fi

echo "==> Done."
