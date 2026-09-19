#!/usr/bin/env node
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { installCodexProjectRuntime } from "../runtimes/codex/.codex/astra-orchestra/codex-runtime-manager.mjs";

const args = process.argv.slice(2);
if (args.length < 1) {
  console.error("Usage: node install-codex.mjs <target-project-path>");
  process.exit(1);
}

const targetDir = resolve(args[0]);
const scriptDir = fileURLToPath(new URL(".", import.meta.url));
const orchestraRoot = resolve(scriptDir, "..");
const sourceRuntimeRoot = resolve(orchestraRoot, "runtimes", "codex");

if (!existsSync(targetDir)) {
  console.error(`Error: Target directory '${targetDir}' does not exist.`);
  process.exit(1);
}

try {
  console.log(`Installing Orchestra Codex runtime into '${targetDir}'...`);
  const result = installCodexProjectRuntime({ sourceRuntimeRoot, targetDir });
  console.log(`Codex runtime successfully installed to '${targetDir}/.codex'.`);
  console.log(`Version: ${result.metadata.orchestraVersion || "unknown"}`);
  console.log(`Source commit: ${result.metadata.sourceCommit || "unknown"}`);
  console.log("Verify with: node scripts/orchestra-codex-project.mjs doctor <project>");
} catch (error) {
  if (error?.code === "CODEX_INSTALL_CONFLICT" || /CODEX_INSTALL_CONFLICT/.test(String(error?.message || ""))) {
    console.error(`Conflict detected: '${targetDir}/.codex' already exists in target project.`);
    console.error("Aborting installation to prevent overwriting existing configuration.");
    console.error("Use orchestra-codex-project.mjs update to adopt/update an existing runtime.");
    process.exit(2);
  }
  console.error(String(error?.message || error));
  process.exit(1);
}
