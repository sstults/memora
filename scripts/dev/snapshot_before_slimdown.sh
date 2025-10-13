#!/usr/bin/env bash
# Snapshot current repo state with a signed tag, create archival branch, and start minimal POC branch.
# Safe, idempotent operations with checks to avoid duplication.
set -euo pipefail

TAG="v-before-slimdown"
ARCHIVE_BRANCH="archive/full-featured"
MIN_BRANCH="refactor/minimal-poc"

echo "Verifying clean working tree..."
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "ERROR: Working tree not clean. Commit or stash changes before running this script." >&2
  exit 1
fi

CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
CURRENT_SHA="$(git rev-parse --short HEAD)"
echo "Current branch: ${CURRENT_BRANCH} @ ${CURRENT_SHA}"

echo "Creating signed snapshot tag: ${TAG} (if missing)..."
if git rev-parse "${TAG}" >/dev/null 2>&1; then
  echo "Tag ${TAG} already exists. Skipping tag creation."
else
  git tag -s -m "snapshot: pre-slimdown full-featured state" "${TAG}"
  echo "Tag ${TAG} created."
fi

echo "Pushing tag ${TAG} to origin..."
git push --no-verify origin "${TAG}"

echo "Creating archival branch ${ARCHIVE_BRANCH} at HEAD (if missing)..."
if git show-ref --verify --quiet "refs/heads/${ARCHIVE_BRANCH}"; then
  echo "Local branch ${ARCHIVE_BRANCH} already exists."
else
  git branch "${ARCHIVE_BRANCH}"
  echo "Local branch ${ARCHIVE_BRANCH} created."
fi

echo "Pushing archival branch ${ARCHIVE_BRANCH} to origin..."
git push --no-verify -u origin "${ARCHIVE_BRANCH}"

echo "Creating working branch ${MIN_BRANCH} from HEAD (if missing) and switching to it..."
if git show-ref --verify --quiet "refs/heads/${MIN_BRANCH}"; then
  echo "Local branch ${MIN_BRANCH} already exists."
  git checkout "${MIN_BRANCH}"
else
  git checkout -b "${MIN_BRANCH}"
fi

NEW_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
echo "Now on branch: ${NEW_BRANCH}"
echo "Snapshot complete. Ready to begin minimal POC edits."
