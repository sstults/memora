#!/usr/bin/env bash
set -euo pipefail

# Fetch LongMemEval dataset via Hugging Face and run smoke (driver + conditional scoring).
# Requires: benchmarks/LongMemEval submodule, Python venv (created earlier), Node/NPM

ROOT_DIR="$(pwd)"

cd benchmarks/LongMemEval

# Ensure venv exists and activate it
if [[ ! -d ".venv-longmemeval" ]]; then
  python3 -m venv .venv-longmemeval
fi
source ./.venv-longmemeval/bin/activate

# Install minimal extra dependency to fetch from Hugging Face
python -m pip install --upgrade pip >/dev/null
python -m pip install -q huggingface_hub >/dev/null

# Attempt HF download (no auth). If fails, fallback to Google Drive with gdown.
set +e
python - <<'PY'
from huggingface_hub import hf_hub_download
import shutil, os, sys
fn = "longmemeval_oracle.json"
try:
    p = hf_hub_download("xiaowu0162/longmemeval", filename=fn)
    os.makedirs("data", exist_ok=True)
    dst = os.path.join("data", fn)
    shutil.copy2(p, dst)
    print(f"Downloaded: {dst}")
except Exception as e:
    print(f"HF_FETCH_FAILED: {e}", file=sys.stderr)
    sys.exit(2)
PY
HF_STATUS=$?
set -e

if [[ $HF_STATUS -ne 0 ]]; then
  echo "Falling back to Google Drive with gdown..."
  python -m pip install -q gdown >/dev/null
  # File ID from LongMemEval README: 1zJgtYRFhOh5zDQzzatiddfjYhFSnyQ80
  python -m gdown --fuzzy "https://drive.google.com/uc?id=1zJgtYRFhOh5zDQzzatiddfjYhFSnyQ80" -O longmemeval_data.tar.gz
  mkdir -p data
  tar -xzvf longmemeval_data.tar.gz -C data
  if [[ ! -f "data/longmemeval_oracle.json" ]]; then
    echo "ERROR: longmemeval_oracle.json not found after extraction." >&2
    exit 1
  fi
fi

# Return to repo root
cd "${ROOT_DIR}"

# Run driver to produce predictions JSONL
npm run bench:longmem:driver

# Run scoring only if OPENAI_API_KEY is set (the evaluator uses OpenAI by default)
if [[ -n "${OPENAI_API_KEY:-}" ]]; then
  npm run bench:longmem:score
else
  echo "OPENAI_API_KEY not set; skipping scoring step."
  echo "Predictions available at: benchmarks/reports/memora_predictions.jsonl"
  echo "To score later, set OPENAI_API_KEY and run: npm run bench:longmem:score"
fi
