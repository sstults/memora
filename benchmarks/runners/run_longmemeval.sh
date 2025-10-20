#!/usr/bin/env bash
set -euo pipefail

# LongMemEval end-to-end runner (REFACTORED)
#
# This script runs a complete LongMemEval benchmark in three phases:
#   Phase 1: Write - Replay session histories into Memora memory system
#   Phase 2: Retrieve & Answer - Query memory and generate predictions with LLM
#   Phase 3: Score - Evaluate predictions against ground truth
#   Phase 4: Aggregate - Compute telemetry statistics
#
# Usage:
#   ./benchmarks/runners/run_longmemeval.sh [OPTIONS]
#
# Options:
#   --variant A|B|C       Memory system variant (default: C)
#                         A = Sliding-window only (no memory)
#                         B = Vector RAG baseline (no Memora policies)
#                         C = Memora MCP (full memory system)
#   --seed N              Random seed for deterministic runs (default: 42)
#   --dataset PATH        Path to dataset JSON (default: 50q subset)
#   --out PATH            Output predictions file (default: auto-generated)
#   --tag TAG             Tag for evaluation results (default: memora)
#   --write-phase         Enable write phase (default: true for Variant C, false for A/B)
#   --retrieve-phase      Enable retrieve & answer phase (default: true)
#   --score-phase         Enable scoring phase (default: true)
#   --aggregate-phase     Enable aggregation phase (default: true)
#   --validate-writes     Validate document count after write phase (default: true)
#   --check-env           Run pre-flight environment checks (default: true)
#   --dry-run             Print configuration and exit (default: false)
#   --help                Show this help message
#
# Examples:
#   # Full benchmark with all phases (default)
#   ./benchmarks/runners/run_longmemeval.sh --variant C --seed 42
#
#   # Write phase only (for populating memory)
#   ./benchmarks/runners/run_longmemeval.sh --variant C --seed 42 \
#     --write-phase --no-retrieve-phase --no-score-phase --no-aggregate-phase
#
#   # Retrieve phase only (assumes writes already done)
#   ./benchmarks/runners/run_longmemeval.sh --variant C --seed 42 \
#     --no-write-phase --retrieve-phase
#
#   # Dry run to check configuration
#   ./benchmarks/runners/run_longmemeval.sh --variant C --seed 42 --dry-run
#

# Default configuration
VARIANT="C"
SEED="42"
DATASET="benchmarks/LongMemEval/data/longmemeval_oracle_50q.json"
TAG="memora"
OUT=""  # if empty, computed from variant+seed

# Phase toggles (true/false)
WRITE_PHASE="auto"      # auto = true for C, false for A/B
RETRIEVE_PHASE="true"
SCORE_PHASE="true"
AGGREGATE_PHASE="true"

# Validation flags
VALIDATE_WRITES="true"
CHECK_ENV="true"
DRY_RUN="false"

# Color output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

log_error() {
  echo -e "${RED}✗ ERROR${NC}: $1" >&2
}

log_success() {
  echo -e "${GREEN}✓${NC} $1"
}

log_info() {
  echo -e "${BLUE}ℹ${NC} $1"
}

log_warning() {
  echo -e "${YELLOW}⚠${NC} $1"
}

log_phase() {
  echo
  echo -e "${GREEN}=== $1 ===${NC}"
}

show_help() {
  grep '^#' "$0" | grep -v '#!/usr/bin/env' | sed 's/^# //' | sed 's/^#//'
  exit 0
}

# Parse arguments
while [[ $# -gt 0 ]]; do
  case "$1" in
    --variant)
      VARIANT="$2"
      shift 2
      ;;
    --seed)
      SEED="$2"
      shift 2
      ;;
    --out)
      OUT="$2"
      shift 2
      ;;
    --dataset)
      DATASET="$2"
      shift 2
      ;;
    --tag)
      TAG="$2"
      shift 2
      ;;
    --write-phase)
      WRITE_PHASE="true"
      shift
      ;;
    --no-write-phase)
      WRITE_PHASE="false"
      shift
      ;;
    --retrieve-phase)
      RETRIEVE_PHASE="true"
      shift
      ;;
    --no-retrieve-phase)
      RETRIEVE_PHASE="false"
      shift
      ;;
    --score-phase)
      SCORE_PHASE="true"
      shift
      ;;
    --no-score-phase)
      SCORE_PHASE="false"
      shift
      ;;
    --aggregate-phase)
      AGGREGATE_PHASE="true"
      shift
      ;;
    --no-aggregate-phase)
      AGGREGATE_PHASE="false"
      shift
      ;;
    --validate-writes)
      VALIDATE_WRITES="true"
      shift
      ;;
    --no-validate-writes)
      VALIDATE_WRITES="false"
      shift
      ;;
    --check-env)
      CHECK_ENV="true"
      shift
      ;;
    --no-check-env)
      CHECK_ENV="false"
      shift
      ;;
    --dry-run)
      DRY_RUN="true"
      shift
      ;;
    --help|-h)
      show_help
      ;;
    *)
      log_error "Unknown argument: $1"
      echo "Run with --help for usage information"
      exit 1
      ;;
  esac
done

# Resolve auto write phase setting
if [[ "${WRITE_PHASE}" == "auto" ]]; then
  if [[ "${VARIANT}" == "C" ]]; then
    WRITE_PHASE="true"
  else
    WRITE_PHASE="false"
  fi
fi

# Compute output path if not provided
if [[ -z "${OUT}" ]]; then
  OUT="benchmarks/reports/longmemeval.${VARIANT}.${SEED}.jsonl"
fi

# Ensure output directory exists
mkdir -p "$(dirname "$OUT")"

# Logging configuration
LOG_DIR="benchmarks/logs"
mkdir -p "${LOG_DIR}"
LOG_PREFIX="longmemeval.${VARIANT}.${SEED}"
DRIVER_LOG="${LOG_DIR}/${LOG_PREFIX}.driver.log"
SCORE_LOG="${LOG_DIR}/${LOG_PREFIX}.score.log"
AGG_LOG="${LOG_DIR}/${LOG_PREFIX}.aggregate.log"

# Print configuration
log_phase "LongMemEval Benchmark Configuration"
echo "Variant:          ${VARIANT}"
echo "Seed:             ${SEED}"
echo "Dataset:          ${DATASET}"
echo "Output:           ${OUT}"
echo "Tag:              ${TAG}"
echo
echo "Phases enabled:"
echo "  Write:          ${WRITE_PHASE}"
echo "  Retrieve:       ${RETRIEVE_PHASE}"
echo "  Score:          ${SCORE_PHASE}"
echo "  Aggregate:      ${AGGREGATE_PHASE}"
echo
echo "Validation:"
echo "  Validate writes: ${VALIDATE_WRITES}"
echo "  Check env:       ${CHECK_ENV}"
echo
echo "Logs:"
echo "  Driver:         ${DRIVER_LOG}"
echo "  Score:          ${SCORE_LOG}"
echo "  Aggregate:      ${AGG_LOG}"

# Dry run - exit after showing config
if [[ "${DRY_RUN}" == "true" ]]; then
  log_info "Dry run mode - exiting without running benchmark"
  exit 0
fi

# Pre-flight checks
if [[ "${CHECK_ENV}" == "true" ]]; then
  log_phase "Pre-Flight Environment Check"
  if [[ -x "scripts/check_env.sh" ]]; then
    if ./scripts/check_env.sh; then
      log_success "Environment check passed"
    else
      log_error "Environment check failed - fix issues before continuing"
      exit 1
    fi
  else
    log_warning "scripts/check_env.sh not found or not executable - skipping check"
  fi
fi

# Load .env from repo root if present (export variables to subprocesses)
if [[ -f ".env" ]]; then
  log_info "Loading environment from .env"
  set -a
  # shellcheck disable=SC1091
  source ./.env
  set +a
else
  log_warning ".env file not found - using existing environment variables"
fi

# Validate variant
if [[ ! "${VARIANT}" =~ ^[ABC]$ ]]; then
  log_error "Invalid variant: ${VARIANT}. Must be A, B, or C"
  exit 1
fi

# Validate dataset exists
if [[ ! -f "${DATASET}" ]]; then
  log_error "Dataset file not found: ${DATASET}"
  log_info "Initialize git submodule: git submodule update --init --recursive"
  exit 1
fi

# Ensure ts-node registration is available for TS runners in this repo
NODE_RUNNER="node --import ./scripts/register-ts-node.mjs"

# Configure Memora for accurate retrieval when running Variant C:
# - Use OpenSearch ML ingest pipeline for embeddings (replaces local fallback)
# - Attach ingest pipeline as index default (ensures embeddings computed on write)
# - Enable reranker (falls back to lexical if remote rerank is not configured)
# - Align embedding dimension with index mapping (384)
# - Point client to local OpenSearch started via docker-compose
if [[ "${VARIANT}" == "C" ]]; then
  log_info "Configuring Memora for Variant C (full memory system)"
  export MEMORA_BOOTSTRAP_OS=1
  export MEMORA_EMBED_PROVIDER=opensearch_pipeline
  export MEMORA_OS_DEFAULT_PIPELINE_ATTACH=true
  export MEMORA_OS_AUTO_REGISTER_MODEL="${MEMORA_OS_AUTO_REGISTER_MODEL:-true}"
  export MEMORA_RERANK_ENABLED="${MEMORA_RERANK_ENABLED:-true}"
  export MEMORA_SEMANTIC_INDEX="${MEMORA_SEMANTIC_INDEX:-mem-semantic}"
  export MEMORA_EMBED_DIM="${MEMORA_EMBED_DIM:-384}"
  export OPENSEARCH_URL="${OPENSEARCH_URL:-http://localhost:9200}"
fi

# Build the project to ensure dist/ exists for compiled MCP server used by the driver
log_phase "Build Project"
if npm run build > "${LOG_DIR}/${LOG_PREFIX}.build.log" 2>&1; then
  log_success "Project built successfully"
else
  log_error "Build failed - check ${LOG_DIR}/${LOG_PREFIX}.build.log"
  exit 1
fi

# Function to get OpenSearch document count for a specific index pattern
get_os_doc_count() {
  local index_pattern="$1"
  local url="${OPENSEARCH_URL:-http://localhost:9200}"

  if ! command -v curl &> /dev/null; then
    echo "0"
    return
  fi

  # Query OpenSearch for doc count
  local count=$(curl -s "${url}/${index_pattern}/_count" 2>/dev/null | grep -o '"count":[0-9]*' | cut -d':' -f2 || echo "0")
  echo "${count}"
}

# Phase 1: Write session histories to memory
if [[ "${WRITE_PHASE}" == "true" ]]; then
  log_phase "Phase 1: Write Sessions to Memory"

  # Get initial document count
  INITIAL_DOC_COUNT=0
  if [[ "${VALIDATE_WRITES}" == "true" ]]; then
    log_info "Getting initial document count from OpenSearch..."
    INITIAL_DOC_COUNT=$(get_os_doc_count "mem-episodic-*")
    log_info "Initial document count: ${INITIAL_DOC_COUNT}"
  fi

  log_info "Replaying session histories into memory system"
  log_info "Log output: ${DRIVER_LOG}"

  if $NODE_RUNNER benchmarks/runners/longmemeval_driver.ts \
    --dataset "${DATASET}" \
    --out "${OUT}" \
    --variant "${VARIANT}" \
    --seed "${SEED}" \
    --replayMode write > "${DRIVER_LOG}" 2>&1; then
    log_success "Write phase completed"

    # Validate writes if requested
    if [[ "${VALIDATE_WRITES}" == "true" ]]; then
      log_info "Validating writes..."
      sleep 2  # Give OpenSearch a moment to index

      FINAL_DOC_COUNT=$(get_os_doc_count "mem-episodic-*")
      DOCS_WRITTEN=$((FINAL_DOC_COUNT - INITIAL_DOC_COUNT))

      log_info "Final document count: ${FINAL_DOC_COUNT}"
      log_info "Documents written: ${DOCS_WRITTEN}"

      if [[ ${DOCS_WRITTEN} -eq 0 ]]; then
        log_error "Write phase completed but no documents were indexed!"
        log_info "Check ${DRIVER_LOG} for errors"
        log_info "Common issues:"
        log_info "  - OpenSearch circuit breaker (heap too small)"
        log_info "  - Index creation failed"
        log_info "  - MCP connection issues"
        exit 1
      else
        log_success "Write validation passed: ${DOCS_WRITTEN} documents indexed"
      fi
    fi
  else
    log_error "Write phase failed - check ${DRIVER_LOG}"
    tail -n 20 "${DRIVER_LOG}"
    exit 1
  fi
fi

# Phase 2: Retrieve from memory and answer questions
if [[ "${RETRIEVE_PHASE}" == "true" ]]; then
  log_phase "Phase 2: Retrieve & Answer Questions"

  # Check if OPENAI_API_KEY is set
  if [[ -z "${OPENAI_API_KEY:-}" ]]; then
    log_error "OPENAI_API_KEY not set - cannot run retrieve phase"
    log_info "Set in .env: OPENAI_API_KEY=sk-proj-..."
    exit 1
  fi

  log_info "Querying memory system and generating predictions"
  log_info "Log output: ${DRIVER_LOG}"

  if $NODE_RUNNER benchmarks/runners/longmemeval_driver.ts \
    --dataset "${DATASET}" \
    --out "${OUT}" \
    --variant "${VARIANT}" \
    --seed "${SEED}" \
    --replayMode salient >> "${DRIVER_LOG}" 2>&1; then
    log_success "Retrieve & answer phase completed"

    # Check if predictions were written
    if [[ -f "${OUT}" ]]; then
      PREDICTION_COUNT=$(grep -c '"question_id"' "${OUT}" || echo "0")
      log_info "Generated ${PREDICTION_COUNT} predictions"

      if [[ ${PREDICTION_COUNT} -eq 0 ]]; then
        log_warning "No predictions generated - check ${DRIVER_LOG}"
      fi
    else
      log_error "Output file not created: ${OUT}"
      exit 1
    fi
  else
    log_error "Retrieve phase failed - check ${DRIVER_LOG}"
    tail -n 20 "${DRIVER_LOG}"
    exit 1
  fi
fi

# Phase 3: Score predictions against ground truth
if [[ "${SCORE_PHASE}" == "true" ]]; then
  log_phase "Phase 3: Score Predictions"

  if [[ ! -f "${OUT}" ]]; then
    log_error "Cannot score - predictions file not found: ${OUT}"
    log_info "Run write and retrieve phases first"
    exit 1
  fi

  log_info "Evaluating predictions with LongMemEval scorer"
  log_info "Log output: ${SCORE_LOG}"

  if $NODE_RUNNER benchmarks/runners/score_longmemeval.ts \
    --hyp "${OUT}" \
    --dataset "${DATASET}" \
    --tag "${TAG}" > "${SCORE_LOG}" 2>&1; then
    log_success "Scoring completed"

    # Look for eval results file
    EVAL_RESULTS="${OUT%.jsonl}.filtered.jsonl.eval-results-gpt-4o"
    if [[ -f "${EVAL_RESULTS}" ]]; then
      # Extract accuracy from results if possible
      if command -v jq &> /dev/null && [[ -f "${EVAL_RESULTS}" ]]; then
        ACCURACY=$(jq -r '.summary.exact_match // .accuracy // empty' "${EVAL_RESULTS}" 2>/dev/null || echo "")
        if [[ -n "${ACCURACY}" ]]; then
          log_info "Accuracy: ${ACCURACY}"
        fi
      fi
    else
      log_warning "Eval results file not found: ${EVAL_RESULTS}"
    fi
  else
    log_error "Scoring failed - check ${SCORE_LOG}"
    tail -n 20 "${SCORE_LOG}"
    exit 1
  fi
fi

# Phase 4: Aggregate telemetry metrics
if [[ "${AGGREGATE_PHASE}" == "true" ]]; then
  log_phase "Phase 4: Aggregate Metrics"

  if [[ ! -f "${OUT}" ]]; then
    log_error "Cannot aggregate - predictions file not found: ${OUT}"
    exit 1
  fi

  log_info "Computing telemetry statistics"
  log_info "Log output: ${AGG_LOG}"

  if $NODE_RUNNER benchmarks/runners/aggregate_longmemeval.ts \
    --in "${OUT}" > "${AGG_LOG}" 2>&1; then
    log_success "Aggregation completed"

    # Check for output files
    STATS_CSV="${OUT%.jsonl}.stats.csv"
    STATS_MD="${OUT%.jsonl}.stats.md"
    if [[ -f "${STATS_CSV}" ]]; then
      log_info "Statistics CSV: ${STATS_CSV}"
    fi
    if [[ -f "${STATS_MD}" ]]; then
      log_info "Statistics Markdown: ${STATS_MD}"
    fi
  else
    log_warning "Aggregation failed - check ${AGG_LOG}"
    log_info "This is non-fatal - predictions are still valid"
  fi
fi

# Final summary
log_phase "Benchmark Complete"
log_success "All phases completed successfully"
echo
echo "Output files:"
echo "  Predictions:    ${OUT}"
if [[ -f "${OUT%.jsonl}.filtered.jsonl" ]]; then
  echo "  Filtered:       ${OUT%.jsonl}.filtered.jsonl"
fi
if [[ -f "${OUT%.jsonl}.filtered.jsonl.eval-results-gpt-4o" ]]; then
  echo "  Eval results:   ${OUT%.jsonl}.filtered.jsonl.eval-results-gpt-4o"
fi
if [[ -f "${OUT%.jsonl}.stats.csv" ]]; then
  echo "  Stats (CSV):    ${OUT%.jsonl}.stats.csv"
fi
if [[ -f "${OUT%.jsonl}.stats.md" ]]; then
  echo "  Stats (MD):     ${OUT%.jsonl}.stats.md"
fi
echo
echo "Logs:"
echo "  Driver:         ${DRIVER_LOG}"
echo "  Score:          ${SCORE_LOG}"
echo "  Aggregate:      ${AGG_LOG}"
