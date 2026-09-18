import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { buildSnapshot } from "./snapshot.mjs";
import { createDreamEvent, DREAM_SCHEMAS } from "./records.mjs";
import { sealWorld } from "./world-sealer.mjs";
import {
  EXPLORATION_BUDGET,
  armExplorationCapture,
  captureBranchSeedIfArmed,
  enforceExplorationToolBoundary,
  isSafeExplorationCommand,
  prepareExploration,
  recordExplorationModelCall,
  resolveExplorationPolicyOverlay,
  selectLeastObservedLegalAction,
} from "./exploration-lab.mjs";

function fixture() {
  const repo = mkdtempSync(join(tmpdir(), "orchestra-e-test-"));
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "unit.js"), "export const value = 1;\n");
  const state = {
    task_action: "IMPLEMENT",
    task_domain: "CODE",
    criticality: "NORMAL",
    complexity: "NORMAL",
    state: "EXECUTING",
    attempt: 0,
    retry_remaining: 1,
    retry_reason: null,
    mutation_seq: 0,
    post_investigation: false,
    evidence: {
      tests: "UNKNOWN",
      typecheck: "UNKNOWN",
      build: "UNKNOWN",
      scope_check: "UNKNOWN",
      validation_fresh: false,
    },
  };
  const task = { spec: "Milestone E fixture", task_action: "IMPLEMENT", task_domain: "CODE", criticality: "NORMAL" };
  const contract = { allowedPaths: ["src/**"], forbiddenPaths: [".agents/**"], criticality: "NORMAL", testsRequired: [] };
  const evidence = { tests: "UNKNOWN", typecheck: "UNKNOWN", build: "UNKNOWN", scope_check: "UNKNOWN", validation_fresh: false };
  const snapshotResult = buildSnapshot({
    repoRoot: repo,
    task,
    contract,
    runtime: { node_version: process.version, platform: process.platform, arch: process.arch, schema_version: DREAM_SCHEMAS.SNAPSHOT },
    executionState: { step_sequence: 0, attempt: 0, retry_remaining: 1, mutation_seq: 0 },
    evidence,
  });
  assert.equal(snapshotResult.ok, true);
  return { repo, state, task, contract, evidence, snapshot: snapshotResult.snapshot };
}

function sealedWorld(snapshot, state) {
  const decision = createDreamEvent("DECISION", {
    schema: DREAM_SCHEMAS.DECISION,
    decision_id: "decision-e-1",
    snapshot_id: snapshot.snapshot_id,
    decision_type: "WORKER_TIER",
    state,
    available_actions: ["FLASH_LOW", "FLASH_MEDIUM"],
    chosen_action: "FLASH_LOW",
    policy_source: "STATIC_POLICY_V1",
    actor_identity: "ORCHESTRATOR",
    created_at: "2026-09-18T00:00:00.000Z",
    step_idx: 0,
    branch_ordinal: 0,
  });
  const outcome = createDreamEvent("DECISION_OUTCOME", {
    schema: DREAM_SCHEMAS.OUTCOME,
    decision_id: decision.decision_id,
    observation_id: "observation-e-1",
    result: "SUCCESS",
    evidence_summary: { tests: "NOT_REQUIRED", typecheck: "NOT_REQUIRED", build: "NOT_REQUIRED", scope_check: "PASS", validation_fresh: false },
    retry_state: { retry_remaining: 1 },
    cost_metrics: { model_calls: 1 },
    terminal_state: "ACCEPTED",
    resulting_snapshot_id: null,
    created_at: "2026-09-18T00:00:01.000Z",
  });
  const sealed = sealWorld({
    events: [decision, outcome],
    expectedRuntimeFingerprint: snapshot.runtime_fingerprint,
    rootSnapshotId: snapshot.snapshot_id,
    worldId: "world-e-fixture",
  });
  assert.equal(sealed.status, "SEALED", JSON.stringify(sealed.errors));
  return sealed.world;
}

test("Milestone E budget constants are immutable and exact", () => {
  assert.equal(EXPLORATION_BUDGET.max_sibling_branches, 1);
  assert.equal(EXPLORATION_BUDGET.max_model_calls, 2);
  assert.equal(EXPLORATION_BUDGET.timeout_ms, 300000);
  assert.equal(Object.isFrozen(EXPLORATION_BUDGET), true);
});

test("least-observed legal action is deterministic with stable action-id tie break", () => {
  const tree = {
    nodes: {
      snap: {
        actions: {
          B: { observations: [], status: "UNKNOWN_BRANCH" },
          A: { observations: [], status: "UNKNOWN_BRANCH" },
          C: { observations: [{}], status: "OBSERVED_ONCE" },
        },
      },
    },
  };
  const selected = selectLeastObservedLegalAction({ tree, snapshotId: "snap", availableActions: ["C", "B", "A"] });
  assert.equal(selected.selected, "A");
  assert.equal(selected.reason, "LEAST_OBSERVED_LEGAL_ACTION");
});

test("command boundary is fail-closed for external or compound shell effects", () => {
  assert.equal(isSafeExplorationCommand("git status"), true);
  assert.equal(isSafeExplorationCommand("node --test test.mjs"), true);
  assert.equal(isSafeExplorationCommand("git push origin main"), false);
  assert.equal(isSafeExplorationCommand("curl https://example.com"), false);
  assert.equal(isSafeExplorationCommand("node --test test.mjs && git push"), false);
});

test("armed capture creates one sanitized physical BranchSeed and refuses CRITICAL", () => {
  const f = fixture();
  try {
    const armed = armExplorationCapture({ repoRoot: f.repo, decisionType: "WORKER_TIER" });
    assert.equal(armed.armed, true);
    const captured = captureBranchSeedIfArmed({
      repoRoot: f.repo,
      snapshot: f.snapshot,
      decisionType: "WORKER_TIER",
      decisionState: f.state,
      availableActions: ["FLASH_LOW", "FLASH_MEDIUM"],
      scopeContract: f.contract,
      taskDescriptor: f.task,
      evidenceSummary: f.evidence,
      runtimeState: { state: "EXECUTING" },
    });
    assert.equal(captured.captured, true, JSON.stringify(captured));
    assert.equal(existsSync(captured.seed_path), true);
    const seed = JSON.parse(readFileSync(captured.seed_path, "utf8"));
    assert.equal(seed.snapshot.snapshot_id, f.snapshot.snapshot_id);
    assert.deepEqual(seed.decision.available_actions, ["FLASH_LOW", "FLASH_MEDIUM"]);
    assert.equal(existsSync(join(captured.seed_path, "..", "workspace", "src", "unit.js")), true);

    armExplorationCapture({ repoRoot: f.repo, decisionType: "WORKER_TIER" });
    const critical = captureBranchSeedIfArmed({
      repoRoot: f.repo,
      snapshot: f.snapshot,
      decisionType: "WORKER_TIER",
      decisionState: { ...f.state, criticality: "CRITICAL" },
      availableActions: ["FLASH_LOW", "FLASH_MEDIUM"],
      scopeContract: f.contract,
      taskDescriptor: f.task,
      evidenceSummary: f.evidence,
      runtimeState: { state: "EXECUTING" },
    });
    assert.equal(critical.captured, false);
    assert.equal(critical.reason, "EXPLORATION_INELIGIBLE_CRITICAL");
  } finally {
    rmSync(f.repo, { recursive: true, force: true });
  }
});

test("prepare materializes exactly one sibling and overlay executes only the unknown action", () => {
  const f = fixture();
  let branch = null;
  try {
    armExplorationCapture({ repoRoot: f.repo, decisionType: "WORKER_TIER" });
    const captured = captureBranchSeedIfArmed({
      repoRoot: f.repo,
      snapshot: f.snapshot,
      decisionType: "WORKER_TIER",
      decisionState: f.state,
      availableActions: ["FLASH_LOW", "FLASH_MEDIUM"],
      scopeContract: f.contract,
      taskDescriptor: f.task,
      evidenceSummary: f.evidence,
      runtimeState: { state: "EXECUTING" },
    });
    assert.equal(captured.captured, true);
    const world = sealedWorld(f.snapshot, f.state);
    const prepared = prepareExploration({ repoRoot: f.repo, seedPath: captured.seed_path, world });
    assert.equal(prepared.prepared, true, JSON.stringify(prepared));
    branch = prepared.branch_workspace;
    assert.notEqual(branch, f.repo);
    assert.equal(prepared.selection.selected, "FLASH_MEDIUM");

    const overlay = resolveExplorationPolicyOverlay({
      repoRoot: branch,
      decisionType: "WORKER_TIER",
      state: f.state,
      availableActions: ["FLASH_LOW", "FLASH_MEDIUM"],
      baselineAction: "FLASH_LOW",
    });
    assert.equal(overlay.action, "FLASH_MEDIUM");
    assert.equal(overlay.source, "EXPLORATION_LAB");
    assert.equal(overlay.source_snapshot_id, f.snapshot.snapshot_id);

    const safe = enforceExplorationToolBoundary({ repoRoot: branch, toolName: "run_command", toolArgs: { CommandLine: "git status" } });
    assert.equal(safe.allowed, true);
    const blocked = enforceExplorationToolBoundary({ repoRoot: branch, toolName: "run_command", toolArgs: { CommandLine: "git push origin main" } });
    assert.equal(blocked.allowed, false);
    assert.equal(enforceExplorationToolBoundary({ repoRoot: branch, toolName: "search_web", toolArgs: {} }).allowed, false);

    const first = recordExplorationModelCall({ repoRoot: branch, payload: { conversationId: "fresh-a", invocationNum: 0, modelName: "test" } });
    const second = recordExplorationModelCall({ repoRoot: branch, payload: { conversationId: "fresh-a", invocationNum: 1, modelName: "test" } });
    assert.equal(first.terminate, false);
    assert.equal(second.terminate, true);
    assert.equal(second.model_calls, 2);

    const duplicate = prepareExploration({ repoRoot: f.repo, seedPath: captured.seed_path, world });
    assert.equal(duplicate.prepared, false);
    assert.equal(duplicate.reason, "SIBLING_LIMIT_REACHED");
  } finally {
    rmSync(f.repo, { recursive: true, force: true });
    if (branch) rmSync(branch, { recursive: true, force: true });
  }
});
