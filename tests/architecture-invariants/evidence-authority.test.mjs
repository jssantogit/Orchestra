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
const federation = read("runtimes/antigravity/.agents/skills/orchestra/evidence-federation.mjs");
const inspector = read("runtimes/antigravity/.agents/skills/orchestra/evidence-inspector.mjs");
const providerRegistry = read("runtimes/antigravity/.agents/skills/orchestra/evidence-provider-registry.mjs");
const preTool = read("runtimes/antigravity/.agents/hooks/pre-tool-enforce.mjs");
const stop = read("runtimes/antigravity/.agents/hooks/stop-guard.mjs");

test("ARCH-EVIDENCE-01: CI_WAIT and remote validation failure are first-class control-plane states", () => {
  assert.match(routing, /"CI_WAIT"/);
  assert.match(routing, /"REMOTE_VALIDATION_FAILURE"/);
  assert.match(routing, /DELEGATED:\s*\[[^\]]*"CI_WAIT"/s);
  assert.match(routing, /CI_WAIT:\s*\[[^\]]*"EVIDENCE_READY"[^\]]*"PLANNED"/s);
});

test("ARCH-EVIDENCE-02: model claims cannot become runtime/provider evidence", () => {
  assert.match(contract, /ORCHESTRA_LOCAL_FACT_COLLECTOR/);
  assert.match(contract, /getEvidenceProvider/);
  assert.match(contract, /provider\.provenanceSource/);
  assert.match(providerRegistry, /ORCHESTRA_GITHUB_COLLECTOR/);
  assert.match(providerRegistry, /validateRemoteEvidenceRequirement/);
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


test("ARCH-EVIDENCE-07: delegated evidence federation requires factual identity and task binding", () => {
  assert.match(federation, /confidence !== "HIGH"/);
  assert.match(federation, /source !== "RUNTIME_IDENTITY"/);
  assert.match(federation, /bindingTaskMatches/);
  assert.match(federation, /bindingAttemptMatches/);
  assert.match(federation, /ORCHESTRA_PARENT_EVIDENCE_FEDERATION/);
  assert.match(contract, /TASK_ID_MISMATCH/);
  assert.match(contract, /COMMIT_SHA_MISMATCH/);
});

test("ARCH-EVIDENCE-08: local evidence producers are explicit and reviewer/model claims are excluded", () => {
  assert.match(contract, /delegatedValidation/);
  assert.match(contract, /parentValidation/);
  assert.match(contract, /"VALIDATION"/);
  assert.equal(/REVIEWER[^\n]*delegatedValidation/.test(contract), false);
  assert.equal(/MODEL_CLAIM[^\n]*parentValidation/.test(contract), false);
});

test("ARCH-EVIDENCE-09: distinct command executions are merged by execution identity, not command text", () => {
  assert.match(federation, /executionId/);
  assert.match(federation, /transcriptEvidenceId/);
  assert.match(federation, /exactEvidenceIdentity/);
  assert.equal(federation.includes("command + type + scope"), false);
});


test("ARCH-EVIDENCE-10: evidence observability is read-only and non-authoritative", () => {
  assert.match(inspector, /inspectProjectEvidence/);
  assert.match(inspector, /explainEvidenceContract/);
  assert.equal(inspector.includes("collectRuntimeEvidenceSync"), false);
  assert.equal(inspector.includes("writeFileSync"), false);
  assert.equal(inspector.includes("appendFileSync"), false);
  assert.equal(inspector.includes("acceptanceState ="), false);
});

test("ARCH-EVIDENCE-11: diagnostics expose rejected model claims instead of promoting them", () => {
  assert.match(contract, /LOCAL_EVIDENCE_PRODUCER_NOT_AUTHORIZED/);
  assert.match(contract, /candidateSummary/);
  assert.match(contract, /diagnoseCandidate/);
  assert.equal(inspector.includes("MODEL_CLAIM IS EVIDENCE"), false);
});
