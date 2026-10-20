import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDelegatedRecoveryInspection } from "../../runtime/delegation/v2-recovery-inspection.mjs";
import { createRuntimeOwnerStore } from "../../v2/liveness/runtime-owner-store.mjs";
import { createManagedWorkspaceStore, resolveManagedWorkspacePaths } from "../../v2/workspaces/managed-workspace-store.mjs";
import { createDelegatedChildTerminalStore } from "../../runtime/delegation/v2-child-terminal-store.mjs";

const operation = {
  schema: "orchestra.operation.v2", operationId: "op_delegated_recovery",
  projectId: "project-one", workId: "work-one", generation: 2,
  kind: "DELEGATED_MUTATION", workflowState: "RUNNING", liveness: "LIVE",
  workspaceRef: "/canonical/project", resultRef: null,
};
const birth = "linux:boot-id:12345";
const childOwnerId = "owner_delegated_child_" + operation.operationId;

async function setup(t) {
  const home = mkdtempSync(join(tmpdir(), "orchestra-delegated-recovery-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const { instancesRoot } = resolveManagedWorkspacePaths({ home });
  mkdirSync(instancesRoot, { recursive: true });
  const clone = join(instancesRoot, "scoped-clone");
  mkdirSync(clone);
  const workspaces = createManagedWorkspaceStore({ home });
  assert.equal((await workspaces.register({
    schema: "orchestra.managed-workspace.v2",
    workspaceRef: "workspace:delegated:" + operation.operationId,
    operationId: operation.operationId, projectId: operation.projectId,
    workId: operation.workId, generation: operation.generation,
    kind: "TRANSIENT_GIT_CLONE", root: clone,
    registeredAt: "2026-10-20T12:00:00.000Z",
  })).ok, true);
  const owners = createRuntimeOwnerStore({ rootDir: join(home, "runtime-owners") });
  assert.equal((await owners.register({
    schema: "orchestra.runtime-owner.v2", runtimeOwnerId: childOwnerId,
    operationId: operation.operationId, kind: "LOCAL_PROCESS",
    registeredAt: "2026-10-20T12:00:01.000Z",
    process: { pid: 45678, startIdentity: birth },
    proof: { tokenHash: "sha256:" + "a".repeat(64) },
  })).ok, true);
  const terminals = createDelegatedChildTerminalStore({ home, runtimeOwnerStore: owners });
  const state = { operations: { inspect: id => id === operation.operationId ? operation : null } };
  const inspect = (reader, groupReader = async () => "UNAVAILABLE") => createDelegatedRecoveryInspection({
    home, state, readProcessIdentity: reader, readProcessGroupStatus: groupReader,
  }).inspect({ operationId: operation.operationId });
  return { home, clone, workspaces, owners, terminals, inspect };
}

test("live exact child prevents cleanup and redispatch after a controller restart", async t => {
  const f = await setup(t);
  const a = await f.inspect(async pid => {
    assert.equal(pid, 45678);
    return { status: "PRESENT", processIdentity: birth };
  });
  assert.equal(a.ok, true);
  assert.equal(a.reason, "CHILD_STILL_LIVE");
  assert.equal(a.evidence.childStatus, "MATCH");
  assert.equal(a.evidence.cloneStatus, "PRESENT");
  assert.equal(a.evidence.terminalStatus, "MISSING");
  assert.equal(a.humanGate, true);
  assert.equal(a.cleanupAuthorized, false);
  assert.equal(a.redispatchAuthorized, false);
});

test("PID reuse and unavailable child proof are UNKNOWN rather than recovered", async t => {
  const f = await setup(t);
  for (const [reader, status] of [
    [async () => ({ status: "PRESENT", processIdentity: "linux:boot-id:999" }), "MISMATCH"],
    [async () => ({ status: "UNAVAILABLE" }), "UNAVAILABLE"],
    [async () => { throw new Error("probe broken"); }, "UNAVAILABLE"],
  ]) {
    const a = await f.inspect(reader);
    assert.equal(a.evidence.childStatus, status);
    assert.equal(a.reason, "CHILD_LIFECYCLE_UNKNOWN");
    assert.equal(a.cleanupAuthorized, false);
    assert.equal(a.redispatchAuthorized, false);
  }
});

test("child absent but no durable terminal receipt is not proof of cleanup", async t => {
  const f = await setup(t);
  const a = await f.inspect(async () => ({ status: "ABSENT" }));
  assert.equal(a.evidence.childStatus, "ABSENT");
  assert.equal(a.reason, "CHILD_TERMINAL_UNVERIFIED");
  assert.equal(a.humanGate, true);
});

test("factual child close still cannot authorize deleting a clone or assuming descendants ended", async t => {
  const f = await setup(t);
  assert.equal((await f.terminals.register({
    schema: "orchestra.delegated-child-terminal.v1",
    operationId: operation.operationId, runtimeOwnerId: childOwnerId,
    process: { pid: 45678, startIdentity: birth },
    terminal: { exitCode: 0, signal: null, timedOut: false,
      closedAt: "2026-10-20T12:01:00.000Z" },
  })).ok, true);
  const a = await f.inspect(async () => ({ status: "ABSENT" }));
  assert.equal(a.evidence.terminalStatus, "VERIFIED");
  assert.equal(a.reason, "DESCENDANT_LIFECYCLE_UNPROVEN");
  assert.equal(a.cleanupAuthorized, false);
  assert.equal(a.redispatchAuthorized, false);
});

test("cross-work clone record, missing clone and tampered terminal fail closed", async t => {
  const f = await setup(t);
  rmSync(f.clone, { recursive: true, force: true });
  const a = await f.inspect(async () => ({ status: "ABSENT" }));
  assert.equal(a.evidence.cloneStatus, "ABSENT");
  assert.equal(a.cleanupAuthorized, false);
  assert.equal(a.redispatchAuthorized, false);
  const mismatched = createDelegatedRecoveryInspection({
    home: f.home,
    state: { operations: { inspect: () => ({ ...operation, generation: 3 }) } },
    readProcessIdentity: async () => ({ status: "ABSENT" }),
  });
  const b = await mismatched.inspect({ operationId: operation.operationId });
  assert.equal(b.reason, "CLONE_ASSOCIATION_UNVERIFIED");
  assert.equal(b.cleanupAuthorized, false);
});


test("nonzero child-close receipt stays terminal failure, never a successful quiescence claim", async t => {
  const f = await setup(t);
  assert.equal((await f.terminals.register({
    schema: "orchestra.delegated-child-terminal.v1",
    operationId: operation.operationId, runtimeOwnerId: childOwnerId,
    process: { pid: 45678, startIdentity: birth },
    terminal: { exitCode: 9, signal: null, timedOut: false,
      closedAt: "2026-10-20T12:02:00.000Z" },
  })).ok, true);
  const a = await f.inspect(async () => ({ status: "ABSENT" }));
  assert.equal(a.evidence.terminalStatus, "VERIFIED");
  assert.equal(a.reason, "CHILD_EXIT_FAILED");
  assert.equal(a.cleanupAuthorized, false);
  assert.equal(existsSync(f.clone), true);
});


test("a still-active POSIX process group after child close blocks any quiescence claim", async t => {
  const f = await setup(t);
  assert.equal((await f.terminals.register({
    schema: "orchestra.delegated-child-terminal.v1",
    operationId: operation.operationId, runtimeOwnerId: childOwnerId,
    process: { pid: 45678, startIdentity: birth },
    terminal: { exitCode: 0, signal: null, timedOut: false,
      closedAt: "2026-10-20T12:01:00.000Z" },
  })).ok, true);
  const a = await f.inspect(async () => ({ status: "ABSENT" }), async pid => {
    assert.equal(pid, 45678);
    return "PRESENT";
  });
  assert.equal(a.evidence.processGroupStatus, "PRESENT");
  assert.equal(a.reason, "PROCESS_GROUP_STILL_ACTIVE");
  assert.equal(a.cleanupAuthorized, false);
  assert.equal(a.redispatchAuthorized, false);
  assert.equal(a.humanGate, true);
});

test("an absent process group still cannot prove escaped descendants terminated", async t => {
  const f = await setup(t);
  assert.equal((await f.terminals.register({
    schema: "orchestra.delegated-child-terminal.v1",
    operationId: operation.operationId, runtimeOwnerId: childOwnerId,
    process: { pid: 45678, startIdentity: birth },
    terminal: { exitCode: 0, signal: null, timedOut: false,
      closedAt: "2026-10-20T12:01:00.000Z" },
  })).ok, true);
  const a = await f.inspect(async () => ({ status: "ABSENT" }),
    async () => "ABSENT");
  assert.equal(a.evidence.processGroupStatus, "ABSENT");
  assert.equal(a.reason, "DESCENDANT_LIFECYCLE_UNPROVEN");
  assert.equal(a.cleanupAuthorized, false);
});
