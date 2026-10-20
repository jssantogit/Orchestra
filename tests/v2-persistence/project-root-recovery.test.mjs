import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createReferenceState } from "../../v2/state/reference-state.mjs";
import { createOperationReconciler } from "../../v2/reconciliation/reconciler.mjs";
import { createManagedWorkspaceRecovery } from "../../v2/workspaces/managed-workspace-recovery.mjs";

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "orchestra-v2-project-root-recovery-"));
  const home = join(root, "home");
  const projectRoot = join(root, "project-a");
  const otherProjectRoot = join(root, "project-b");
  const outsideRoot = join(root, "outside");
  await mkdir(home, { recursive: true });
  for (const path of [projectRoot, otherProjectRoot, outsideRoot]) {
    await mkdir(path, { recursive: true });
    git("init", path);
  }
  return {
    root,
    home,
    projectRoot: await realpath(projectRoot),
    otherProjectRoot: await realpath(otherProjectRoot),
    outsideRoot: await realpath(outsideRoot),
    async cleanup() { await rm(root, { recursive: true, force: true }); },
  };
}

function project(projectId, canonicalRoot) {
  return {
    schema: "orchestra.project.v2",
    projectId,
    lineageId: `lineage-${projectId}`,
    workspace: { canonicalRoot, vcs: "git" },
    runtime: { pinnedImage: "2.0.0", instructionEpoch: 1 },
    trust: { mode: "trusted" },
  };
}

function work(projectId = "prj-project-root") {
  return {
    schema: "orchestra.work-unit.v2",
    workId: "work-project-root",
    projectId,
    taskId: "task-project-root",
    generation: 0,
    runtimeImage: "2.0.0",
    instructionEpoch: 1,
    state: "IMPLEMENTING",
    scopeRef: null,
    directionRef: null,
    candidateRef: null,
    evidenceRefs: [],
    blockers: [],
    continuationRef: null,
  };
}

function operation(workspaceRef, projectId = "prj-project-root") {
  return {
    schema: "orchestra.operation.v2",
    operationId: "op-project-root",
    projectId,
    workId: "work-project-root",
    generation: 0,
    kind: "DIRECT_MUTATION",
    actorRef: "actor:project-root",
    capabilities: ["WORKSPACE_EDIT"],
    workflowState: "RUNNING",
    liveness: "LIVE",
    startedAt: "2000-01-01T00:00:00.000Z",
    heartbeatAt: "2000-01-01T00:00:00.000Z",
    deadlineAt: "2000-01-01T00:01:00.000Z",
    runtimeOwnerRef: "provider-owner:op-project-root",
    workspaceRef,
    resultRef: null,
  };
}

function staleAssessment() {
  return {
    async assess(op) {
      return {
        schema: "orchestra.liveness-assessment.v2",
        operationId: op.operationId,
        observedAt: "2026-10-18T12:00:00.000Z",
        liveness: "STALE_RECOVERABLE",
        reason: "PROVIDER_EVENT_DEADLINE_EXPIRED",
        evidence: {
          ownerStatus: "ABSENT",
          heartbeatFresh: false,
          deadlineExpired: true,
        },
      };
    },
  };
}

function seededState(projectRoot) {
  const state = createReferenceState();
  assert.equal(state.projects.register(project("prj-project-root", projectRoot)).ok, true);
  assert.equal(state.work.startCurrent(work()).ok, true);
  const op = operation(projectRoot);
  assert.equal(state.operations.begin({ expectedGeneration: 0, operation: op }).ok, true);
  return { state, op };
}

test("registered canonical Project root is a factual persistent recovery workspace", async () => {
  const fx = await fixture();
  try {
    const { state, op } = seededState(fx.projectRoot);
    const mutationPath = join(fx.projectRoot, "native-mutation.txt");
    await writeFile(mutationPath, "keep factual mutation\n", "utf8");
    const recovery = createManagedWorkspaceRecovery({ home: fx.home, state });

    assert.deepEqual(await recovery.inspect(op.workspaceRef, op), {
      workspaceRef: fx.projectRoot,
      status: "PROJECT_ROOT",
    });

    await assert.rejects(() => recovery.cleanup(op.workspaceRef, op));
    await assert.rejects(() => recovery.discard(op.workspaceRef, op));
    assert.equal(await exists(mutationPath), true, "persistent Project root must never be cleaned or discarded");
  } finally {
    await fx.cleanup();
  }
});

test("stale owner recovery terminalizes an Operation bound to its registered Project root without cleanup", async () => {
  const fx = await fixture();
  try {
    const { state, op } = seededState(fx.projectRoot);
    const mutationPath = join(fx.projectRoot, "native-mutation.txt");
    await writeFile(mutationPath, "keep factual mutation\n", "utf8");
    const workspaceRecovery = createManagedWorkspaceRecovery({ home: fx.home, state });
    const reconciler = createOperationReconciler({
      state,
      operationLiveness: staleAssessment(),
      workspaceRecovery,
      now: () => "2026-10-18T12:00:00.000Z",
    });

    const result = await reconciler.recover({
      projectId: op.projectId,
      operationId: op.operationId,
      commandId: "recover-project-root",
    });

    assert.equal(result.ok, true);
    assert.equal(result.recovered, true);
    assert.equal(result.cleanup.status, "NOT_REQUIRED");
    assert.equal(result.operation.liveness, "TERMINAL");
    assert.equal(result.operation.workflowState, "ABORTED");
    assert.equal(await exists(mutationPath), true, "recovery must preserve Project-root mutations");

    const journal = state.recoveries.latest({ projectId: op.projectId, operationId: op.operationId });
    assert.equal(journal.workspace.ref, fx.projectRoot);
    assert.equal(journal.workspace.status, "PROJECT_ROOT");
    assert.equal(journal.cleanup.status, "NOT_REQUIRED");
    assert.equal(journal.outcome, "RECOVERED");
  } finally {
    await fx.cleanup();
  }
});

test("Project-root recovery rejects arbitrary and cross-project roots", async () => {
  const fx = await fixture();
  try {
    const { state, op } = seededState(fx.projectRoot);
    assert.equal(state.projects.register(project("prj-other", fx.otherProjectRoot)).ok, true);
    const recovery = createManagedWorkspaceRecovery({ home: fx.home, state });

    const arbitrary = { ...op, workspaceRef: fx.outsideRoot };
    assert.deepEqual(await recovery.inspect(arbitrary.workspaceRef, arbitrary), {
      workspaceRef: fx.outsideRoot,
      status: "UNKNOWN",
    });

    const crossProject = { ...op, workspaceRef: fx.otherProjectRoot };
    assert.deepEqual(await recovery.inspect(crossProject.workspaceRef, crossProject), {
      workspaceRef: fx.otherProjectRoot,
      status: "UNKNOWN",
    });
  } finally {
    await fx.cleanup();
  }
});
