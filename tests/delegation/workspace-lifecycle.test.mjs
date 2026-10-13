import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

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
  }).trim();
}

function createRepo() {
  const root = mkdtempSync(join(tmpdir(), "orchestra-delegation-source-"));
  git(root, "init", "-q");
  git(root, "config", "user.email", "test@example.invalid");
  git(root, "config", "user.name", "Orchestra Test");
  writeFileSync(join(root, "tracked.txt"), "canonical\n");
  git(root, "add", "tracked.txt");
  git(root, "commit", "-qm", "initial");
  return root;
}

function packet() {
  return {
    schema: "orchestra.implementation-packet.v1",
    taskId: "workspace-lifecycle",
    candidateGeneration: 1,
    goal: "inspect an isolated checkout",
    direction: { change: "review only", preserve: ["canonical workspace"] },
    anchors: [{ file: "tracked.txt" }],
    scope: { allowedAreas: ["tracked.txt"], forbidden: ["secrets/**"] },
    permissions: { discovery: "DIRECTED", tests: "READ_ONLY", sideEffects: ["LOCAL_TEST"] },
    validation: ["read tracked.txt"],
    failurePolicy: { selfCaused: "REPAIR", unrelatedOrUncertain: "RETURN_TO_CONTROL" },
  };
}

function requestFor(repoRoot, overrides = {}) {
  const identity = readWorkspaceFingerprint(repoRoot);
  return {
    schema: "orchestra.delegation-request.v1",
    delegationId: "workspace-delegation-1",
    taskId: "workspace-lifecycle",
    source: { provider: "provider-a", actorIdHash: "sha256:actor" },
    target: { provider: "provider-b", logicalRole: "INVESTIGATOR" },
    purpose: "SECOND_OPINION",
    packet: packet(),
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
    limits: { timeoutMs: 30000, maxOutputBytes: 32768, delegationDepth: 1 },
    ...overrides,
  };
}

function inside(child, parent) {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function expectPrepFailure(fn, detail) {
  assert.throws(fn, (error) => {
    assert.equal(error?.code, "WORKSPACE_PREP_FAILED");
    assert.equal(error?.detail, detail);
    return true;
  });
}

test("clean source creates an external detached worktree at the factual source revision", () => {
  const repoRoot = createRepo();
  const baseDir = mkdtempSync(join(tmpdir(), "orchestra-delegation-external-"));
  try {
    const request = requestFor(repoRoot);
    const context = prepareDelegationWorkspace({ repoRoot, request, baseDir });

    assert.equal(context.repoRoot, resolve(repoRoot));
    assert.equal(context.sourceRevision, request.workspace.sourceRevision);
    assert.equal(context.initialFingerprint, readWorkspaceFingerprint(context.path).fingerprint);
    assert.equal(git(context.path, "rev-parse", "HEAD"), request.workspace.sourceRevision);
    assert.equal(inside(context.path, repoRoot), false);
    assert.equal(inside(context.path, baseDir), true);
    assert.equal(readFileSync(join(context.path, "tracked.txt"), "utf8"), "canonical\n");
    assert.equal(context.cleanupToken.delegationId, request.delegationId);
    assert.equal(context.cleanupToken.path, context.path);

    assert.deepEqual(cleanupDelegationWorkspace(context), { cleaned: true, reason: null });
    assert.equal(existsSync(context.path), false);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("tracked or untracked canonical dirtiness fails closed instead of delegating HEAD", () => {
  for (const dirty of [
    (root) => writeFileSync(join(root, "tracked.txt"), "dirty\n"),
    (root) => writeFileSync(join(root, "untracked.txt"), "dirty\n"),
  ]) {
    const repoRoot = createRepo();
    const baseDir = mkdtempSync(join(tmpdir(), "orchestra-delegation-external-"));
    try {
      const cleanRequest = requestFor(repoRoot);
      dirty(repoRoot);
      expectPrepFailure(
        () => prepareDelegationWorkspace({ repoRoot, request: cleanRequest, baseDir }),
        "SOURCE_WORKSPACE_DIRTY",
      );
      assert.equal(existsSync(join(baseDir, cleanRequest.delegationId)), false);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
      rmSync(baseDir, { recursive: true, force: true });
    }
  }
});

test("source fingerprint and revision mismatches fail before creating a worktree", () => {
  const repoRoot = createRepo();
  const baseDir = mkdtempSync(join(tmpdir(), "orchestra-delegation-external-"));
  try {
    const fingerprintMismatch = requestFor(repoRoot);
    fingerprintMismatch.workspace.sourceFingerprint = "sha256:not-the-current-workspace";
    expectPrepFailure(
      () => prepareDelegationWorkspace({ repoRoot, request: fingerprintMismatch, baseDir }),
      "SOURCE_FINGERPRINT_MISMATCH",
    );

    const revisionMismatch = requestFor(repoRoot);
    revisionMismatch.workspace.sourceRevision = "0000000000000000000000000000000000000000";
    expectPrepFailure(
      () => prepareDelegationWorkspace({ repoRoot, request: revisionMismatch, baseDir }),
      "SOURCE_REVISION_MISMATCH",
    );
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("generated files and dirty state remain isolated to the delegated worktree", () => {
  const repoRoot = createRepo();
  const baseDir = mkdtempSync(join(tmpdir(), "orchestra-delegation-external-"));
  try {
    const context = prepareDelegationWorkspace({ repoRoot, request: requestFor(repoRoot), baseDir });
    writeFileSync(join(context.path, "generated.txt"), "worker-only\n");

    const inspection = inspectDelegationWorkspace(context);
    assert.equal(inspection.dirty, true);
    assert.equal(inspection.dirtyFileCount, 1);
    assert.notEqual(inspection.finalFingerprint, context.initialFingerprint);
    assert.equal(existsSync(join(repoRoot, "generated.txt")), false);

    assert.deepEqual(cleanupDelegationWorkspace(context), { cleaned: true, reason: null });
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("preparation works when the source itself is a linked Git worktree", () => {
  const primary = createRepo();
  const fixtureRoot = mkdtempSync(join(tmpdir(), "orchestra-delegation-linked-"));
  const linked = join(fixtureRoot, "linked-source");
  const baseDir = join(fixtureRoot, "external-delegations");
  try {
    git(primary, "worktree", "add", "--detach", linked, "HEAD");
    const request = requestFor(linked);
    request.delegationId = "linked-worktree-delegation";
    const context = prepareDelegationWorkspace({ repoRoot: linked, request, baseDir });

    assert.equal(inside(context.path, linked), false);
    assert.equal(inside(context.path, primary), false);
    assert.equal(git(context.path, "rev-parse", "HEAD"), request.workspace.sourceRevision);
    assert.deepEqual(cleanupDelegationWorkspace(context), { cleaned: true, reason: null });
  } finally {
    try { git(primary, "worktree", "remove", "--force", linked); } catch {}
    rmSync(primary, { recursive: true, force: true });
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("cleanup failure preserves the attributable path for recovery", () => {
  const repoRoot = createRepo();
  const baseDir = mkdtempSync(join(tmpdir(), "orchestra-delegation-external-"));
  try {
    const context = prepareDelegationWorkspace({ repoRoot, request: requestFor(repoRoot), baseDir });
    const brokenContext = { ...context, repoRoot: join(repoRoot, "missing-repository") };
    assert.deepEqual(cleanupDelegationWorkspace(brokenContext), {
      cleaned: false,
      reason: "WORKSPACE_CLEANUP_FAILED",
    });
    assert.equal(existsSync(context.path), true);

    assert.deepEqual(cleanupDelegationWorkspace(context), { cleaned: true, reason: null });
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(baseDir, { recursive: true, force: true });
  }
});
