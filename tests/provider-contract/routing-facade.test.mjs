import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const repoRoot = resolve(new URL("../..", import.meta.url).pathname);
const codexPath = resolve(repoRoot, "runtimes/codex/.codex/astra-orchestra/routing-policy.mjs");
const antigravityPath = resolve(repoRoot, "runtimes/antigravity/.agents/skills/orchestra/routing-policy.mjs");

async function source(path) {
  return readFile(path, "utf8");
}

test("Codex public routing policy is a thin facade over neutral routing and its own catalog", async () => {
  const text = await source(codexPath);
  assert.match(text, /\.\/core\/routing\/task-classification\.mjs/);
  assert.match(text, /\.\/core\/routing\/escalation\.mjs/);
  assert.match(text, /\.\/provider\/codex\/model-catalog\.mjs/);
  assert.match(text, /routing-policy-legacy\.mjs/);
  assert.doesNotMatch(text, /gpt-6-(?:sol|luna|astra)/i);
  assert.doesNotMatch(text, /gemini-3\.8/i);
});

test("Antigravity public routing policy is a thin facade over neutral routing and its own catalog", async () => {
  const text = await source(antigravityPath);
  assert.match(text, /\.\/core\/routing\/task-classification\.mjs/);
  assert.match(text, /\.\/core\/routing\/escalation\.mjs/);
  assert.match(text, /\.\/provider\/antigravity\/model-catalog\.mjs/);
  assert.match(text, /routing-policy-legacy\.mjs/);
  assert.doesNotMatch(text, /gpt-6-/i);
  assert.doesNotMatch(text, /gemini-3\.8-flash/i);
});

test("facade routing remains behaviorally compatible for baseline provider scenarios", async () => {
  const codex = await import(`${new URL("../../runtimes/codex/.codex/astra-orchestra/routing-policy.mjs", import.meta.url).href}?facade=${Date.now()}`);
  const antigravity = await import(`${new URL("../../runtimes/antigravity/.agents/skills/orchestra/routing-policy.mjs", import.meta.url).href}?facade=${Date.now()}`);

  assert.equal(codex.decideRoute({ taskAction: "ORCHESTRATE" }).profile, "sol-medium");
  assert.equal(codex.decideRoute({ taskAction: "IMPLEMENT", implementationComplexity: "simple" }).profile, "luna-high");
  assert.equal(codex.decideRoute({ taskAction: "IMPLEMENT", implementationComplexity: "normal" }).profile, "luna-max");
  assert.equal(codex.decideRoute({ taskAction: "INVESTIGATE" }).profile, "sol-high");
  assert.equal(codex.decideRoute({ taskAction: "REVIEW", criticality: "CRITICAL" }).profile, "sol-review-low");

  assert.equal(antigravity.decideRoute({ taskAction: "ORCHESTRATE" }).model, antigravity.GEMINI_MODELS.ORCHESTRATOR);
  assert.equal(antigravity.decideRoute({ taskAction: "IMPLEMENT", implementationComplexity: "simple" }).model, antigravity.GEMINI_MODELS.WORKER_LOW);
  assert.equal(antigravity.decideRoute({ taskAction: "IMPLEMENT", implementationComplexity: "normal" }).model, antigravity.GEMINI_MODELS.WORKER_MEDIUM);
  assert.equal(antigravity.decideRoute({ taskAction: "IMPLEMENT", implementationComplexity: "difficult" }).model, antigravity.GEMINI_MODELS.WORKER_HIGH);
  assert.equal(antigravity.decideRoute({ taskAction: "INVESTIGATE" }).model, antigravity.GEMINI_MODELS.INVESTIGATOR);
});
