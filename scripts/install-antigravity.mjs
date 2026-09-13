#!/usr/bin/env node
import { existsSync, mkdirSync, cpSync, rmSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
if (args.length < 1) {
  console.error("Usage: node install-antigravity.mjs <target-project-path>");
  process.exit(1);
}

const targetDir = resolve(args[0]);
const scriptDir = fileURLToPath(new URL(".", import.meta.url));
const orchestraRoot = resolve(scriptDir, "..");
const sourceAgents = join(orchestraRoot, "runtimes/antigravity/.agents");
const sourceGemini = join(orchestraRoot, "runtimes/antigravity/GEMINI.md");

if (!existsSync(targetDir)) {
  console.error(`Error: Target directory '${targetDir}' does not exist.`);
  process.exit(1);
}

const targetAgents = join(targetDir, ".agents");
const targetGemini = join(targetDir, "GEMINI.md");

// Conflict check: Do not overwrite existing configuration silently
if (existsSync(targetAgents) || existsSync(targetGemini)) {
  console.error(`Conflict detected: '${targetAgents}' or '${targetGemini}' already exists in target project.`);
  console.error("Aborting installation to prevent destructive overwriting.");
  console.error(`To install manually, review and merge components under '${targetAgents}'.`);
  process.exit(2);
}

console.log(`Installing Orchestra Antigravity runtime into '${targetDir}'...`);
mkdirSync(targetAgents, { recursive: true });

const subdirs = ["agents", "hooks", "skills", "state", "telemetry", "artifacts/outputs"];
for (const sub of subdirs) {
  mkdirSync(join(targetAgents, sub), { recursive: true });
}

cpSync(join(sourceAgents, "agents"), join(targetAgents, "agents"), { recursive: true });
cpSync(join(sourceAgents, "hooks"), join(targetAgents, "hooks"), { recursive: true });
cpSync(join(sourceAgents, "skills"), join(targetAgents, "skills"), { recursive: true });
cpSync(join(sourceAgents, "hooks.json"), join(targetAgents, "hooks.json"));
if (existsSync(sourceGemini)) {
  cpSync(sourceGemini, targetGemini);
}

// Ensure runtime state and logs are never copied
try { rmSync(join(targetAgents, "state/active-state.json"), { force: true }); } catch {}
try { rmSync(join(targetAgents, "state/active-contract.json"), { force: true }); } catch {}
try { rmSync(join(targetAgents, "telemetry/events.jsonl"), { force: true }); } catch {}

writeFileSync(join(targetAgents, "state/.gitkeep"), "");
writeFileSync(join(targetAgents, "telemetry/.gitkeep"), "");
writeFileSync(join(targetAgents, "artifacts/outputs/.gitkeep"), "");

console.log(`Antigravity runtime successfully installed to '${targetAgents}'.`);
console.log(`Verify installation by running: node --test ${join(targetAgents, "skills/orchestra/routing-policy.test.mjs")}`);
