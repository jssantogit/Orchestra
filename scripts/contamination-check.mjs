#!/usr/bin/env node
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { resolve, join, relative } from "node:path";

const root = resolve(new URL(".", import.meta.url).pathname, "..");

console.log("Running Orchestra Cross-Runtime Contamination Check...");

let violations = [];

// 1. Scan Codex Active Runtime Files
const codexDir = join(root, "runtimes/codex/.codex");
const codexFiles = [
  join(codexDir, "config.toml"),
  join(codexDir, "astra-orchestra/INSTRUCTIONS.md"),
  join(codexDir, "astra-orchestra/routing-policy.mjs"),
];

const codexAgentsDir = join(codexDir, "agents");
if (existsSync(codexAgentsDir)) {
  for (const file of readdirSync(codexAgentsDir)) {
    if (file.endsWith(".toml")) {
      codexFiles.push(join(codexAgentsDir, file));
    }
  }
}

const forbiddenInCodex = [
  { pattern: /(?:from|import)\s+["'][^"']*\.agents/i, name: "Import of .agents runtime" },
  { pattern: /(?:model|executor)\s*[:=]\s*["']gemini-/i, name: "Active route to Gemini model" },
  { pattern: /(?:executor|worker|profile)\s*[:=]\s*["']flash-(?:worker|orchestrator)/i, name: "Active route to Flash worker" },
  { pattern: /ALL-GEMINI\s+Architecture/i, name: "ALL-GEMINI reference in active Codex instructions" },
];

for (const file of codexFiles) {
  if (!existsSync(file)) continue;
  const content = readFileSync(file, "utf8");
  for (const { pattern, name } of forbiddenInCodex) {
    if (pattern.test(content)) {
      violations.push({
        runtime: "CODEX",
        file: relative(root, file),
        violation: name,
      });
    }
  }
}

// 2. Scan Antigravity Active Runtime Files
const agyDir = join(root, "runtimes/antigravity/.agents");
const agyFiles = [
  join(agyDir, "skills/orchestra/routing-policy.mjs"),
  join(agyDir, "hooks/pre-tool-enforce.mjs"),
  join(agyDir, "hooks/post-tool-telemetry.mjs"),
  join(agyDir, "hooks/pre-invocation-guard.mjs"),
  join(agyDir, "hooks/stop-guard.mjs"),
];

const agyAgentsDir = join(agyDir, "agents");
if (existsSync(agyAgentsDir)) {
  for (const file of readdirSync(agyAgentsDir)) {
    if (file.endsWith(".md")) {
      agyFiles.push(join(agyAgentsDir, file));
    }
  }
}

// In AGY active routing, check for active model assignments to GPT models.
// Lines that define model assignments:
for (const file of agyFiles) {
  if (!existsSync(file)) continue;
  const content = readFileSync(file, "utf8");
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Check if line assigns model/executor/worker/profile to GPT
    if (/(?:model|executor|worker|profile)\s*[:=]/i.test(line)) {
      if (/gpt-5\.6-(?:terra|luna|sol)|gpt-6-astra/i.test(line)) {
        violations.push({
          runtime: "ANTIGRAVITY",
          file: relative(root, file),
          line: i + 1,
          violation: `Active route to OpenAI/Codex model: ${line.trim()}`,
        });
      }
    }
  }
}

// 3. Report Results
if (violations.length === 0) {
  console.log("PASS: Cross-runtime firewall is clean. Zero provider contamination detected.");
  process.exit(0);
} else {
  console.error("FAIL: Cross-runtime contamination detected:");
  for (const v of violations) {
    console.error(` - [${v.runtime}] ${v.file}${v.line ? `:${v.line}` : ""}: ${v.violation}`);
  }
  process.exit(1);
}
