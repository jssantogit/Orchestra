#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "Usage: $0 <target-project-path>"
  exit 1
fi

TARGET_DIR="$1"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ORCHESTRA_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
SOURCE_CODEX="${ORCHESTRA_ROOT}/runtimes/codex/.codex"

if [ ! -d "${TARGET_DIR}" ]; then
  echo "Error: Target directory '${TARGET_DIR}' does not exist."
  exit 1
fi

TARGET_CODEX="${TARGET_DIR}/.codex"

# Conflict check: Do not overwrite existing configuration silently
if [ -e "${TARGET_CODEX}" ]; then
  echo "Conflict detected: '${TARGET_CODEX}' already exists in target project."
  echo "Aborting installation to prevent overwriting existing configuration."
  echo "To install manually, merge or remove '${TARGET_CODEX}'."
  exit 2
fi

echo "Installing Orchestra Codex runtime into '${TARGET_DIR}'..."
mkdir -p "${TARGET_CODEX}"
cp -r "${SOURCE_CODEX}/"* "${TARGET_CODEX}/"

# Ensure clean state: never copy session or state files
rm -rf "${TARGET_CODEX}/benchmarks/raw-"* 2>/dev/null || true

echo "Codex runtime successfully installed to '${TARGET_CODEX}'."
echo "Verify installation by running: codex --version or inspect .codex/config.toml"
