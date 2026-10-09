#!/usr/bin/env node
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { resolve, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(new URL(".", import.meta.url).pathname, "..");

export function runContaminationCheck(rootDir = root) {
  const violations = [];

  // Core is the provider-neutral contract layer. Provider adapters may depend
  // on Core, while Core itself must never depend on a runtime implementation.
  violations.push(...scanCoreProviderFirewall(rootDir));
  violations.push(...scanProviderRuntimeImports(rootDir));

  // 1. Scan Codex Active Runtime Files
  const codexDir = join(rootDir, "runtimes/codex/.codex");
  const codexFiles = [
    join(codexDir, "config.toml"),
    join(codexDir, "hooks.json"),
    join(codexDir, "astra-orchestra/INSTRUCTIONS.md"),
  ];

  const codexOrchestraDir = join(codexDir, "astra-orchestra");
  if (existsSync(codexOrchestraDir)) {
    for (const file of readdirSync(codexOrchestraDir)) {
      if (file.endsWith(".mjs") && !file.endsWith(".test.mjs")) codexFiles.push(join(codexOrchestraDir, file));
    }
  }

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
    { pattern: /(?:model|executor|worker|reviewer|profile)\s*[:=][^\n]*(?:jev|typesafe)/i, name: "Active route to Jev/TypeSafe semantic service" },
    { pattern: /experiments[\\/]jev|api\.typesafe\.ai|TYPESAFE_API_KEY/i, name: "Jev experiment/service reference in active Codex runtime" },
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
    join(agyDir, "skills/orchestra/orchestrator-handoff.mjs"),
    join(agyDir, "skills/orchestra/orchestrator-handoff-cli.mjs"),
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
        if (/gpt-5\.6-(?:terra|luna|sol)|gpt-6-(?:sol|luna|astra)/i.test(line)) {
          violations.push({
            runtime: "ANTIGRAVITY",
            file: relative(rootDir, file),
            line: i + 1,
            violation: `Active route to OpenAI/Codex model: ${line.trim()}`,
          });
        }
        if (/jev|typesafe/i.test(line)) {
          violations.push({
            runtime: "ANTIGRAVITY",
            file: relative(rootDir, file),
            line: i + 1,
            violation: `Active route to Jev/TypeSafe semantic service: ${line.trim()}`,
          });
        }
      }
      if (/experiments[\\/]jev|api\.typesafe\.ai|TYPESAFE_API_KEY/i.test(line)) {
        violations.push({
          runtime: "ANTIGRAVITY",
          file: relative(rootDir, file),
          line: i + 1,
          violation: `Jev experiment/service reference in active runtime: ${line.trim()}`,
        });
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
      if (/experiments[\\/]jev|api\.typesafe\.ai|TYPESAFE_API_KEY|jev-latest/i.test(line)) {
        violations.push({
          runtime: "ANTIGRAVITY_DREAM",
          file: relative(rootDir, file),
          line: i + 1,
          violation: `Jev semantic service contamination in Dream runtime: ${line.trim()}`,
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
    join(agyDir, "skills/orchestra/orchestrator-handoff.mjs"),
    join(agyDir, "skills/orchestra/orchestrator-handoff-cli.mjs"),
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

const coreProviderRules = [
  {
    pattern: /(?:from\s*|import\s*\(|require\s*\()\s*["'][^"']*runtimes[\\/][^"']*["']/gi,
    name: "Core runtime import (adapters may depend on Core, never the reverse)",
  },
  {
    pattern: /(?:runtimes[\\/](?:codex|antigravity)|\.codex[\\/]|\.agents[\\/])/gi,
    name: "Core reference to provider runtime path",
  },
  {
    pattern: /\b(?:codex|antigravity)\b/gi,
    name: "Core reference to provider runtime",
  },
  {
    pattern: /\b(?:gpt-(?:[0-9]+(?:\.[0-9]+)?(?:-[a-z0-9]+)*)|gemini-[a-z0-9.-]+|claude-[a-z0-9.-]+)\b/gi,
    name: "Concrete provider model identifier in Core",
  },
  {
    pattern: /\b(?:openai|anthropic)\b/gi,
    name: "Concrete model-provider reference in Core",
  },
  {
    pattern: /\b(?:hook_event_name|hookSpecificOutput|PreToolUse|PostToolUse|UserPromptSubmit|SessionStart|BeforeTool|AfterTool|BeforeAgent|AfterAgent|tool_name|tool_input|stop_hook_active)\b/g,
    name: "Provider runtime hook API assumption in Core",
  },
  {
    pattern: /\b(?:session_id|main_session_id|pending_session_id|candidate_session_id|codexSessionId|antigravitySessionId|geminiSessionId)\b/g,
    name: "Provider runtime session field assumption in Core",
  },
];

function listFilesRecursively(directory) {
  if (!existsSync(directory)) return [];
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...listFilesRecursively(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

const sourceImportPattern = /\bimport\s*["']([^"']+)["']|\b(?:import|export)\s+(?:(?!["';])[\s\S])*?\s+from\s*["']([^"']+)["']|\b(?:import|require)\s*\(\s*["']([^"']+)["']/g;

function runtimeNameForPath(path) {
  const normalized = path.replaceAll("\\", "/");
  if (/(?:^|\/)runtimes\/codex\//i.test(normalized)) return "CODEX";
  if (/(?:^|\/)runtimes\/antigravity\//i.test(normalized)) return "ANTIGRAVITY";
  return null;
}

export function scanProviderRuntimeImports(rootDir) {
  const violations = [];
  for (const provider of ["codex", "antigravity"]) {
    const runtimeDir = join(rootDir, "runtimes", provider);
    for (const file of listFilesRecursively(runtimeDir)) {
      if (!/\.(?:mjs|cjs|js|ts|mts|cts)$/.test(file) || file.endsWith(".test.mjs")) continue;
      const content = readFileSync(file, "utf8");
      sourceImportPattern.lastIndex = 0;
      let match;
      while ((match = sourceImportPattern.exec(content))) {
        const specifier = match[1] || match[2] || match[3];
        const target = specifier.startsWith(".")
          ? resolve(file, "..", specifier)
          : resolve(rootDir, specifier);
        const targetProvider = runtimeNameForPath(target)
          || runtimeNameForPath(resolve(rootDir, specifier));
        if (targetProvider && targetProvider !== provider.toUpperCase()) {
          violations.push({
            runtime: provider.toUpperCase(),
            file: relative(rootDir, file),
            line: content.slice(0, match.index).split("\n").length,
            violation: `Provider runtime import of ${targetProvider} runtime: ${specifier}`,
          });
        }
      }
    }
  }
  return violations;
}

export function scanCoreProviderFirewall(rootDir) {
  const coreDirs = [
    join(rootDir, "core"),
    join(rootDir, "schemas"),
    join(rootDir, "runtimes/codex/.codex/astra-orchestra/core"),
    join(rootDir, "runtimes/antigravity/.agents/skills/orchestra/core"),
  ];
  const violations = [];
  for (const coreDir of coreDirs) {
    for (const file of listFilesRecursively(coreDir)) {
      const content = readFileSync(file, "utf8");
      const lines = content.split("\n");
      for (let index = 0; index < lines.length; index++) {
        const line = lines[index];
        for (const { pattern, name } of coreProviderRules) {
          pattern.lastIndex = 0;
          if (pattern.test(line)) {
            violations.push({
              runtime: "CORE",
              file: relative(rootDir, file),
              line: index + 1,
              violation: name,
            });
          }
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
