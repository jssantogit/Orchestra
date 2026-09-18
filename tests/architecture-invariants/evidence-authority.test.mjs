import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "../..");

function read(path) {
  return readFileSync(resolve(root, path), "utf8");
}

const routing = read("runtimes/antigravity/.agents/skills/orchestra/routing-policy.mjs");
const contract = read("runtimes/antigravity/.agents/skills/orchestra/evidence-contract.mjs");
const collectors = read("runtimes/antigravity/.agents/skills/orchestra/evidence-collectors.mjs");
const preTool = read("runtimes/antigravity/.agents/hooks/pre-tool-enforce.mjs");
const stop = read("runtimes/antigravity/.agents/hooks/stop-guard.mjs");

test("ARCH-EVIDENCE-01: CI_WAIT and remote validation failure are first-class control-plane states", () => {
  assert.match(routing, /"CI_WAIT"/);
  assert.match(routing, /"REMOTE_VALIDATION_FAILURE"/);
  assert.match(routing, /DELEGATED:\s*\[[^\]]*"CI_WAIT"/s);
  assert.match(routing, /CI_WAIT:\s*\[[^\]]*"EVIDENCE_READY"[^\]]*"PLANNED"/s);
});

test("ARCH-EVIDENCE-02: model claims cannot become runtime/provider evidence", () => {
  assert.match(contract, /ORCHESTRA_GITHUB_COLLECTOR/);
  assert.match(contract, /ORCHESTRA_LOCAL_FACT_COLLECTOR/);
  assert.match(contract, /validateEvidenceRecord/);
  assert.equal(contract.includes('"MODEL_CLAIM"'), false);
  assert.equal(stop.includes("skipEvidenceCheck"), false);
  assert.equal(stop.includes("ciFirst)"), false);
});

test("ARCH-EVIDENCE-03: GitHub evidence binds repository, workflow, HEAD and required jobs", () => {
  assert.match(collectors, /remote\.origin\.url/);
  assert.match(collectors, /head_sha/);
  assert.match(collectors, /CI_COMMIT_MISMATCH/);
  assert.match(collectors, /CI_WORKFLOW_MISMATCH/);
  assert.match(collectors, /CI_REQUIRED_JOBS_MISSING/);
  assert.match(collectors, /CI_REQUIRED_JOB_FAILED/);
  assert.match(collectors, /LOCAL_MUTATION_AFTER_VALIDATED_COMMIT/);
  assert.match(collectors, /run\.conclusion/);
});

test("ARCH-EVIDENCE-04: Stop Guard collects runtime evidence before verifying acceptance", () => {
  const collectAt = stop.indexOf("collectRuntimeEvidenceSync({");
  const verifyAt = stop.indexOf("const valEval = verifyTaskEvidence(activeState);");
  assert.ok(collectAt >= 0, "runtime collector call must exist");
  assert.ok(verifyAt > collectAt, "contract verification must occur after runtime collection");
  assert.match(stop, /valEval\.status === "PENDING"/);
  assert.match(stop, /activeState\.state = "CI_WAIT"/);
  assert.match(stop, /valEval\.status === "FAILED"/);
  assert.match(stop, /consumeRetryBudget/);
});

test("ARCH-EVIDENCE-05: missing child-owned local evidence is blocked before delegated outcome finalization", () => {
  const childLockAt = stop.indexOf("CHILD_EVIDENCE_REQUIRED");
  const finalizeAt = stop.indexOf("const investigationStop = finalizeInvestigationFromStop");
  assert.ok(childLockAt >= 0, "child evidence lock must exist");
  assert.ok(finalizeAt > childLockAt, "child evidence lock must run before delegated outcome finalization");
  assert.match(stop, /childOwnedMissingRequirements/);
});

test("ARCH-EVIDENCE-06: structured requiredEvidence survives delegation and can explicitly clear inherited tests", () => {
  assert.match(preTool, /hasRequiredEvidence/);
  assert.match(preTool, /requiredEvidence:/);
  assert.match(preTool, /extracted\.hasTestsRequired\s*\?\s*extracted\.testsRequired\s*:\s*baseTestsRequired/);
  assert.match(preTool, /extracted\.hasRequiredEvidence\s*\?\s*extracted\.requiredEvidence\s*:\s*baseRequiredEvidence/);
});
