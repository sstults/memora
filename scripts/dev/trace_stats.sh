#!/usr/bin/env bash
# Safe trace stats helper. Complies with .clinerules: do NOT cat large files; only head/tail/grep/jq.
# Usage:
#   bash scripts/dev/trace_stats.sh
#   SAMPLE=1 bash scripts/dev/trace_stats.sh   # include small head/tail samples

set -euo pipefail

TRACE_DIR="${TRACE_DIR:-outputs/memora/trace}"
RETRIEVE_FILE="${RETRIEVE_FILE:-${TRACE_DIR}/retrieve.ndjson}"
HEARTBEAT_FILE="${HEARTBEAT_FILE:-${TRACE_DIR}/heartbeat.ndjson}"

info() { printf "[trace] %s\n" "$*"; }
section() { printf "\n=== %s ===\n" "$*"; }

ensure_dir() {
  if [[ ! -d "$TRACE_DIR" ]]; then
    info "Trace directory not found: $TRACE_DIR"
    exit 0
  fi
}

file_stats() {
  local file="$1"
  if [[ -f "$file" ]]; then
    local size_h lines bytes
    # Human readable size (du -h), line count (wc -l), raw size in bytes (stat portable fallback)
    size_h="$(du -h "$file" 2>/dev/null | awk '{print $1}')"
    lines="$(wc -l < "$file" 2>/dev/null || echo 0)"
    # macOS/BSD: stat -f%z, Linux: stat -c%s
    if bytes="$(stat -f%z "$file" 2>/dev/null)"; then :; else bytes="$(stat -c%s "$file" 2>/dev/null || echo 0)"; fi
    printf "%-28s size=%8s (%s bytes)  lines=%s\n" "$(basename "$file")" "${size_h:-?}" "${bytes:-?}" "${lines:-0}"

    if [[ "${SAMPLE:-0}" != "0" ]]; then
      # Show very small samples (first/last 2 lines) without dumping whole file
      if [[ "$lines" -gt 0 ]]; then
        echo "  -- head(2) --"
        head -n 2 "$file" || true
        echo "  -- tail(2) --"
        tail -n 2 "$file" || true
      fi
    fi
  else
    printf "%-28s %s\n" "$(basename "$file")" "not found"
  fi
}

main() {
  ensure_dir
  section "Trace directory"
  echo "$TRACE_DIR"
  section "File stats"
  file_stats "$RETRIEVE_FILE"
  file_stats "$HEARTBEAT_FILE"

  section "Recent retrieve markers (tail grep)"
  if [[ -f "$RETRIEVE_FILE" ]]; then
    # Show last 200 lines and grep for key markers to avoid scanning entire file
    tail -n 200 "$RETRIEVE_FILE" | grep -E '"event":"(retrieve\.(begin|end|finally)|episodic\.(request|response|index\.(request|response|ok|fail)))"' || true
  else
    echo "retrieve.ndjson not found"
  fi
}

main "$@"
