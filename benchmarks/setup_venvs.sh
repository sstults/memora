#!/usr/bin/env bash
set -euo pipefail

# Create isolated virtual environments for Python-based benchmarks without touching the git submodule.
# Venvs live under benchmarks/.venvs/* to avoid dirtying submodules.
#
# Usage:
#   bash benchmarks/setup_venvs.sh [longmemeval_env]
#     longmemeval_env: lite (default) | full
#
# After running, activate venvs like:
#   source benchmarks/.venvs/longmemeval/bin/activate
#   source benchmarks/.venvs/mab_helpers/bin/activate
#
# Notes on LongMemEval "full":
# - The upstream README pins a CUDA build of torch; on macOS you likely want CPU wheels:
#     pip install torch torchvision torchaudio
# - This script does NOT install torch automatically for "full" to avoid platform-specific pitfalls.
#   Install torch appropriate for your platform before requirements-full.txt, then run this script with "full",
#   or re-run the LongMemEval section below after installing torch.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" &>/dev/null && pwd)"
VENV_ROOT="${SCRIPT_DIR}/.venvs"
PYTHON_BIN="${PYTHON_BIN:-python3}"
LONGMEMEVAL_ENV="${1:-lite}" # lite | full

mkdir -p "${VENV_ROOT}"

create_or_update_venv() {
  local venv_path="$1"
  local requirements_file="${2:-}"
  local project_name="$3"

  if [[ ! -d "${venv_path}" ]]; then
    echo "Creating venv for ${project_name} at ${venv_path}"
    "${PYTHON_BIN}" -m venv "${venv_path}"
  else
    echo "Using existing venv for ${project_name} at ${venv_path}"
  fi

  # shellcheck disable=SC1091
  source "${venv_path}/bin/activate"

  python -V
  pip install -U pip setuptools wheel

  if [[ -n "${requirements_file}" ]]; then
    echo "Installing requirements for ${project_name} from ${requirements_file}"
    pip install -r "${requirements_file}"
  else
    echo "No requirements file specified for ${project_name}; leaving venv empty."
  fi

  deactivate
}

echo "Detected system python: $(${PYTHON_BIN} -c 'import sys; print(sys.executable)')"

# LongMemEval venv
LONGMEMEVAL_VENV="${VENV_ROOT}/longmemeval"
if [[ "${LONGMEMEVAL_ENV}" == "lite" ]]; then
  REQ_FILE="${SCRIPT_DIR}/LongMemEval/requirements-lite.txt"
  echo "Setting up LongMemEval venv with lite requirements: ${REQ_FILE}"
  create_or_update_venv "${LONGMEMEVAL_VENV}" "${REQ_FILE}" "LongMemEval (lite)"
elif [[ "${LONGMEMEVAL_ENV}" == "full" ]]; then
  REQ_FILE="${SCRIPT_DIR}/LongMemEval/requirements-full.txt"
  echo "Setting up LongMemEval venv with full requirements (excluding torch install): ${REQ_FILE}"
  echo "Reminder: Install torch appropriate for your platform BEFORE running this step if needed."
  echo "  macOS CPU example: pip install torch torchvision torchaudio"
  create_or_update_venv "${LONGMEMEVAL_VENV}" "${REQ_FILE}" "LongMemEval (full)"
else
  echo "Unknown longmemeval_env '${LONGMEMEVAL_ENV}'. Use 'lite' or 'full'." >&2
  exit 1
fi

# mab_helpers venv (no explicit requirements; standard library likely sufficient)
MAB_HELPERS_VENV="${VENV_ROOT}/mab_helpers"
echo "Setting up mab_helpers venv (no requirements)"
create_or_update_venv "${MAB_HELPERS_VENV}" "" "mab_helpers"

cat <<'EONOTE'

Setup complete.

Activate venvs when needed:

  # LongMemEval
  source benchmarks/.venvs/longmemeval/bin/activate
  # then run python from LongMemEval/src/... etc

  # mab_helpers
  source benchmarks/.venvs/mab_helpers/bin/activate
  # then run: python benchmarks/mab_helpers/dump_references.py ...

If your IDE auto-detects Python, set the interpreter to one of:
  ${LONGMEMEVAL_VENV}/bin/python
  ${MAB_HELPERS_VENV}/bin/python

To recreate with LongMemEval full requirements:
  # First, install torch appropriate for your platform into the venv:
  source benchmarks/.venvs/longmemeval/bin/activate
  # macOS CPU example:
  pip install torch torchvision torchaudio
  deactivate
  # Then re-run this script with 'full':
  bash benchmarks/setup_venvs.sh full

EONOTE
