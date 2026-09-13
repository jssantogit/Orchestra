/*
 * Test-only fixture to verify runtime firewall isolation between
 * Codex (OpenAI) and Antigravity (Gemini).
 */
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { test } from "node:test";
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
  const scan = scanCodexOperationalFiles(new URL("../../runtimes/codex", import.meta.url).pathname);
  assert.equal(scan.valid, true);
  assert.deepEqual(scan.violations, []);
});

test("AGY active routing files contain no active OpenAI model routes", () => {
  const agyPolicyPath = new URL("../../runtimes/antigravity/.agents/skills/orchestra/routing-policy.mjs", import.meta.url).pathname;
  const agyPolicy = readFileSync(agyPolicyPath, "utf8");
  const activeRouteLines = agyPolicy
    .split("\n")
    .filter((line) => /(?:model|executor|worker|profile)\s*[:=]/i.test(line));
  assert.equal(activeRouteLines.some((line) => /gpt-5\.6-(?:terra|luna|sol)|gpt-6-astra/i.test(line)), false);
});
