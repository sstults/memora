#!/usr/bin/env bash
set -euo pipefail

# alias_hygiene.sh
# Purpose: Ensure alias-first pattern for semantic index.
# - If an alias exists, optionally repoint to target index.
# - If a real index exists with the alias name, offer remediation:
#   * --reindex: create target index from template, reindex, delete conflicting index, attach alias
#   * --delete-existing: delete conflicting index and attach alias to target index
#
# Defaults:
#   OS=http://localhost:9200
#   MEMORA_SEMANTIC_ALIAS=mem-semantic
#   MEMORA_SEMANTIC_INDEX=mem-semantic-384
#   TEMPLATE=config/index-templates/mem-semantic.json
#
# Usage:
#   bash scripts/alias_hygiene.sh
#   bash scripts/alias_hygiene.sh --reindex --yes
#   OS=http://localhost:9200 MEMORA_SEMANTIC_INDEX=mem-semantic-384 bash scripts/alias_hygiene.sh --delete-existing --yes
#
# WARNING: --delete-existing and --reindex mutate your cluster (dev-only convenience).
#          Use with care and only in non-production environments.

OS="${OS:-http://localhost:9200}"
ALIAS_NAME="${MEMORA_SEMANTIC_ALIAS:-mem-semantic}"
TARGET_INDEX="${MEMORA_SEMANTIC_INDEX:-mem-semantic-384}"
TEMPLATE_PATH="${TEMPLATE:-config/index-templates/mem-semantic.json}"

DO_REINDEX=false
DO_DELETE=false
YES=false

for arg in "$@"; do
  case "$arg" in
    --reindex) DO_REINDEX=true ;;
    --delete-existing) DO_DELETE=true ;;
    --yes|-y) YES=true ;;
    --help|-h)
      echo "Usage: $0 [--reindex|--delete-existing] [--yes] [--help]"
      exit 0
      ;;
    *)
      echo "Unknown argument: $arg" >&2
      exit 2
      ;;
  esac
done

http_code() {
  local method="$1"
  local url="$2"
  curl -s -o /dev/null -w "%{http_code}" -X"$method" "$url"
}

exists_alias() {
  # 200 when alias exists; 404 when not
  [[ "$(http_code GET "${OS}/_alias/${ALIAS_NAME}")" == "200" ]]
}

exists_index() {
  # 200 when index exists; 404 when not
  [[ "$(http_code GET "${OS}/${1}")" == "200" ]]
}

ensure_target_index() {
  if exists_index "$TARGET_INDEX"; then
    echo "[alias-hygiene] Target index '${TARGET_INDEX}' already exists."
  else
    echo "[alias-hygiene] Creating target index '${TARGET_INDEX}' from template '${TEMPLATE_PATH}'..."
    curl -fsSL -XPUT "${OS}/${TARGET_INDEX}" \
      -H 'Content-Type: application/json' \
      --data-binary @"${TEMPLATE_PATH}" >/dev/null
    echo "[alias-hygiene] Created '${TARGET_INDEX}'."
  fi
}

attach_alias_to_target() {
  echo "[alias-hygiene] Attaching alias '${ALIAS_NAME}' -> '${TARGET_INDEX}' (removing from others)..."
  curl -fsSL -XPOST "${OS}/_aliases" \
    -H 'Content-Type: application/json' \
    -d "{\"actions\":[{\"remove\":{\"index\":\"*\",\"alias\":\"${ALIAS_NAME}\"}},{\"add\":{\"index\":\"${TARGET_INDEX}\",\"alias\":\"${ALIAS_NAME}\"}}]}" >/dev/null
  echo "[alias-hygiene] Done."
}

reindex_from_to() {
  local src="$1"
  local dest="$2"
  echo "[alias-hygiene] Reindexing '${src}' -> '${dest}' (wait_for_completion=true)..."
  curl -fsSL -XPOST "${OS}/_reindex?wait_for_completion=true&refresh=true" \
    -H 'Content-Type: application/json' \
    -d "{\"source\":{\"index\":\"${src}\"},\"dest\":{\"index\":\"${dest}\"}}" >/dev/null
  echo "[alias-hygiene] Reindex complete."
}

delete_index() {
  local idx="$1"
  echo "[alias-hygiene] Deleting index '${idx}'..."
  curl -fsSL -XDELETE "${OS}/${idx}" >/dev/null
  echo "[alias-hygiene] Deleted '${idx}'."
}

confirm() {
  $YES && return 0
  read -r -p "$1 [y/N] " resp
  [[ "${resp:-}" == "y" || "${resp:-}" == "Y" ]]
}

echo "[alias-hygiene] OS=${OS}"
echo "[alias-hygiene] ALIAS=${ALIAS_NAME}"
echo "[alias-hygiene] TARGET_INDEX=${TARGET_INDEX}"

if exists_alias; then
  echo "[alias-hygiene] Alias '${ALIAS_NAME}' exists."
  # Check current alias points to TARGET_INDEX
  current_indices=$(curl -fsSL "${OS}/_alias/${ALIAS_NAME}" | jq -r 'keys[]' 2>/dev/null || true)
  if echo "${current_indices}" | grep -qx "${TARGET_INDEX}"; then
    echo "[alias-hygiene] Alias already points to '${TARGET_INDEX}'. Nothing to do."
    exit 0
  fi
  echo "[alias-hygiene] Alias points to: ${current_indices:-<none>}. Will repoint to '${TARGET_INDEX}'."
  ensure_target_index
  if confirm "Proceed to repoint alias '${ALIAS_NAME}' to '${TARGET_INDEX}'?"; then
    attach_alias_to_target
  else
    echo "[alias-hygiene] Aborted."
    exit 1
  fi
  exit 0
fi

# No alias by that name. If an index exists with the same name, we have a conflict.
if exists_index "${ALIAS_NAME}"; then
  echo "[alias-hygiene] Conflict: a real index exists named '${ALIAS_NAME}'."
  if $DO_REINDEX; then
    ensure_target_index
    if confirm "Reindex '${ALIAS_NAME}' into '${TARGET_INDEX}', delete '${ALIAS_NAME}', and attach alias '${ALIAS_NAME}' -> '${TARGET_INDEX}'?"; then
      reindex_from_to "${ALIAS_NAME}" "${TARGET_INDEX}"
      delete_index "${ALIAS_NAME}"
      attach_alias_to_target
      echo "[alias-hygiene] Completed reindex remediation."
      exit 0
    else
      echo "[alias-hygiene] Aborted."
      exit 1
    fi
  elif $DO_DELETE; then
    ensure_target_index
    if confirm "Delete conflicting index '${ALIAS_NAME}' and attach alias '${ALIAS_NAME}' -> '${TARGET_INDEX}'? (Data loss in '${ALIAS_NAME}')"; then
      delete_index "${ALIAS_NAME}"
      attach_alias_to_target
      echo "[alias-hygiene] Completed delete remediation."
      exit 0
    else
      echo "[alias-hygiene] Aborted."
      exit 1
    fi
  else
    cat >&2 <<EOF
[alias-hygiene] A real index named '${ALIAS_NAME}' exists. Choose a remediation:
  - Reindex (safe):   ${0} --reindex [--yes]
  - Delete (danger):  ${0} --delete-existing [--yes]
You can override:
  OS=${OS}
  MEMORA_SEMANTIC_INDEX=${TARGET_INDEX}
  MEMORA_SEMANTIC_ALIAS=${ALIAS_NAME}
  TEMPLATE=${TEMPLATE_PATH}
EOF
    exit 2
  fi
else
  echo "[alias-hygiene] No alias or conflicting index named '${ALIAS_NAME}'. Creating alias -> '${TARGET_INDEX}'."
  ensure_target_index
  attach_alias_to_target
  exit 0
fi
