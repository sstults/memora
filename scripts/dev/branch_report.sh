#!/usr/bin/env bash
set -euo pipefail

# Report commits and file changes for feature branches compared to main.
# Usage: bash scripts/dev/branch_report.sh [branch1 branch2 ...]
# If no args provided, defaults to the known feature branches.

branches=("$@")
if [[ ${#branches[@]} -eq 0 ]]; then
  branches=(feature/re-enable-semantic feature/facts-and-pack feature/promotion)
fi

echo "Fetching remote refs..."
git fetch --all --prune

for b in "${branches[@]}"; do
  echo
  echo "==== BRANCH: ${b} vs main (recent commits) ===="
  git log --oneline --decorate --graph --no-merges main.."${b}" | head -n 30 || true
  echo
  echo "--- Files changed main...${b} ---"
  git diff --name-status main..."${b}" | sed -n '1,200p' || true
  echo
  echo "--- memory.ts diffstat main...${b} ---"
  git diff --stat main..."${b}" -- src/routes/memory.ts || true
  echo
done
