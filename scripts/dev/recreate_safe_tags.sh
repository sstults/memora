#!/usr/bin/env bash
# Recreate and push only "safe" tags on the rewritten history.
# - v-before-slimdown: tags the commit immediately before the slimdown commit
# - v-minimal-poc: tags the slimdown commit itself (or HEAD if not found)
# Notes:
# - This assumes the repository history has already been rewritten to purge large artifacts.
# - Tags are pushed individually to avoid re-introducing old objects via a blanket --tags push.

set -euo pipefail

echo "=== Locating slimdown commit in rewritten history ==="
SLIMDOWN_COMMIT="$(git log --format=%H --grep='^slimdown: minimal POC gating' -n 1 || true)"
if [ -z "${SLIMDOWN_COMMIT}" ]; then
  echo "WARN: Could not find commit with subject 'slimdown: minimal POC gating'. Using HEAD as slimdown commit."
  SLIMDOWN_COMMIT="$(git rev-parse HEAD)"
fi
echo "Slimdown commit: ${SLIMDOWN_COMMIT}"

# Parent commit to use as the pre-slimdown snapshot
PRE_SLIMDOWN="$(git rev-parse "${SLIMDOWN_COMMIT}^" 2>/dev/null || true)"
if [ -z "${PRE_SLIMDOWN}" ]; then
  echo "WARN: Could not resolve parent of slimdown commit. Falling back to HEAD~1."
  PRE_SLIMDOWN="$(git rev-parse HEAD~1)"
fi
echo "Pre-slimdown commit: ${PRE_SLIMDOWN}"

echo "=== Creating/Updating annotated tags ==="
echo "Tagging v-before-slimdown at ${PRE_SLIMDOWN}"
git tag -a -f -m "snapshot: pre-slimdown (clean history)" v-before-slimdown "${PRE_SLIMDOWN}"

echo "Tagging v-minimal-poc at ${SLIMDOWN_COMMIT}"
git tag -a -f -m "slimdown: minimal episodic-only POC (clean history)" v-minimal-poc "${SLIMDOWN_COMMIT}"

echo "=== Pushing tags individually (to avoid pushing any stale tags) ==="
git push --no-verify -f origin v-before-slimdown
git push --no-verify -f origin v-minimal-poc

echo "Done. Tags pushed:"
git show-ref --tags | grep -E 'v-before-slimdown|v-minimal-poc' || true
