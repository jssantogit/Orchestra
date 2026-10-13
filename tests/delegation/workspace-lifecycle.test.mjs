import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { readWorkspaceFingerprint } from "../../core/leases/workspace-fingerprint.mjs";
import {
  cleanupDelegationWorkspace,
  inspectDelegationWorkspace,
  prepareDelegationWorkspace,
} from "../../runtime/delegation/workspace.mjs";

function git(cwd, ...args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 10000,
  }).trim();
}

function createRepo() {
  const root = mkdtempSync(join(tmpdir(), "orchestra-delegation-source-"));
  git(root, "init");
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "user.name", "Orchestra Test");
  writeFileSync(join(root, "tracked.txt"), "canonical\n");
  git(root, "add", "tracked.txt");
  git(root, "commit", "-m", "initial");
  return root;
}

function implementationPacket() {
  return {
    schema: "orchestra.implementation-packet.v1",
    taskId: "workspace-task",
    candidateGeneration: 1,
    goal: "inspect isolated workspace",
    direction: {
      change: "inspect the bounded candidate",
      preserve: ["canonical checkout"],
    },
    anchors: [{ file: "tracked.txt" }],
    scope: {
      allowedAreas: ["**/*"],
      forbidden: [".orchestra/state/**"],
    },
    permissions: {
      discovery: "DIRECTED",
      tests: "READ_ONLY",
      sideEffects: ["LOCAL_TEST"],
    },
    validation: ["workspace remains isolated"],
    failurePolicy: {
      selfCaused: "REPAIR",
      unrelatedOrUncertain: "RETURN_TO_CONTROL",
    },
  };
}

function requestFor(repoRoot, overrides = {}) {
  const identity = readWorkspaceFingerprint(repoRoot, {
    excludedPaths: [".orchestra/state/**"],
  });
  const base = {
    schema: "orchestra.delegation-request.v1",
    delegationId: "workspace-delegation",
    taskId: "workspace-task",
    source: { provider: "provider-a", actorIdHash: "sha256:source" },
    target: { provider: "provider-b", logicalRole: "CRITICAL_REVIEWER" },
    purpose: "INDEPENDENT_REVIEW",
    packet: implementationPacket(),
    authority: {
      capabilities: ["LOCAL_READ", "PROCESS_EXEC"],
      mutation: "FORBIDDEN",
      network: "FORBIDDEN",
      mayDelegate: false,
    },
    workspace: {
      sourceFingerprint: identity.fingerprint,
      sourceRevision: identity.head,
      isolation: "EPHEMERAL_WORKTREE",
    },
    limits: {
      timeoutMs: 120000,
      maxOutputBytes: 65536,
      delegationDepth: 1,
    },
  };
  return {
    ...base,
    ...overrides,
    workspace: { ...base.workspace, ...(overrides.workspace ?? {}) },
  };
}

function inside(parent, child) {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

async function expectPrepFailure(input, reason) {
  await assert.rejects(
    () => prepareDelegationWorkspace(input),
    (error) => {
      assert.equal(error?.code, "WORKSPACE_PREP_FAILED");
      assert.equal(error?.reason, reason);
      return true;
    },
  );
}

test("clean source creates an external detached worktree at the exact requested revision", async (t) => {
  const repoRoot = createRepo();
  const baseDir = mkdtempSync(join(tmpdir(), "orchestra-delegation-root-"));
  t.after(() => rmSync(repoRoot, { recursive: true, force: true }));
  t.after(() => rmSync(baseDir, { recursive: true, force: true }));

  const request = requestFor(repoRoot);
  const context = await prepareDelegationWorkspace({ repoRoot, request, baseDir });
  t.after(async () => { await cleanupDelegationWorkspace(context); });

  assert.equal(context.repoRoot, resolve(repoRoot));
  assert.equal(context.sourceRevision, request.workspace.sourceRevision);
  assert.equal(context.initialFingerprint, request.workspace.sourceFingerprint);
  assert.equal(typeof context.cleanupToken, "string");
  assert.equal(context.cleanupToken.length >= 32, true);
  assert.equal(inside(baseDir, context.path), true);
  assert.equal(inside(repoRoot, context.path), false);
  assert.equal(git(context.path, "rev-parse", "HEAD"), request.workspace.sourceRevision);
  assert.equal(git(context.path, "rev-parse", "--abbrev-ref", "HEAD"), "HEAD");
});

test("linked-worktree source still delegates outside both canonical and linked worktrees", async (t) => {
  const primary = createRepo();
  const linked = mkdtempSync(join(tmpdir(), "orchestra-linked-parent-"));
  rmSync(linked, { recursive: true, force: true });
  git(primary, "worktree", "add", "--detach", linked, "HEAD");
  const baseDir = mkdtempSync(join(tmpdir(), "orchestra-delegation-root-"));
  t.after(() => rmSync(primary, { recursive: true, force: true }));
  t.after(() => rmSync(linked, { recursive: true, force: true }));
  t.after(() => rmSync(baseDir, { recursive: true, force: true }));

  const context = await prepareDelegationWorkspace({
    repoRoot: linked,
    request: requestFor(linked),
    baseDir,
  });
  t.after(async () => { await cleanupDelegationWorkspace(context); });

  assert.equal(inside(primary, context.path), false);
  assert.equal(inside(linked, context.path), false);
  assert.equal(inside(baseDir, context.path), true);
});

test("source revision and fingerprint must match before any worktree is created", async (t) => {
  const repoRoot = createRepo();
  const baseDir = mkdtempSync(join(tmpdir(), "orchestra-delegation-root-"));
  t.after(() => rmSync(repoRoot, { recursive: true, force: true }));
  t.after(() => rmSync(baseDir, { recursive: true, force: true }));

  await expectPrepFailure({
    repoRoot,
    request: requestFor(repoRoot, { workspace: { sourceRevision: "0".repeat(40) } }),
    baseDir,
  }, "SOURCE_REVISION_MISMATCH");

  await expectPrepFailure({
    repoRoot,
    request: requestFor(repoRoot, { workspace: { sourceFingerprint: "sha256:not-the-source" } }),
    baseDir,
  }, "SOURCE_FINGERPRINT_MISMATCH");

  assert.deepEqual(readdirSync(baseDir), []);
});

test("tracked and untracked source dirtiness fail closed", async (t) => {
  const trackedRoot = createRepo();
  const trackedBase = mkdtempSync(join(tmpdir(), "orchestra-delegation-root-"));
  const trackedRequest = requestFor(trackedRoot);
  writeFileSync(join(trackedRoot, "tracked.txt"), "dirty\n");

  const untrackedRoot = createRepo();
  const untrackedBase = mkdtempSync(join(tmpdir(), "orchestra-delegation-root-"));
  const untrackedRequest = requestFor(untrackedRoot);
  writeFileSync(join(untrackedRoot, "untracked.txt"), "dirty\n");

  t.after(() => rmSync(trackedRoot, { recursive: true, force: true }));
  t.after(() => rmSync(untrackedRoot, { recursive: true, force: true }));
  t.after(() => rmSync(trackedBase, { recursive: true, force: true }));
  t.after(() => rmSync(untrackedBase, { recursive: true, force: true }));

  await expectPrepFailure({ repoRoot: trackedRoot, request: trackedRequest, baseDir: trackedBase }, "SOURCE_WORKSPACE_DIRTY");
  await expectPrepFailure({ repoRoot: untrackedRoot, request: untrackedRequest, baseDir: untrackedBase }, "SOURCE_WORKSPACE_DIRTY");
  assert.deepEqual(readdirSync(trackedBase), []);
  assert.deepEqual(readdirSync(untrackedBase), []);
});

test("governance state excluded from the product fingerprint does not make a clean source dirty", async (t) => {
  const repoRoot = createRepo();
  const request = requestFor(repoRoot);
  mkdirSync(join(repoRoot, ".orchestra", "state"), { recursive: true });
  writeFileSync(join(repoRoot, ".orchestra", "state", "work-lease.json"), "{}\n");
  const baseDir = mkdtempSync(join(tmpdir(), "orchestra-delegation-root-"));
  t.after(() => rmSync(repoRoot, { recursive: true, force: true }));
  t.after(() => rmSync(baseDir, { recursive: true, force: true }));

  const context = await prepareDelegationWorkspace({ repoRoot, request, baseDir });
  const cleaned = await cleanupDelegationWorkspace(context);
  assert.deepEqual(cleaned, { cleaned: true, reason: null });
});

test("worker-generated files stay isolated and inspection reports worktree dirtiness only", async (t) => {
  const repoRoot = createRepo();
  const baseDir = mkdtempSync(join(tmpdir(), "orchestra-delegation-root-"));
  t.after(() => rmSync(repoRoot, { recursive: true, force: true }));
  t.after(() => rmSync(baseDir, { recursive: true, force: true }));

  const context = await prepareDelegationWorkspace({ repoRoot, request: requestFor(repoRoot), baseDir });
  t.after(async () => { await cleanupDelegationWorkspace(context); });
  writeFileSync(join(context.path, "worker-output.txt"), "worker-only\n");

  const inspected = await inspectDelegationWorkspace(context);
  assert.equal(inspected.dirty, true);
  assert.equal(inspected.dirtyFileCount, 1);
  assert.notEqual(inspected.finalFingerprint, context.initialFingerprint);
  assert.equal(existsSync(join(repoRoot, "worker-output.txt")), false);
});

test("cleanup token prevents deletion of a worktree not attributable to the supplied context", async (t) => {
  const repoRoot = createRepo();
  const baseDir = mkdtempSync(join(tmpdir(), "orchestra-delegation-root-"));
  t.after(() => rmSync(repoRoot, { recursive: true, force: true }));
  t.after(() => rmSync(baseDir, { recursive: true, force: true }));

  const context = await prepareDelegationWorkspace({ repoRoot, request: requestFor(repoRoot), baseDir });
  const denied = await cleanupDelegationWorkspace({ ...context, cleanupToken: "not-the-token" });
  assert.deepEqual(denied, { cleaned: false, reason: "WORKSPACE_CLEANUP_FAILED" });
  assert.equal(existsSync(context.path), true);

  const cleaned = await cleanupDelegationWorkspace(context);
  assert.deepEqual(cleaned, { cleaned: true, reason: null });
  assert.equal(existsSync(context.path), false);
  assert.equal(git(repoRoot, "worktree", "list", "--porcelain").includes(context.path), false);
});

test("cleanup failure preserves a recoverable worktree path", async (t) => {
  const repoRoot = createRepo();
  const baseDir = mkdtempSync(join(tmpdir(), "orchestra-delegation-root-"));
  t.after(() => rmSync(repoRoot, { recursive: true, force: true }));
  t.after(() => rmSync(baseDir, { recursive: true, force: true }));

  const context = await prepareDelegationWorkspace({ repoRoot, request: requestFor(repoRoot), baseDir });
  const metadataDir = git(context.path, "rev-parse", "--git-dir");
  rmSync(resolve(context.path, metadataDir), { recursive: true, force: true });

  const result = await cleanupDelegationWorkspace(context);
  assert.deepEqual(result, { cleaned: false, reason: "WORKSPACE_CLEANUP_FAILED" });
  assert.equal(existsSync(context.path), true);
});

test("invalid canonical request is rejected before deriving or creating workspace paths", async (t) => {
  const repoRoot = createRepo();
  const baseDir = mkdtempSync(join(tmpdir(), "orchestra-delegation-root-"));
  const request = requestFor(repoRoot);
  delete request.delegationId;
  t.after(() => rmSync(repoRoot, { recursive: true, force: true }));
  t.after(() => rmSync(baseDir, { recursive: true, force: true }));

  await assert.rejects(() => prepareDelegationWorkspace({ repoRoot, request, baseDir }), /delegation/i);
  assert.deepEqual(readdirSync(baseDir), []);
});
