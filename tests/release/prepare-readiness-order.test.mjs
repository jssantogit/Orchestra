import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const workflow = readFileSync(join(root, ".github/workflows/prepare-release.yml"), "utf8");

test("prepare workflow builds runtimes before checking current-main release readiness", () => {
  const readinessIndex = workflow.indexOf("- name: Verify current main release metadata");
  const buildIndex = workflow.indexOf("npm run build:runtimes");
  assert.notEqual(readinessIndex, -1);
  assert.notEqual(buildIndex, -1);
  assert.ok(buildIndex < readinessIndex);
});

test("v2 cutover evidence is materialized before current-main readiness and before any release candidate exists", () => {
  const evidenceIndex = workflow.indexOf("- name: Materialize v2 cutover evidence");
  const readinessIndex = workflow.indexOf("- name: Verify current main release metadata");
  const candidateIndex = workflow.indexOf("- name: Create local release candidate");
  assert.notEqual(evidenceIndex, -1, "v2 releases must materialize sanitized factual evidence");
  assert.notEqual(readinessIndex, -1);
  assert.notEqual(candidateIndex, -1);
  assert.ok(evidenceIndex < readinessIndex, "cutover evidence must be consumed by release-readiness");
  assert.ok(readinessIndex < candidateIndex, "an invalid cutover record must block release metadata mutation");
  assert.match(workflow, /ORCHESTRA_V2_REQUIRE_CUTOVER=1/);
  assert.match(workflow, /ORCHESTRA_V2_EXPECTED_HEAD=/);
  assert.match(workflow, /ORCHESTRA_V2_EXPECTED_RUNTIME_IMAGE=/);
});

test("prepare workflow commits the release candidate locally before preflight and pushes only after green validation", () => {
  const localCandidateIndex = workflow.indexOf("- name: Create local release candidate");
  const commitIndex = workflow.indexOf('git commit -m "chore(release): prepare ${TAG}"');
  const preflightIndex = workflow.indexOf("- name: Run full prepared-release preflight");
  const cleanIndex = workflow.indexOf("- name: Require clean validated candidate");
  const pushIndex = workflow.indexOf('git push origin "HEAD:${BRANCH}"');

  assert.notEqual(localCandidateIndex, -1, "prepare workflow must create a local candidate commit");
  assert.notEqual(commitIndex, -1, "local candidate must commit prepared generated artifacts");
  assert.notEqual(preflightIndex, -1, "prepared candidate must still run the full preflight");
  assert.notEqual(cleanIndex, -1, "preflight must prove it did not mutate the candidate");
  assert.notEqual(pushIndex, -1, "validated candidate must eventually be pushed");
  assert.ok(commitIndex < preflightIndex, "generated artifacts must be committed locally before runtime rebuild");
  assert.ok(preflightIndex < cleanIndex, "clean-tree proof belongs after the full preflight");
  assert.ok(cleanIndex < pushIndex, "nothing may be pushed before the exact candidate is proven clean");
});
