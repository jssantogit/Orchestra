/*
 * Test-only fixture to verify runtime firewall isolation between
 * Codex (OpenAI) and Antigravity (Gemini).
 */
import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  CODEX_MODELS,
  decideRoute as decideCodexRoute,
  scanCodexOperationalFiles,
} from "../../runtimes/codex/.codex/astra-orchestra/routing-policy.mjs";
import {
  GEMINI_MODELS,
  decideRoute as decideAntigravityRoute,
} from "../../runtimes/antigravity/.agents/skills/orchestra/routing-policy.mjs";

test("Codex operational routes stay exclusively on OpenAI models", () => {
  const cases = [
    { taskAction: "ORCHESTRATE" },
    { taskAction: "IMPLEMENT", implementationComplexity: "simple" },
    { taskAction: "IMPLEMENT", implementationComplexity: "normal" },
    { taskAction: "INVESTIGATE", investigationEffort: "high" },
    { taskAction: "REVIEW", criticality: "CRITICAL" },
  ];
  for (const facts of cases) {
    const route = decideCodexRoute(facts);
    assert.equal(route.model.startsWith("gpt-"), true, `Codex model must start with gpt-: ${JSON.stringify(route)}`);
    assert.equal(route.model.includes("gemini"), false, `Codex route must not contain gemini: ${JSON.stringify(route)}`);
    assert.equal(route.executor.includes("flash"), false, `Codex executor must not be flash: ${JSON.stringify(route)}`);
  }
  assert.equal(CODEX_MODELS.TERRA_MEDIUM.model, "gpt-5.6-terra");
  assert.equal(CODEX_MODELS.LUNA_MAX.model, "gpt-5.6-luna");
  assert.equal(CODEX_MODELS.SOL_LOW.model, "gpt-5.6-sol");
  assert.equal(CODEX_MODELS.ASTRA_MANUAL.model, "gpt-6-astra");
});

test("Antigravity operational routes stay exclusively on Gemini models", () => {
  const cases = [
    { taskAction: "ORCHESTRATE" },
    { taskAction: "IMPLEMENT", implementationComplexity: "simple" },
    { taskAction: "IMPLEMENT", implementationComplexity: "normal" },
    { taskAction: "INVESTIGATE", investigationEffort: "high" },
    { taskAction: "REVIEW", criticality: "CRITICAL" },
  ];
  for (const facts of cases) {
    const route = decideAntigravityRoute(facts);
    assert.equal(route.model.startsWith("gemini-"), true, `AGY model must start with gemini-: ${JSON.stringify(route)}`);
    assert.equal(route.model.includes("gpt"), false, `AGY route must not contain gpt: ${JSON.stringify(route)}`);
  }
  assert.equal(GEMINI_MODELS.ORCHESTRATOR, "gemini-3.8-flash-medium");
  assert.equal(GEMINI_MODELS.WORKER_LOW, "gemini-3.8-flash-low");
  assert.equal(GEMINI_MODELS.WORKER_MEDIUM, "gemini-3.8-flash-medium");
  assert.equal(GEMINI_MODELS.WORKER_HIGH, "gemini-3.8-flash-high");
});

test("Codex active operational files contain no foreign AGY imports or routes", () => {
  const scan = scanCodexOperationalFiles(fileURLToPath(new URL("../../runtimes/codex", import.meta.url)));
  assert.equal(scan.valid, true);
  assert.deepEqual(scan.violations, []);
});

test("AGY active routing files contain no active OpenAI model routes", () => {
  const agyPolicyPath = fileURLToPath(new URL("../../runtimes/antigravity/.agents/skills/orchestra/routing-policy.mjs", import.meta.url));
  const agyPolicy = readFileSync(agyPolicyPath, "utf8");
  const activeRouteLines = agyPolicy
    .split("\n")
    .filter((line) => /(?:model|executor|worker|profile)\s*[:=]/i.test(line));
  assert.equal(activeRouteLines.some((line) => /gpt-5\.6-(?:terra|luna|sol)|gpt-6-astra/i.test(line)), false);
});

test("AGY operational hooks and skills contain no benchmark-specific contamination", () => {
  const agyOperationalFiles = [
    "../../runtimes/antigravity/.agents/skills/orchestra/routing-policy.mjs",
    "../../runtimes/antigravity/.agents/hooks/pre-tool-enforce.mjs",
    "../../runtimes/antigravity/.agents/hooks/post-tool-telemetry.mjs",
    "../../runtimes/antigravity/.agents/hooks/pre-invocation-guard.mjs",
    "../../runtimes/antigravity/.agents/hooks/stop-guard.mjs",
  ];
  const forbiddenPatterns = [
    /task-3-simple/i,
    /src\/formatter\.js/i,
    /test\/formatter\.test\.js/i,
  ];

  for (const relPath of agyOperationalFiles) {
    const absPath = fileURLToPath(new URL(relPath, import.meta.url));
    if (!existsSync(absPath)) continue;
    const content = readFileSync(absPath, "utf8");
    for (const pattern of forbiddenPatterns) {
      assert.equal(
        pattern.test(content),
        false,
        `Operational file ${relPath} must not contain benchmark artifact matching ${pattern}`
      );
    }
  }
});

test("Codex active operational files contain no foreign AGY Dream imports or references", () => {
  const codexDir = fileURLToPath(new URL("../../runtimes/codex/.codex", import.meta.url));
  const files = [
    join(codexDir, "config.toml"),
    join(codexDir, "astra-orchestra/INSTRUCTIONS.md"),
    join(codexDir, "astra-orchestra/routing-policy.mjs"),
  ];
  const agentsDir = join(codexDir, "agents");
  if (existsSync(agentsDir)) {
    for (const file of readdirSync(agentsDir)) {
      if (file.endsWith(".toml")) {
        files.push(join(agentsDir, file));
      }
    }
  }

  const dreamRefPattern = /(?:\.agents[\\/]dream|runtimes[\\/]antigravity[\\/]\.agents[\\/]dream|\.agents[\\/]dream-data|\.agents[\\/]state[\\/]dream)/i;

  for (const file of files) {
    if (!existsSync(file)) continue;
    const content = readFileSync(file, "utf8");
    assert.equal(
      dreamRefPattern.test(content),
      false,
      `Codex file ${file} must not reference AGY Dream runtime paths`
    );
  }
});

test("Codex scan fails if .codex/ imports or references AGY Dream runtime paths", () => {
  const dreamRefPattern = /(?:\.agents[\\/]dream|runtimes[\\/]antigravity[\\/]\.agents[\\/]dream|\.agents[\\/]dream-data|\.agents[\\/]state[\\/]dream)/i;
  function scanContentForDream(text) {
    return !dreamRefPattern.test(text);
  }

  // Valid codex content passes
  assert.equal(scanContentForDream('const model = "gpt-5.6-terra";'), true);
  assert.equal(scanContentForDream('model = "gpt-6-astra"'), true);

  // Foreign AGY dream imports/references fail
  assert.equal(scanContentForDream('import { buildSnapshot } from ".agents/dream/snapshot.mjs";'), false);
  assert.equal(scanContentForDream('import { sealWorld } from "runtimes/antigravity/.agents/dream/world-sealer.mjs";'), false);
  assert.equal(scanContentForDream('const store = ".agents/dream-data/world.json";'), false);
  assert.equal(scanContentForDream('const pending = ".agents/state/dream/pending-decisions";'), false);
});

test("AGY Dream source contains zero OpenAI models or foreign providers", () => {
  const dreamDir = fileURLToPath(new URL("../../runtimes/antigravity/.agents/dream", import.meta.url));
  const files = readdirSync(dreamDir)
    .filter((file) => file.endsWith(".mjs") && !file.endsWith(".test.mjs"))
    .map((file) => join(dreamDir, file));

  for (const file of files) {
    const content = readFileSync(file, "utf8");
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/(?:model|executor|worker|profile|provider)\s*[:=]/i.test(line)) {
        assert.equal(
          /gpt-5\.6-(?:terra|luna|sol)|gpt-6-astra|gpt-|claude-|text-embedding/i.test(line),
          false,
          `Dream source file ${file}:${i + 1} must not contain foreign model assignment: ${line.trim()}`
        );
      }
      assert.equal(
        /(?:from|import|require)\s+["'][^"']*(?:openai|anthropic)/i.test(line),
        false,
        `Dream source file ${file}:${i + 1} must not import foreign provider SDK: ${line.trim()}`
      );
    }
  }
});

test("AGY Dream source contains no benchmark-specific contamination", () => {
  const dreamDir = fileURLToPath(new URL("../../runtimes/antigravity/.agents/dream", import.meta.url));
  const files = readdirSync(dreamDir)
    .filter((file) => file.endsWith(".mjs") && !file.endsWith(".test.mjs"))
    .map((file) => join(dreamDir, file));

  const forbiddenPatterns = [
    /task-3-simple/i,
    /src\/formatter\.js/i,
    /test\/formatter\.test\.js/i,
  ];

  for (const file of files) {
    const content = readFileSync(file, "utf8");
    for (const pattern of forbiddenPatterns) {
      assert.equal(
        pattern.test(content),
        false,
        `Dream source file ${file} must not contain benchmark artifact matching ${pattern}`
      );
    }
  }
});
