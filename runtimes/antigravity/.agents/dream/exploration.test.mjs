import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { buildSnapshot } from "./snapshot.mjs";
import { createDreamEvent, DREAM_SCHEMAS } from "./records.mjs";
import { sealWorld } from "./world-sealer.mjs";
import {
  EXPLORATION_BUDGET,
  armExplorationCapture,
  buildSandboxedExplorationCommand,
  captureBranchSeedIfArmed,
  enforceExplorationToolBoundary,
  getExplorationBudgetState,
  isSafeExplorationCommand,
  prepareExploration,
  recordExplorationModelCall,
  resolveExplorationPolicyOverlay,
  selectLeastObservedLegalAction,
} from "./exploration-lab.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const stopGuardScript = resolve(__dirname, "../hooks/stop-guard.mjs");
const explorationGuardScript = resolve(__dirname, "../hooks/pre-tool-exploration-guard.mjs");

function fixture() {
  const repo = mkdtempSync(join(tmpdir(), "orchestra-e-test-"));
  mkdirSync(join(repo, "src"), { recursive: true });
  mkdirSync(join(repo, ".agents", "hooks"), { recursive: true });
  writeFileSync(join(repo, "src", "unit.js"), "export const value = 1;\n");
  writeFileSync(join(repo, ".agents", "hooks.json"), JSON.stringify({
    "scope-enforcer": {
      PreToolUse: [{
        matcher: "write_to_file|replace_file_content|edit_file|create_file|invoke_subagent|define_subagent|run_command|manage_task|manage_subagents|schedule|send_message|view_file|grep_search|find_by_name",
        hooks: [{ type: "command", command: "node hooks/pre-tool-enforce.mjs", timeout: 10 }],
      }],
    },
  }, null, 2), "utf8");
  writeFileSync(join(repo, ".agents", "hooks", "pre-tool-enforce.mjs"), "// fixture baseline hook\n", "utf8");
  writeFileSync(join(repo, ".agents", "hooks", "pre-tool-exploration-guard.mjs"), "// fixture exploration wrapper\n", "utf8");
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

test("exploration runner accepts only Antigravity and forces sandbox without bypass flags", () => {
  const launch = buildSandboxedExplorationCommand("agy", ["--model=gemini-3.8-flash-high"]);
  assert.equal(launch.ok, true);
  assert.deepEqual(launch.args, ["--sandbox", "--model=gemini-3.8-flash-high"]);

  const duplicate = buildSandboxedExplorationCommand("antigravity", ["--sandbox", "--model=x"]);
  assert.equal(duplicate.ok, true);
  assert.deepEqual(duplicate.args, ["--sandbox", "--model=x"]);

  assert.equal(buildSandboxedExplorationCommand("node", ["script.mjs"]).ok, false);
  assert.equal(
    buildSandboxedExplorationCommand("agy", ["--dangerously-skip-permissions"]).reason,
    "EXPLORATION_SANDBOX_BYPASS_FORBIDDEN",
  );
  assert.equal(
    buildSandboxedExplorationCommand("agy", ["--no-sandbox"]).reason,
    "EXPLORATION_SANDBOX_BYPASS_FORBIDDEN",
  );
});

test("exploration PreToolUse wrapper always returns an explicit decision", () => {
  const root = mkdtempSync(join(tmpdir(), "orchestra-e-wrapper-"));
  try {
    const noSession = JSON.parse(execFileSync("node", [explorationGuardScript], {
      input: JSON.stringify({
        workspacePaths: [root],
        toolCall: { name: "view_file", args: { AbsolutePath: join(root, "x.txt") } },
      }),
      encoding: "utf8",
    }));
    assert.equal(noSession.decision, "deny");
    assert.match(noSession.reason, /EXPLORATION_SESSION_REQUIRED/);

    const malformed = JSON.parse(execFileSync("node", [explorationGuardScript], {
      input: "{",
      encoding: "utf8",
    }));
    assert.equal(malformed.decision, "deny");
    assert.match(malformed.reason, /MALFORMED_HOOK_PAYLOAD/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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

    const siblingHooks = JSON.parse(readFileSync(join(branch, ".agents", "hooks.json"), "utf8"));
    assert.equal(siblingHooks["scope-enforcer"].PreToolUse[0].matcher, "*");
    assert.equal(
      siblingHooks["scope-enforcer"].PreToolUse[0].hooks[0].command,
      "node hooks/pre-tool-exploration-guard.mjs",
    );
    assert.equal(prepared.session.hook_overlay.mode, "EXPLORATION_PRETOOL_WRAPPER");
    assert.match(prepared.session.hook_overlay.overlay_hash, /^sha256:/);

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

    const missingIdentity = recordExplorationModelCall({ repoRoot: branch, payload: { conversationId: "fresh-a", modelName: "test" } });
    assert.equal(missingIdentity.terminate, true);
    assert.equal(missingIdentity.reason, "EXPLORATION_INVOCATION_IDENTITY_MISSING");

    const first = recordExplorationModelCall({ repoRoot: branch, payload: { conversationId: "fresh-a", invocationNum: 0, modelName: "test" } });
    const repeatedFirst = recordExplorationModelCall({ repoRoot: branch, payload: { conversationId: "fresh-a", invocationNum: 0, modelName: "test" } });
    const second = recordExplorationModelCall({ repoRoot: branch, payload: { conversationId: "fresh-a", invocationNum: 1, modelName: "test" } });
    assert.equal(first.terminate, false);
    assert.equal(repeatedFirst.model_calls, 1, "PostInvocation retries must be idempotent");
    assert.equal(second.terminate, true);
    assert.equal(second.model_calls, 2);
    const budgetState = getExplorationBudgetState(branch);
    assert.equal(budgetState.active, true);
    assert.equal(budgetState.exhausted, true);
    assert.equal(budgetState.model_calls, 2);

    const stopOutput = JSON.parse(execFileSync("node", [stopGuardScript], {
      input: JSON.stringify({
        invocationNum: 1,
        fullyIdle: true,
        terminationReason: "model_stop",
        conversationId: "fresh-a",
        workspacePaths: [branch],
        modelName: "test",
      }),
      encoding: "utf8",
    }));
    assert.equal(stopOutput.decision, "stop");
    assert.match(stopOutput.reason, /EXPLORATION_MODEL_CALL_BUDGET_EXHAUSTED/);

    const duplicate = prepareExploration({ repoRoot: f.repo, seedPath: captured.seed_path, world });
    assert.equal(duplicate.prepared, false);
    assert.equal(duplicate.reason, "SIBLING_LIMIT_REACHED");
  } finally {
    rmSync(f.repo, { recursive: true, force: true });
    if (branch) rmSync(branch, { recursive: true, force: true });
  }
});


test("prepare fails closed when BranchSeed metadata or archived workspace is tampered", () => {
  const f = fixture();
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
    const original = JSON.parse(readFileSync(captured.seed_path, "utf8"));

    const tamperedState = structuredClone(original);
    tamperedState.decision.state.complexity = "DIFFICULT";
    writeFileSync(captured.seed_path, JSON.stringify(tamperedState, null, 2));
    const stateResult = prepareExploration({ repoRoot: f.repo, seedPath: captured.seed_path, world });
    assert.equal(stateResult.prepared, false);
    assert.equal(stateResult.reason, "BRANCH_SEED_STATE_HASH_MISMATCH");

    writeFileSync(captured.seed_path, JSON.stringify(original, null, 2));
    const archiveFile = join(captured.seed_path, "..", "workspace", "src", "unit.js");
    writeFileSync(archiveFile, "export const value = 999;\n");
    const payloadResult = prepareExploration({ repoRoot: f.repo, seedPath: captured.seed_path, world });
    assert.equal(payloadResult.prepared, false);
    assert.equal(payloadResult.reason, "BRANCH_SEED_PAYLOAD_HASH_MISMATCH");
  } finally {
    rmSync(f.repo, { recursive: true, force: true });
  }
});

test("MAJOR exploration requires approval captured in the immutable BranchSeed", () => {
  const f = fixture();
  let branch = null;
  try {
    const majorState = { ...f.state, criticality: "MAJOR" };
    armExplorationCapture({ repoRoot: f.repo, decisionType: "WORKER_TIER" });
    const denied = captureBranchSeedIfArmed({
      repoRoot: f.repo,
      snapshot: f.snapshot,
      decisionType: "WORKER_TIER",
      decisionState: majorState,
      availableActions: ["FLASH_LOW", "FLASH_MEDIUM"],
      scopeContract: { ...f.contract, criticality: "MAJOR" },
      taskDescriptor: { ...f.task, criticality: "MAJOR" },
      evidenceSummary: f.evidence,
      runtimeState: { state: "EXECUTING" },
    });
    assert.equal(denied.captured, false);
    assert.equal(denied.reason, "EXPLORATION_INELIGIBLE_MAJOR_REQUIRES_APPROVAL");

    armExplorationCapture({ repoRoot: f.repo, decisionType: "WORKER_TIER", approveMajor: true });
    const approved = captureBranchSeedIfArmed({
      repoRoot: f.repo,
      snapshot: f.snapshot,
      decisionType: "WORKER_TIER",
      decisionState: majorState,
      availableActions: ["FLASH_LOW", "FLASH_MEDIUM"],
      scopeContract: { ...f.contract, criticality: "MAJOR" },
      taskDescriptor: { ...f.task, criticality: "MAJOR" },
      evidenceSummary: f.evidence,
      runtimeState: { state: "EXECUTING" },
    });
    assert.equal(approved.captured, true);
    const seed = JSON.parse(readFileSync(approved.seed_path, "utf8"));
    assert.equal(seed.human_approved_major, true);

    const world = sealedWorld(f.snapshot, majorState);
    const prepared = prepareExploration({ repoRoot: f.repo, seedPath: approved.seed_path, world });
    assert.equal(prepared.prepared, true, JSON.stringify(prepared));
    branch = prepared.branch_workspace;
  } finally {
    rmSync(f.repo, { recursive: true, force: true });
    if (branch) rmSync(branch, { recursive: true, force: true });
  }
});
