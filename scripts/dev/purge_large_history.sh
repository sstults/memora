#!/usr/bin/env bash
# Purge large/generated artifacts from the entire git history and force-push rewritten refs.
# IMPORTANT: This rewrites history. All collaborators must rebase/reset or re-clone after this.
# Targets removed from history:
#   - outputs/** (generated caches, traces, reports)
#   - benchmarks/reports/** (benchmark reports and eval outputs)

set -euo pipefail

echo "=== PRECHECKS ==="
# Ensure we're inside a git repo
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || { echo "Not a git repository." >&2; exit 1; }

CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
echo "Current branch: ${CURRENT_BRANCH}"

# Create a backup tag on the current state before rewrite
TS="$(date +%Y%m%d-%H%M%S)"
BACKUP_TAG="backup/before-filter-repo-${TS}"
echo "Creating local backup tag: ${BACKUP_TAG}"
git tag -a "${BACKUP_TAG}" -m "Backup before filter-repo purge of outputs/ and benchmarks/reports/"

echo "=== INSTALL git-filter-repo (if needed) ==="
if command -v git-filter-repo >/dev/null 2>&1; then
  echo "git-filter-repo executable present."
elif git --help | grep -q "filter-repo"; then
  echo "git filter-repo available via git extension."
else
  if command -v brew >/dev/null 2>&1; then
    echo "Installing git-filter-repo via Homebrew..."
    brew install git-filter-repo
  else
    echo "Homebrew not found. Attempting Python module install into current environment..."
    python3 -m pip install git-filter-repo
  fi
fi

echo "=== RUNNING FILTER ==="
# Prefer the installed git extension; fall back to python module if needed
FILTER_CMD=""
if command -v git-filter-repo >/dev/null 2>&1; then
  FILTER_CMD="git filter-repo"
elif git --help | grep -q "filter-repo"; then
  FILTER_CMD="git filter-repo"
else
  FILTER_CMD="python3 -m git_filter_repo"
fi

$FILTER_CMD --force \
  --path outputs \
  --path-glob 'outputs/**' \
  --path-glob 'benchmarks/reports/**' \
  --invert-paths

echo "=== GARBAGE COLLECTION ==="
git reflog expire --expire=now --all
git gc --prune=now --aggressive

echo "=== PUSH REWRITTEN BRANCH AND TAGS ==="
# Push the current branch
echo "Force-pushing branch: ${CURRENT_BRANCH}"
git push --force --no-verify origin "${CURRENT_BRANCH}"

# Push tags (this includes rewritten tags like v-before-slimdown and the backup tag)
echo "Skipping tag push to avoid reintroducing large pre-rewrite objects via tags."
echo "Review and push only rewritten tags you intend to keep:"
echo "  # example: git push --force --no-verify origin v-before-slimdown"
# git push --force --no-verify origin --tags

echo "=== DONE ==="
echo "History rewrite complete. Collaborators must rebase/reset or re-clone."
echo "Backup tag preserved locally as: ${BACKUP_TAG}"
