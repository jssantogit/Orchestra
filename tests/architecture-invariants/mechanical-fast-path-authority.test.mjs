import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  classifyMechanicalFastPath,
} from "../../runtimes/antigravity/.agents/skills/orchestra/mechanical-fast-path.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "../..");
const read = (path) => readFileSync(resolve(root, path), "utf8");
const fastPath = read("runtimes/antigravity/.agents/skills/orchestra/mechanical-fast-path.mjs");
const preTool = read("runtimes/antigravity/.agents/hooks/pre-tool-enforce.mjs");
const preInvocation = read("runtimes/antigravity/.agents/hooks/pre-invocation-guard.mjs");
const stop = read("runtimes/antigravity/.agents/hooks/stop-guard.mjs");
const actionSpace = read("runtimes/antigravity/.agents/dream/action-space.mjs");

function eligible(overrides = {}) {
  return classifyMechanicalFastPath({
    taskAction: "MECHANICAL_FIX",
    criticality: "NORMAL",
    requestedProfile: "flash-low-worker",
    attempt: 0,
    scopeContract: {
      allowedPaths: [".gitignore"],
      forbiddenPaths: [".agents/**"],
      testsRequired: [],
      requiredEvidence: [{
        id: "ignored",
        class: "GIT_IGNORED",
        kind: "LOCAL_FACT",
        paths: [".agents/hooks.json", "GEMINI.md"],
      }],
    },
    ...overrides,
  });
}

test("ARCH-MECHANICAL-01: fast path is NORMAL + low-worker + bounded concrete LOCAL_FACT only", () => {
  assert.equal(eligible().eligible, true);
  assert.equal(eligible({ criticality: "MAJOR" }).eligible, false);
  assert.equal(eligible({ requestedProfile: "flash-medium-worker" }).eligible, false);
  assert.equal(eligible({ attempt: 1 }).eligible, false);
  assert.match(fastPath, /SCOPE_TOO_LARGE/);
  assert.match(fastPath, /SCOPE_NOT_CONCRETE/);
  assert.match(fastPath, /NON_LOCAL_FACT_EVIDENCE/);
  assert.match(fastPath, /STRUCTURED_LOCAL_FACT_REQUIRED/);
  assert.match(fastPath, /OUTCOME_FACT_REQUIRED/);
});

test("ARCH-MECHANICAL-02: sensitive mutation targets never enter fast path", () => {
  assert.match(fastPath, /SENSITIVE_PATH_PATTERNS/);
  for (const path of [
    "AGENTS.md",
    ".agents/hooks.json",
    ".github/workflows/ci.yml",
    "terraform/main.tf",
    "database/migration.sql",
    "billing/config.json",
  ]) {
    const result = eligible({
      scopeContract: {
        allowedPaths: [path],
        forbiddenPaths: [],
        testsRequired: [],
        requiredEvidence: [{ id: "exists", class: "FILE_EXISTS", kind: "LOCAL_FACT", path }],
      },
    });
    assert.equal(result.eligible, false, path);
    assert.ok(result.reasons.includes("SENSITIVE_PATH"), path);
  }
});

test("ARCH-MECHANICAL-03: Dream worker-tier action space keeps MECHANICAL_FIX low-only", () => {
  assert.match(actionSpace, /taskAction === "MECHANICAL_FIX"/);
  assert.match(actionSpace, /return \["FLASH_LOW"\]/);
});

test("ARCH-MECHANICAL-04: runtime enforces no side quests during active fast path", () => {
  assert.match(preTool, /MECHANICAL_FAST_PATH_SIDE_QUEST/);
  assert.match(preTool, /MECHANICAL_FAST_PATH_SEARCH_PROHIBITED/);
  assert.match(preTool, /MECHANICAL_FAST_PATH_READ_SCOPE/);
  assert.match(preTool, /MECHANICAL_FAST_PATH_SHELL_PROHIBITED/);
  assert.match(preTool, /MECHANICAL_FAST_PATH_MUTATION_BUDGET/);
  assert.match(preInvocation, /MECHANICAL_FAST_PATH/);
});

test("ARCH-MECHANICAL-05: fast path never grants acceptance authority", () => {
  assert.match(stop, /collectRuntimeEvidenceSync/);
  assert.match(stop, /verifyTaskEvidence\(activeState\)/);
  assert.match(stop, /valEval\.verified/);
  assert.match(stop, /activeState\.acceptanceState = "ACCEPTED"/);
  assert.equal(fastPath.includes("acceptanceState"), false);
  assert.equal(fastPath.includes('state = "DONE"'), false);
  assert.equal(preTool.includes("skipEvidenceCheck"), false);
});

test("ARCH-MECHANICAL-06: evidence failure or staleness exits short mode before recovery", () => {
  assert.match(stop, /FAILED_EVIDENCE_RETRY/);
  assert.match(stop, /FAILED_EVIDENCE_BLOCKED/);
  assert.match(stop, /STALE_EVIDENCE_REPLAN/);
  assert.match(stop, /INVALID_CONTRACT/);
});
