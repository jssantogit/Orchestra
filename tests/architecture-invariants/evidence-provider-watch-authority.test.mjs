import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "../..");
const read = (path) => readFileSync(resolve(root, path), "utf8");

const contract = read("runtimes/antigravity/.agents/skills/orchestra/evidence-contract.mjs");
const registry = read("runtimes/antigravity/.agents/skills/orchestra/evidence-provider-registry.mjs");
const collectors = read("runtimes/antigravity/.agents/skills/orchestra/evidence-collectors.mjs");
const watch = read("runtimes/antigravity/.agents/skills/orchestra/evidence-watch.mjs");
const runner = read("runtimes/antigravity/.agents/skills/orchestra/evidence-watch-runner.mjs");
const stop = read("runtimes/antigravity/.agents/hooks/stop-guard.mjs");

test("ARCH-PROVIDER-01: remote evidence contract delegates provider validation to registry", () => {
  assert.match(contract, /validateRemoteEvidenceRequirement/);
  assert.equal(contract.includes('!== "GITHUB_ACTIONS"'), false);
  assert.match(registry, /GITHUB_ACTIONS/);
  assert.match(registry, /supportsWatch/);
  assert.match(registry, /validateRequirement/);
});

test("ARCH-PROVIDER-02: collector dispatch is provider-driven", () => {
  assert.match(collectors, /getEvidenceProvider/);
  assert.match(collectors, /--provider-probe/);
  assert.equal(collectors.includes('requirement.provider || "").toUpperCase() === "GITHUB_ACTIONS"'), false);
});

test("ARCH-PROVIDER-03: CI_WAIT stops model polling and persists watch state", () => {
  const pendingStart = stop.indexOf('if (valEval.status === "PENDING")');
  const failedStart = stop.indexOf('if (valEval.status === "FAILED")', pendingStart);
  const pendingBlock = stop.slice(pendingStart, failedStart);
  assert.match(pendingBlock, /activeState\.state = "CI_WAIT"/);
  assert.match(pendingBlock, /summarizeEvidenceWatches/);
  assert.match(pendingBlock, /launchEvidenceWatchRunner/);
  assert.match(pendingBlock, /decision: "stop"/);
  assert.equal(pendingBlock.includes('decision: "continue"'), false);
});

test("ARCH-PROVIDER-04: background runner cannot accept or finish a task", () => {
  assert.match(runner, /state\.state = "EVIDENCE_READY"/);
  assert.equal(runner.includes('acceptanceState = "ACCEPTED"'), false);
  assert.equal(runner.includes('state = "DONE"'), false);
  assert.equal(runner.includes("consumeRetryBudget"), false);
});

test("ARCH-PROVIDER-05: watch identity binds task attempt and mutation sequence", () => {
  assert.match(watch, /taskId/);
  assert.match(watch, /attempt/);
  assert.match(watch, /mutationSeq/);
  assert.match(watch, /WATCH_BINDING_STALE/);
  assert.match(runner, /WATCH_TASK_CHANGED/);
});

test("ARCH-PROVIDER-06: source-unavailable gate counts factual polls, not repeated reads", () => {
  assert.match(stop, /runtimeEvidenceCollection\?\.remotePollPerformed/);
  assert.match(stop, /observedUnavailableNow/);
  assert.match(stop, /previousCount/);
});

test("ARCH-PROVIDER-07: watch runner persists atomically and has a safe disabled fallback", () => {
  assert.match(runner, /fsyncSync/);
  assert.match(runner, /renameSync/);
  assert.match(runner, /ORCHESTRA_DISABLE_BACKGROUND_EVIDENCE_WATCH/);
  assert.match(runner, /detached: true/);
  assert.match(runner, /child\.unref\(\)/);
});
