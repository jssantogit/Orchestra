#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "Usage: $0 <target-project-path>"
  exit 1
fi

TARGET_DIR="$1"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ORCHESTRA_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
SOURCE_AGENTS="${ORCHESTRA_ROOT}/runtimes/antigravity/.agents"

if [ ! -d "${TARGET_DIR}" ]; then
  echo "Error: Target directory '${TARGET_DIR}' does not exist."
  exit 1
fi

TARGET_AGENTS="${TARGET_DIR}/.agents"

# Conflict check: Do not overwrite existing configuration silently
if [ -e "${TARGET_AGENTS}" ]; then
  echo "Conflict detected: '${TARGET_AGENTS}' already exists in target project."
  echo "Aborting installation to prevent destructive overwriting."
  echo "To install manually, review and merge components under '${TARGET_AGENTS}'."
  exit 2
fi

echo "Installing Orchestra Antigravity runtime into '${TARGET_DIR}'..."
mkdir -p "${TARGET_AGENTS}"

# Copy runtime definitions only: agents, hooks, skills
mkdir -p "${TARGET_AGENTS}/agents" "${TARGET_AGENTS}/hooks" "${TARGET_AGENTS}/skills" "${TARGET_AGENTS}/state" "${TARGET_AGENTS}/telemetry" "${TARGET_AGENTS}/artifacts/outputs"

cp -r "${SOURCE_AGENTS}/agents/"* "${TARGET_AGENTS}/agents/"
cp -r "${SOURCE_AGENTS}/hooks/"* "${TARGET_AGENTS}/hooks/"
cp -r "${SOURCE_AGENTS}/skills/"* "${TARGET_AGENTS}/skills/"
cp "${SOURCE_AGENTS}/hooks.json" "${TARGET_AGENTS}/hooks.json"

# Ensure runtime state and logs are never copied
rm -rf "${TARGET_AGENTS}/state/"*.json 2>/dev/null || true
rm -rf "${TARGET_AGENTS}/telemetry/"*.jsonl 2>/dev/null || true
rm -rf "${TARGET_AGENTS}/artifacts/outputs/"*.log 2>/dev/null || true
touch "${TARGET_AGENTS}/state/.gitkeep"
touch "${TARGET_AGENTS}/telemetry/.gitkeep"
touch "${TARGET_AGENTS}/artifacts/outputs/.gitkeep"

echo "Antigravity runtime successfully installed to '${TARGET_AGENTS}'."
echo "Verify installation by running: node --test ${TARGET_AGENTS}/skills/orchestra/routing-policy.test.mjs"
