#!/usr/bin/env node
import { existsSync, mkdirSync, cpSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
if (args.length < 1) {
  console.error("Usage: node install-codex.mjs <target-project-path>");
  process.exit(1);
}

const targetDir = resolve(args[0]);
const scriptDir = fileURLToPath(new URL(".", import.meta.url));
const orchestraRoot = resolve(scriptDir, "..");
const sourceCodex = join(orchestraRoot, "runtimes/codex/.codex");

if (!existsSync(targetDir)) {
  console.error(`Error: Target directory '${targetDir}' does not exist.`);
  process.exit(1);
}

const targetCodex = join(targetDir, ".codex");

// Conflict check: Do not overwrite existing configuration silently
if (existsSync(targetCodex)) {
  console.error(`Conflict detected: '${targetCodex}' already exists in target project.`);
  console.error("Aborting installation to prevent overwriting existing configuration.");
  console.error(`To install manually, merge or remove '${targetCodex}'.`);
  process.exit(2);
}

console.log(`Installing Orchestra Codex runtime into '${targetDir}'...`);
mkdirSync(targetCodex, { recursive: true });
cpSync(sourceCodex, targetCodex, { recursive: true });

console.log(`Codex runtime successfully installed to '${targetCodex}'.`);
console.log("Verify installation by running: codex --version or inspect .codex/config.toml");
