import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../..");
const shadowPath = resolve(repoRoot, "runtimes/antigravity/.agents/dream/shadow-mode.mjs");
const decisionRecorderPath = resolve(repoRoot, "runtimes/antigravity/.agents/dream/decision-recorder.mjs");
const preToolPath = resolve(repoRoot, "runtimes/antigravity/.agents/hooks/pre-tool-enforce.mjs");
const hooksPath = resolve(repoRoot, "runtimes/antigravity/.agents/hooks.json");

test("ARCH-G01: Shadow observes factual DECISION publication but has no routing entry point", () => {
  const recorder = readFileSync(decisionRecorderPath, "utf8");
  const preTool = readFileSync(preToolPath, "utf8");
  const hooks = readFileSync(hooksPath, "utf8");
  assert.match(recorder, /recordShadowObservationBestEffort/);
  assert.equal(preTool.includes("shadow-mode"), false);
  assert.equal(preTool.includes("candidate_action"), false);
  assert.equal(hooks.includes("shadow-mode"), false);
});

test("ARCH-G02: Shadow has no execution, model, active-policy, or canary authority", () => {
  const source = readFileSync(shadowPath, "utf8");
  assert.equal(source.includes("node:child_process"), false);
  assert.equal(source.includes("spawnSync"), false);
  assert.equal(source.includes("execFileSync"), false);
  assert.equal(source.includes("invoke_subagent"), false);
  assert.equal(source.includes("send_message"), false);
  assert.equal(source.includes("fetch("), false);
  assert.equal(source.includes("active.json"), false);
  assert.equal(source.includes("policies/versions"), false);
  assert.equal(source.includes("canary_execution_allowed: true"), false);
  assert.match(source, /activation_allowed:\s*false/);
  assert.match(source, /canary_execution_allowed:\s*false/);
});

test("ARCH-G03: Shadow hard-gates CRITICAL and Human Gate before candidate evaluation", () => {
  const source = readFileSync(shadowPath, "utf8");
  const criticalIdx = source.indexOf('state.criticality === "CRITICAL"');
  const humanIdx = source.indexOf('state.state === "HUMAN_GATE"');
  const evaluateIdx = source.indexOf("evaluation = evaluatePolicy({");
  assert.ok(criticalIdx >= 0);
  assert.ok(humanIdx >= 0);
  assert.ok(evaluateIdx >= 0);
  assert.ok(criticalIdx < evaluateIdx);
  assert.ok(humanIdx < evaluateIdx);
});

test("ARCH-G04: Shadow canary-readiness thresholds are immutable and human-gated", () => {
  const source = readFileSync(shadowPath, "utf8");
  assert.match(source, /min_eligible_decisions:\s*50/);
  assert.match(source, /max_unknown_divergence_fraction:\s*0\.20/);
  assert.match(source, /READY_FOR_HUMAN_CANARY_REVIEW/);
  assert.match(source, /human_approval_required:\s*true/);
  assert.match(source, /next_milestone_required_for_execution:\s*"HUMAN_APPROVED_CANARY"/);
});
