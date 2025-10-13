#!/usr/bin/env bash
# Purpose:
#   Safely clean outputs from old runs while preserving current traces and benchmark reports by default.
#   Defaults to dry-run. Pass --apply to actually delete files.
#
# Usage:
#   bash scripts/dev/cleanup_outputs.sh [--apply] [--days N] [--include-bench-reports]
#
# Defaults:
#   --days 7                      # Only delete files older than N days
#   --apply                       # Actually delete (otherwise dry-run)
#   --include-bench-reports       # Also prune benchmarks/reports older than N days (safe default is OFF)
#
# What this script cleans by default (dry-run unless --apply):
#   - outputs/memora/**/*.ndjson, *.jsonl, *.csv, *.log older than N days
#     (excludes outputs/memora/trace/retrieve.ndjson)
#   - outputs/memora/trace/retrieve.prev.*.ndjson regardless of age (rotated copies)
#   - outputs/mab_cache/**/* older than N days
#
# Optional (if --include-bench-reports):
#   - benchmarks/reports/**/* older than N days
#
# Notes:
# - Preserves the canonical trace file outputs/memora/trace/retrieve.ndjson.
# - Provides a dry-run summary by default. Review before using --apply.
# - Designed to be idempotent and safe in local dev.

set -euo pipefail

# cd to repo root
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")"/../.. && pwd)"
cd "$ROOT_DIR"

DAYS="${DAYS:-7}"
APPLY=0
INCLUDE_BENCH_REPORTS=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --apply)
      APPLY=1
      shift
      ;;
    --days)
      if [[ $# -lt 2 ]]; then
        echo "error: --days requires a value" >&2
        exit 1
      fi
      DAYS="$2"
      shift 2
      ;;
    --include-bench-reports)
      INCLUDE_BENCH_REPORTS=1
      shift
      ;;
    -h|--help)
      grep '^# ' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 1
      ;;
  esac
done

if ! [[ "$DAYS" =~ ^[0-9]+$ ]]; then
  echo "error: DAYS must be an integer (got: $DAYS)" >&2
  exit 1
fi

echo "[cleanup] root: $ROOT_DIR"
echo "[cleanup] days: $DAYS"
echo "[cleanup] mode: $([[ $APPLY -eq 1 ]] && echo APPLY || echo DRY-RUN)"
echo "[cleanup] include benchmarks/reports: $([[ $INCLUDE_BENCH_REPORTS -eq 1 ]] && echo yes || echo no)"
echo

# Build candidate lists
CANDIDATES_FILE="$(mktemp -t cleanup_candidates.XXXXXX)"
trap 'rm -f "$CANDIDATES_FILE"' EXIT

append_candidates() {
  local dir="$1"
  local days_expr="$2"
  local extra_find_args=("${@:3}")

  if [[ -d "$dir" ]]; then
    # shellcheck disable=SC2016
    find "$dir" \
      -type f ${days_expr} \
      "${extra_find_args[@]}" \
      -print >> "$CANDIDATES_FILE" || true
  fi
}

# 1) outputs/memora (older than N days), common output file types; exclude current trace file
if [[ -d "outputs/memora" ]]; then
  append_candidates "outputs/memora" "-mtime +$DAYS" \
    \( -name '*.ndjson' -o -name '*.jsonl' -o -name '*.csv' -o -name '*.log' \) \
    -a -not -path "outputs/memora/trace/retrieve.ndjson"
fi

# 1a) Always include rotated trace backups regardless of age
if [[ -d "outputs/memora/trace" ]]; then
  append_candidates "outputs/memora/trace" "" -name 'retrieve.prev.*.ndjson'
fi

# 2) outputs/mab_cache (any file older than N days)
if [[ -d "outputs/mab_cache" ]]; then
  append_candidates "outputs/mab_cache" "-mtime +$DAYS"
fi

# 3) Optional: benchmarks/reports (older than N days)
if [[ $INCLUDE_BENCH_REPORTS -eq 1 ]] && [[ -d "benchmarks/reports" ]]; then
  append_candidates "benchmarks/reports" "-mtime +$DAYS"
fi

TOTAL_CANDIDATES="$(wc -l < "$CANDIDATES_FILE" | tr -d '[:space:]')"
echo "[cleanup] candidates: ${TOTAL_CANDIDATES}"
if [[ "$TOTAL_CANDIDATES" -gt 0 ]]; then
  echo "[cleanup] sample (up to 20):"
  head -n 20 "$CANDIDATES_FILE"
  echo
else
  echo "[cleanup] nothing to clean under configured rules."
fi

if [[ $APPLY -eq 1 ]] && [[ "$TOTAL_CANDIDATES" -gt 0 ]]; then
  echo "[cleanup] deleting ${TOTAL_CANDIDATES} files..."
  # Use xargs -0 for safety if needed; paths are simple so regular xargs is fine here
  # To avoid arg list too long, delete in batches
  BATCH=0
  while IFS= read -r f; do
    if [[ -f "$f" ]]; then
      rm -f "$f" || true
      ((BATCH++))
      if (( BATCH % 200 == 0 )); then
        echo "  ... deleted $BATCH so far"
      fi
    fi
  done < "$CANDIDATES_FILE"
  echo "[cleanup] done."
else
  echo "[cleanup] dry-run complete. Re-run with --apply to delete the above files."
fi

# Summary of preserved items
if [[ -f "outputs/memora/trace/retrieve.ndjson" ]]; then
  echo "[cleanup] preserved trace: outputs/memora/trace/retrieve.ndjson"
fi
