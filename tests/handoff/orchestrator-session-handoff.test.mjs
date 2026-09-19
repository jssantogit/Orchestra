import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import {
  ORCHESTRATOR_HANDOFF_MODES,
  ORCHESTRATOR_HANDOFF_STATUSES,
  authorityStateFingerprint,
  cancelProjectOrchestratorHandoff,
  claimProjectOrchestratorHandoff,
  prepareProjectOrchestratorHandoff,
  readProjectOrchestratorHandoff,
} from "../../runtimes/antigravity/.agents/skills/orchestra/orchestrator-handoff.mjs";
import {
  classifyOrchestratorHandoffControlCommand,
} from "../../runtimes/antigravity/.agents/hooks/pre-tool-enforce.mjs";
import {
  verifyEvidenceContract,
} from "../../runtimes/antigravity/.agents/skills/orchestra/evidence-contract.mjs";
import {
  createContinuationCapsule,
} from "../../runtimes/antigravity/.agents/skills/orchestra/trust-boundary.mjs";

const __dirname = resolve(fileURLToPath(new URL(".", import.meta.url)));
const orchestraRoot = resolve(__dirname, "../..");
const preInvocationScript = resolve(orchestraRoot, "runtimes/antigravity/.agents/hooks/pre-invocation-guard.mjs");
const preToolScript = resolve(orchestraRoot, "runtimes/antigravity/.agents/hooks/pre-tool-enforce.mjs");

function makeProject() {
  const root = mkdtempSync(join(tmpdir(), "orchestra-handoff-"));
  mkdirSync(join(root, ".agents", "state"), { recursive: true });
  mkdirSync(join(root, ".agents", "telemetry"), { recursive: true });
  return root;
}

function initGitWorkspace(root) {
  execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Orchestra Tests"], { cwd: root });
  execFileSync("git", ["config", "user.email", "orchestra@example.invalid"], { cwd: root });
  writeFileSync(join(root, "product.txt"), "baseline\n");
  execFileSync("git", ["add", "product.txt"], { cwd: root });
  execFileSync("git", ["commit", "-m", "baseline"], { cwd: root, stdio: "ignore" });
}

function statePath(root) {
  return join(root, ".agents", "state", "active-state.json");
}

function bindingsPath(root) {
  return join(root, ".agents", "state", "role-bindings.json");
}

function handoffPath(root) {
  return join(root, ".agents", "state", "orchestrator-handoff.json");
}

function seedBoundary(root, {
  conversationId = "old-root",
  mutationSeq = 7,
  pendingSubagents = [],
  state = "DONE",
  acceptanceState = "ACCEPTED",
} = {}) {
  const activeState = {
    taskId: "tsuzuki-milestone-1",
    taskAction: "IMPLEMENT",
    taskDomain: "CODE",
    state,
    acceptanceState,
    attempt: 0,
    mutationSeq,
    evidenceCandidateHead: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    conversationId,
    activeRole: "ORCHESTRATOR",
    agentProfile: "flash-orchestrator",
    orchestratorModel: "gemini-3.8-flash-medium",
    scopeContract: {
      allowedPaths: ["app/legacy/**"],
      forbiddenPaths: [".agents/**"],
      requiredEvidence: [{
        id: "legacy-proof",
        class: "LOCAL_TEST",
        kind: "LOCAL_COMMAND",
        command: "node --test legacy.test.mjs",
      }],
    },
    evidenceLedger: [{
      evidenceId: "legacy-evidence",
      result: "PASS",
      command: "node --test legacy.test.mjs",
      stdout: "must-not-cross-boundary",
    }],
  };
  const binding = {
    conversationId,
    role: "ORCHESTRATOR",
    profile: "flash-orchestrator",
    model: "gemini-3.8-flash-medium",
    source: "RUNTIME_BOOTSTRAP",
    confidence: "HIGH",
    authorityStatus: "ACTIVE",
  };
  const roleBindings = {
    mainConversationId: conversationId,
    bindings: { [conversationId]: binding },
    conversations: { [conversationId]: binding },
    pendingSubagents,
  };
  writeFileSync(statePath(root), JSON.stringify(activeState, null, 2));
  writeFileSync(bindingsPath(root), JSON.stringify(roleBindings, null, 2));
  writeFileSync(
    join(root, ".agents", "state", "active-contract.json"),
    JSON.stringify(activeState.scopeContract, null, 2),
  );
  return { activeState, roleBindings };
}

function runPreInvocation(root, conversationId, extra = {}) {
  const input = JSON.stringify({
    conversationId,
    workspacePaths: [root],
    modelName: "gemini-3.8-flash-medium",
    ...extra,
  });
  return JSON.parse(execFileSync(process.execPath, [preInvocationScript], {
    cwd: root,
    input,
    encoding: "utf8",
  }));
}

function runPreTool(root, conversationId, toolName, args = {}) {
  return JSON.parse(execFileSync(process.execPath, [preToolScript], {
    cwd: root,
    input: JSON.stringify({
      conversationId,
      workspacePaths: [root],
      toolCall: { name: toolName, args },
    }),
    encoding: "utf8",
  }));
}


test("handoff: unauthorized fresh root receives managed recovery guidance instead of silent dead-end", () => {
  const root = makeProject();
  try {
    seedBoundary(root);
    const output = runPreInvocation(root, "fresh-without-lease");
    const message = output.injectSteps
      .map((step) => String(step.ephemeralMessage || ""))
      .find((value) => value.includes("ORCHESTRATOR HANDOFF REQUIRED"));
    assert.ok(message);
    assert.match(message, /do not ask the user to edit role-bindings\.json/i);
    assert.match(message, /previous main chat/i);

    const bindings = JSON.parse(readFileSync(bindingsPath(root), "utf8"));
    assert.equal(bindings.mainConversationId, "old-root");
    assert.equal(bindings.bindings["fresh-without-lease"], undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("handoff: boundary preparation is compact, transcript-free, and idempotent", () => {
  const root = makeProject();
  try {
    seedBoundary(root);
    const first = prepareProjectOrchestratorHandoff(root, {
      mode: ORCHESTRATOR_HANDOFF_MODES.MILESTONE_BOUNDARY,
      reason: "next milestone",
      label: "milestone-1-complete",
    });
    assert.equal(first.changed, true);
    assert.equal(first.record.status, ORCHESTRATOR_HANDOFF_STATUSES.ARMED);
    assert.equal(first.record.mode, ORCHESTRATOR_HANDOFF_MODES.MILESTONE_BOUNDARY);
    assert.equal(first.record.current_generation, 0);
    assert.equal(first.record.target_generation, 1);

    const encoded = JSON.stringify(first.record.capsule);
    assert.equal(encoded.includes("app/legacy"), false);
    assert.equal(encoded.includes("legacy-proof"), false);
    assert.equal(encoded.includes("must-not-cross-boundary"), false);
    assert.equal(encoded.includes("stdout"), false);
    assert.equal(encoded.includes("transcript"), false);
    assert.equal(first.record.capsule.context_policy, "FRESH_MILESTONE_NO_PREVIOUS_SCOPE_OR_TRANSCRIPT");

    const second = prepareProjectOrchestratorHandoff(root, {
      mode: ORCHESTRATOR_HANDOFF_MODES.MILESTONE_BOUNDARY,
      reason: "different prose should not create another lease",
    });
    assert.equal(second.changed, false);
    assert.equal(second.idempotent, true);
    assert.equal(second.record.handoff_id, first.record.handoff_id);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("handoff: boundary preparation fails while work is active or child delegation exists", () => {
  const activeRoot = makeProject();
  const childRoot = makeProject();
  try {
    seedBoundary(activeRoot, { state: "PLANNED", acceptanceState: "PENDING" });
    assert.throws(
      () => prepareProjectOrchestratorHandoff(activeRoot),
      /ORCHESTRATOR_HANDOFF_BOUNDARY_NOT_QUIESCENT/,
    );

    seedBoundary(childRoot, {
      pendingSubagents: [{
        seq: 1,
        role: "WORKER",
        profile: "flash-worker",
        parentConversationId: "old-root",
        consumed: false,
      }],
    });
    assert.throws(
      () => prepareProjectOrchestratorHandoff(childRoot),
      /ORCHESTRATOR_HANDOFF_PENDING_SUBAGENTS/,
    );

    seedBoundary(activeRoot, { state: "DELEGATED", acceptanceState: "PENDING" });
    assert.throws(
      () => prepareProjectOrchestratorHandoff(activeRoot, {
        mode: ORCHESTRATOR_HANDOFF_MODES.LIVE_CONTINUATION,
      }),
      /ORCHESTRATOR_HANDOFF_IN_FLIGHT_WORK/,
    );
  } finally {
    rmSync(activeRoot, { recursive: true, force: true });
    rmSync(childRoot, { recursive: true, force: true });
  }
});

test("handoff: explicit live continuation carries bounded runtime authority but no raw transcript", () => {
  const root = makeProject();
  try {
    seedBoundary(root, { state: "PLANNED", acceptanceState: "PENDING" });
    const prepared = prepareProjectOrchestratorHandoff(root, {
      mode: ORCHESTRATOR_HANDOFF_MODES.LIVE_CONTINUATION,
      reason: "context reset",
    });
    assert.equal(prepared.record.mode, ORCHESTRATOR_HANDOFF_MODES.LIVE_CONTINUATION);
    assert.equal(prepared.record.capsule.trust_class, "RUNTIME_AUTHORITY");
    assert.deepEqual(prepared.record.capsule.scope.allowed_paths, ["app/legacy/**"]);
    const encoded = JSON.stringify(prepared.record.capsule);
    assert.equal(encoded.includes("must-not-cross-boundary"), false);
    assert.equal(encoded.includes("stdout"), false);
    assert.equal(encoded.includes("transcript"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test("handoff: live continuation claim preserves current task authority instead of resetting to INTAKE", () => {
  const root = makeProject();
  try {
    seedBoundary(root, { state: "PLANNED", acceptanceState: "PENDING" });
    prepareProjectOrchestratorHandoff(root, {
      mode: ORCHESTRATOR_HANDOFF_MODES.LIVE_CONTINUATION,
      reason: "context window reset",
    });

    const result = claimProjectOrchestratorHandoff(root, {
      candidateConversationId: "new-live-root",
      modelName: "gemini-3.8-flash-medium",
    });
    assert.equal(result.claimed, true);
    assert.equal(result.activeState.state, "PLANNED");
    assert.equal(result.activeState.taskId, "tsuzuki-milestone-1");
    assert.deepEqual(result.activeState.scopeContract.allowedPaths, ["app/legacy/**"]);
    assert.equal(existsSync(join(root, ".agents", "state", "active-contract.json")), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("handoff: child conversation cannot consume an armed root lease", () => {
  const root = makeProject();
  try {
    seedBoundary(root);
    prepareProjectOrchestratorHandoff(root);
    const result = claimProjectOrchestratorHandoff(root, {
      candidateConversationId: "worker-child",
      parentConversationId: "old-root",
      modelName: "gemini-3.8-flash-high",
    });
    assert.equal(result.claimed, false);
    assert.equal(result.reason, "ORCHESTRATOR_HANDOFF_ROOT_REQUIRED");
    assert.equal(readProjectOrchestratorHandoff(root).record.status, "ARMED");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("handoff: changed authority state makes the lease stale and fail-closed", () => {
  const root = makeProject();
  try {
    const seeded = seedBoundary(root);
    const beforeFingerprint = authorityStateFingerprint(seeded.activeState, seeded.roleBindings);
    const prepared = prepareProjectOrchestratorHandoff(root);
    assert.equal(prepared.record.state_fingerprint, beforeFingerprint);

    const changed = JSON.parse(readFileSync(statePath(root), "utf8"));
    changed.mutationSeq += 1;
    writeFileSync(statePath(root), JSON.stringify(changed, null, 2));

    const result = claimProjectOrchestratorHandoff(root, {
      candidateConversationId: "new-root",
    });
    assert.equal(result.claimed, false);
    assert.equal(result.reason, "ORCHESTRATOR_HANDOFF_STALE_STATE_CHANGED");
    assert.equal(readProjectOrchestratorHandoff(root).record.status, "ARMED");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test("handoff: product workspace change after prepare invalidates the lease, governance writes do not", () => {
  const root = makeProject();
  try {
    initGitWorkspace(root);
    seedBoundary(root);
    const prepared = prepareProjectOrchestratorHandoff(root);
    assert.equal(prepared.record.workspace_git_available, true);
    assert.ok(prepared.record.workspace_head);

    // Governance state changes under .agents are excluded from the product fingerprint.
    writeFileSync(join(root, ".agents", "telemetry", "extra.jsonl"), "{\"event\":\"runtime-only\"}\n");
    const stillValid = claimProjectOrchestratorHandoff(root, {
      candidateConversationId: "new-root-runtime-only",
    });
    assert.equal(stillValid.claimed, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  const changedRoot = makeProject();
  try {
    initGitWorkspace(changedRoot);
    seedBoundary(changedRoot);
    prepareProjectOrchestratorHandoff(changedRoot);
    writeFileSync(join(changedRoot, "new-product-file.txt"), "changed after prepare\n");

    const stale = claimProjectOrchestratorHandoff(changedRoot, {
      candidateConversationId: "new-root-stale",
    });
    assert.equal(stale.claimed, false);
    assert.equal(stale.reason, "ORCHESTRATOR_HANDOFF_STALE_WORKSPACE_CHANGED");
    assert.equal(readProjectOrchestratorHandoff(changedRoot).record.status, "ARMED");
  } finally {
    rmSync(changedRoot, { recursive: true, force: true });
  }
});

test("handoff: PreInvocation automatically transfers root authority exactly once", () => {
  const root = makeProject();
  try {
    seedBoundary(root);
    const historicalBindings = JSON.parse(readFileSync(bindingsPath(root), "utf8"));
    historicalBindings.bindings["old-worker"] = {
      conversationId: "old-worker",
      role: "WORKER",
      profile: "flash-worker",
      source: "RUNTIME_IDENTITY",
      confidence: "HIGH",
      parentConversationId: "old-root",
      delegationKind: "WORK",
    };
    historicalBindings.conversations["old-worker"] = historicalBindings.bindings["old-worker"];
    writeFileSync(bindingsPath(root), JSON.stringify(historicalBindings, null, 2));

    const prepared = prepareProjectOrchestratorHandoff(root, {
      label: "M1 -> M2",
    });

    const output = runPreInvocation(root, "new-root");
    assert.equal(output.injectSteps.some((step) =>
      String(step.ephemeralMessage || "").includes("ORCHESTRATOR AUTHORITY HANDOFF CLAIMED")
    ), true);

    const bindings = JSON.parse(readFileSync(bindingsPath(root), "utf8"));
    const state = JSON.parse(readFileSync(statePath(root), "utf8"));
    const handoff = JSON.parse(readFileSync(handoffPath(root), "utf8"));

    assert.equal(bindings.mainConversationId, "new-root");
    assert.equal(bindings.orchestratorGeneration, 1);
    assert.equal(bindings.bindings["new-root"].role, "ORCHESTRATOR");
    assert.equal(bindings.bindings["new-root"].source, "ORCHESTRATOR_HANDOFF");
    assert.equal(bindings.bindings["old-root"].role, "FORMER_ORCHESTRATOR");
    assert.equal(bindings.bindings["old-root"].authorityStatus, "TRANSFERRED");
    assert.equal(bindings.bindings["old-root"].supersededBy, "new-root");
    assert.equal(bindings.bindings["old-worker"], undefined);
    assert.equal(bindings.conversations["old-worker"], undefined);
    assert.equal(Object.keys(bindings.bindings).length, 2);

    const capsule = createContinuationCapsule({
      activeState: state,
      activeContract: {},
      roleBindings: bindings,
    });
    assert.deepEqual(Object.keys(capsule.identities), ["new-root"]);
    assert.equal(capsule.identity_count, 1);

    assert.equal(state.conversationId, "new-root");
    assert.equal(state.orchestratorGeneration, 1);
    assert.equal(state.lastOrchestratorHandoff.handoffId, prepared.record.handoff_id);
    assert.equal(state.state, "INTAKE");
    assert.equal(state.acceptanceState, null);
    assert.equal(state.taskId, undefined);
    assert.equal(state.scopeContract, undefined);
    assert.equal(state.evidenceLedger, undefined);
    assert.equal(state.mutationSeq, 0);
    assert.equal(state.previousMilestoneBoundary.task_id, "tsuzuki-milestone-1");
    assert.equal(state.milestoneBoundaryFreshContext, true);
    assert.equal(existsSync(join(root, ".agents", "state", "active-contract.json")), false);
    assert.equal(handoff.status, "CLAIMED");
    assert.equal(handoff.claimed_by, "new-root");

    const third = runPreInvocation(root, "third-root");
    const after = JSON.parse(readFileSync(bindingsPath(root), "utf8"));
    assert.equal(after.mainConversationId, "new-root");
    assert.equal(
      third.injectSteps.some((step) => String(step.ephemeralMessage || "").includes("HANDOFF CLAIMED")),
      false,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test("handoff: exclusive claim lock prevents simultaneous fresh roots", () => {
  const root = makeProject();
  try {
    seedBoundary(root);
    prepareProjectOrchestratorHandoff(root);

    const lockPath = join(root, ".agents", "state", "orchestrator-handoff.claim.lock");
    writeFileSync(lockPath, "{\"pid\":999999,\"acquiredAt\":\"now\"}\n");

    const blocked = claimProjectOrchestratorHandoff(root, {
      candidateConversationId: "root-a",
    });
    assert.equal(blocked.claimed, false);
    assert.equal(blocked.reason, "ORCHESTRATOR_HANDOFF_CLAIM_IN_PROGRESS");
    assert.equal(readProjectOrchestratorHandoff(root).record.status, "ARMED");

    rmSync(lockPath, { force: true });
    const winner = claimProjectOrchestratorHandoff(root, {
      candidateConversationId: "root-a",
    });
    assert.equal(winner.claimed, true);

    const loser = claimProjectOrchestratorHandoff(root, {
      candidateConversationId: "root-b",
    });
    assert.equal(loser.claimed, false);
    assert.equal(loser.reason, "ORCHESTRATOR_HANDOFF_NOT_ARMED");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("handoff: former orchestrator loses all tool authority after claim", () => {
  const root = makeProject();
  try {
    seedBoundary(root);
    prepareProjectOrchestratorHandoff(root);
    runPreInvocation(root, "new-root");

    const oldResult = runPreTool(root, "old-root", "view_file", {
      TargetFile: "README.md",
      StartLine: 1,
      EndLine: 5,
    });
    assert.equal(oldResult.decision, "deny");
    assert.match(oldResult.reason, /ORCHESTRATOR_AUTHORITY_TRANSFERRED/);

    const classifier = classifyOrchestratorHandoffControlCommand(
      "node .agents/skills/orchestra/orchestrator-handoff-cli.mjs prepare --boundary --label milestone-2",
    );
    assert.equal(classifier.operation, "prepare");
    assert.equal(
      classifyOrchestratorHandoffControlCommand(
        "node .agents/skills/orchestra/orchestrator-handoff-cli.mjs claim --conversation-id stolen",
      ),
      null,
    );
    assert.equal(
      classifyOrchestratorHandoffControlCommand(
        "node .agents/skills/orchestra/orchestrator-handoff-cli.mjs prepare --boundary ; rm -rf .",
      ),
      null,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("handoff: current main orchestrator may run bounded prepare control command", () => {
  const root = makeProject();
  try {
    seedBoundary(root);
    const allowed = runPreTool(root, "old-root", "run_command", {
      CommandLine: "node .agents/skills/orchestra/orchestrator-handoff-cli.mjs prepare --boundary",
    });
    assert.equal(allowed.decision, "allow");

    const denied = runPreTool(root, "not-main", "run_command", {
      CommandLine: "node .agents/skills/orchestra/orchestrator-handoff-cli.mjs prepare --boundary",
    });
    assert.equal(denied.decision, "deny");
    assert.match(denied.reason, /ORCHESTRATOR_HANDOFF_AUTHORITY_REQUIRED|ROLE_IDENTITY/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test("handoff: new root may produce factual parent evidence without granting workers handoff provenance", () => {
  const requirement = {
    id: "parent-check",
    class: "LOCAL_TEST",
    kind: "LOCAL_COMMAND",
    command: "node --test parent.test.mjs",
  };
  const activeState = {
    taskId: "next-milestone",
    conversationId: "new-root",
    attempt: 0,
    mutationSeq: 1,
  };
  const rootEvidence = {
    evidenceId: "root-validation",
    command: requirement.command,
    exitCode: 0,
    failed: 0,
    actorRole: "ORCHESTRATOR",
    confidence: "HIGH",
    evidenceSource: "ORCHESTRATOR_HANDOFF",
    delegationKind: null,
    producer: {
      actorId: "new-root",
      role: "ORCHESTRATOR",
      confidence: "HIGH",
      source: "ORCHESTRATOR_HANDOFF",
      delegationKind: null,
      parentConversationId: null,
    },
    binding: {
      taskId: "next-milestone",
      attempt: 0,
      mutationSeq: 1,
      commitSha: null,
    },
  };
  const rootResult = verifyEvidenceContract({
    activeState,
    contract: { requiredEvidence: [requirement] },
    evidenceLedger: [rootEvidence],
  });
  assert.equal(rootResult.verified, true);

  const fakeWorker = structuredClone(rootEvidence);
  fakeWorker.evidenceId = "worker-fake-handoff";
  fakeWorker.actorRole = "WORKER";
  fakeWorker.delegationKind = "WORK";
  fakeWorker.producer.role = "WORKER";
  fakeWorker.producer.delegationKind = "WORK";

  const workerResult = verifyEvidenceContract({
    activeState,
    contract: { requiredEvidence: [requirement] },
    evidenceLedger: [fakeWorker],
  });
  assert.equal(workerResult.verified, false);
  assert.equal(workerResult.results[0].reason, "LOCAL_EVIDENCE_PRODUCER_NOT_AUTHORIZED");
});

test("handoff: cancel is single-record state and does not mutate orchestration authority", () => {
  const root = makeProject();
  try {
    seedBoundary(root);
    prepareProjectOrchestratorHandoff(root);
    const beforeBindings = readFileSync(bindingsPath(root), "utf8");
    const cancelled = cancelProjectOrchestratorHandoff(root, "stay in old chat");
    assert.equal(cancelled.changed, true);
    assert.equal(cancelled.record.status, "CANCELLED");
    assert.equal(readFileSync(bindingsPath(root), "utf8"), beforeBindings);

    const claim = claimProjectOrchestratorHandoff(root, {
      candidateConversationId: "new-root",
    });
    assert.equal(claim.claimed, false);
    assert.equal(claim.reason, "ORCHESTRATOR_HANDOFF_NOT_ARMED");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
