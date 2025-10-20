#!/usr/bin/env bash
# Create and push feature branches per docs/branch-governance.md
# - Base each branch from up-to-date main (Minimal POC invariants preserved on main)
# - Make a signed, GPG-signed empty commit on each branch to initialize it
# - Push with upstream tracking
# Requirements:
#   - git configured with signing (-S) and signoff (-s)
#   - clean working tree (no unstaged or staged changes)
set -euo pipefail

branches=(
  "feature/re-enable-semantic"
  "feature/facts-and-pack"
  "feature/promotion"
  "feature/rerank-osml"
)

echo "[info] Verifying clean working tree..."
if ! git diff --quiet; then
  echo "[error] Working tree has unstaged changes. Please commit or stash before running."
  exit 1
fi
if ! git diff --cached --quiet; then
  echo "[error] Staged but uncommitted changes found. Please commit or stash before running."
  exit 1
fi

echo "[info] Syncing main from origin..."
git fetch origin
# Prefer git switch if available, fallback to checkout
if git switch -q main 2>/dev/null; then
  :
else
  git checkout -q main
fi
git pull --ff-only origin main

for b in "${branches[@]}"; do
  echo "----------------------------------------"
  echo "[info] Processing branch: ${b}"

  # If local branch exists, skip creation
  if git show-ref --verify --quiet "refs/heads/${b}"; then
    echo "[skip] Local branch exists: ${b}"
  else
    echo "[create] Creating branch from main: ${b}"
    if git switch -c "${b}" 2>/dev/null; then
      :
    else
      git checkout -b "${b}"
    fi
    echo "[commit] Creating signed empty init commit on ${b}"
    git commit --allow-empty -s -S -m "chore(branch): initialize ${b} per governance (Minimal POC defaults unchanged)"
  fi

  echo "[push] Pushing ${b} to origin with upstream tracking (may noop if already pushed)"
  # Push but do not fail script if already up-to-date or rejected due to protections
  set +e
  git push -u origin "${b}"
  push_rc=$?
  set -e

  if [ "${push_rc}" -ne 0 ]; then
    echo "[warn] Push returned non-zero (${push_rc}). Check output above (e.g., branch already exists remotely or permissions)."
  fi

  echo "[info] Returning to main for next branch base..."
  if git switch -q main 2>/dev/null; then
    :
  else
    git checkout -q main
  fi
done

echo "========================================"
echo "[done] Feature branch setup complete."
echo "Created/updated branches:"
printf ' - %s\n' "${branches[@]}"
