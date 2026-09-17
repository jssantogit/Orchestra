#!/usr/bin/env node
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { resolve, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(new URL(".", import.meta.url).pathname, "..");

export function runContaminationCheck(rootDir = root) {
  const violations = [];

  // 1. Scan Codex Active Runtime Files
  const codexDir = join(rootDir, "runtimes/codex/.codex");
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
    { pattern: /(?:\.agents[\\/]dream|runtimes[\\/]antigravity[\\/]\.agents[\\/]dream|\.agents[\\/]dream-data|\.agents[\\/]state[\\/]dream)/i, name: "Reference or import to AGY Dream runtime path" },
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
          file: relative(rootDir, file),
          violation: name,
        });
      }
    }
  }

  // 2. Scan Antigravity Active Runtime Files
  const agyDir = join(rootDir, "runtimes/antigravity/.agents");
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
  for (const file of agyFiles) {
    if (!existsSync(file)) continue;
    const content = readFileSync(file, "utf8");
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/(?:model|executor|worker|profile)\s*[:=]/i.test(line)) {
        if (/gpt-5\.6-(?:terra|luna|sol)|gpt-6-astra/i.test(line)) {
          violations.push({
            runtime: "ANTIGRAVITY",
            file: relative(rootDir, file),
            line: i + 1,
            violation: `Active route to OpenAI/Codex model: ${line.trim()}`,
          });
        }
      }
    }
  }

  // 3. Scan Antigravity Dream Source Files for Foreign Provider & Model Contamination
  const dreamDir = join(rootDir, "runtimes/antigravity/.agents/dream");
  const dreamSourceFiles = [];
  if (existsSync(dreamDir)) {
    for (const file of readdirSync(dreamDir)) {
      if (file.endsWith(".mjs") && !file.endsWith(".test.mjs")) {
        dreamSourceFiles.push(join(dreamDir, file));
      }
    }
  }

  for (const file of dreamSourceFiles) {
    const content = readFileSync(file, "utf8");
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/(?:model|executor|worker|profile|provider)\s*[:=]/i.test(line)) {
        if (/gpt-5\.6-(?:terra|luna|sol)|gpt-6-astra|gpt-|claude-|text-embedding/i.test(line)) {
          violations.push({
            runtime: "ANTIGRAVITY_DREAM",
            file: relative(rootDir, file),
            line: i + 1,
            violation: `Active route to OpenAI/Claude model: ${line.trim()}`,
          });
        }
      }
      if (/(?:from|import|require)\s+["'][^"']*(?:openai|anthropic)/i.test(line)) {
        violations.push({
          runtime: "ANTIGRAVITY_DREAM",
          file: relative(rootDir, file),
          line: i + 1,
          violation: `Foreign provider import: ${line.trim()}`,
        });
      }
    }
  }

  // 4. Scan Antigravity Operational Hooks, Skills, and Dream Source for Benchmark Contamination
  const forbiddenBenchmarkPatterns = [
    { pattern: /task-3-simple/i, name: "Hardcoded benchmark task identifier (task-3-simple)" },
    { pattern: /src\/formatter\.js/i, name: "Hardcoded benchmark product path (src/formatter.js)" },
    { pattern: /test\/formatter\.test\.js/i, name: "Hardcoded benchmark test path (test/formatter.test.js)" },
  ];

  const agyOperationalFiles = [
    join(agyDir, "skills/orchestra/routing-policy.mjs"),
    join(agyDir, "hooks/pre-tool-enforce.mjs"),
    join(agyDir, "hooks/post-tool-telemetry.mjs"),
    join(agyDir, "hooks/pre-invocation-guard.mjs"),
    join(agyDir, "hooks/stop-guard.mjs"),
    ...dreamSourceFiles,
  ];

  for (const file of agyOperationalFiles) {
    if (!existsSync(file)) continue;
    const content = readFileSync(file, "utf8");
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      for (const { pattern, name } of forbiddenBenchmarkPatterns) {
        if (pattern.test(line)) {
          violations.push({
            runtime: "ANTIGRAVITY",
            file: relative(rootDir, file),
            line: i + 1,
            violation: `Benchmark contamination in operational code: ${name} (${line.trim()})`,
          });
        }
      }
    }
  }

  return violations;
}

const isCli = Boolean(
  process.argv[1] &&
  (resolve(process.argv[1]) === fileURLToPath(import.meta.url) ||
   resolve(process.argv[1]).endsWith("scripts/contamination-check.mjs"))
);

if (isCli) {
  console.log("Running Orchestra Cross-Runtime Contamination Check...");
  const violations = runContaminationCheck(root);
  if (violations.length === 0) {
    console.log("PASS: Cross-runtime firewall is clean. Zero provider or benchmark contamination detected.");
    process.exit(0);
  } else {
    console.error("FAIL: Cross-runtime contamination detected:");
    for (const v of violations) {
      console.error(` - [${v.runtime}] ${v.file}${v.line ? `:${v.line}` : ""}: ${v.violation}`);
    }
    process.exit(1);
  }
}
