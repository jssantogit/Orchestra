import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { readWorkspaceFingerprint } from "../../core/leases/workspace-fingerprint.mjs";
import { acquireAtomicLock, releaseAtomicLock } from "../../core/leases/atomic-lock.mjs";
import {
  discardDelegationArtifact,
  inspectDelegationArtifact,
  promoteDelegationArtifact,
  sealDelegationArtifact,
} from "../../runtime/delegation/artifact-lifecycle.mjs";
import { readDelegationArtifact } from "../../runtime/delegation/artifact-store.mjs";
import {
  cleanupMutableDelegationWorkspace,
  prepareMutableDelegationWorkspace,
} from "../../runtime/delegation/mutable-workspace.mjs";

function git(cwd, ...args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 10000,
    maxBuffer: 16 * 1024 * 1024,
  }).trim();
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function createRepo({ dirtyBaseline = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "orchestra-artifact-promotion-"));
  git(root, "init");
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "user.name", "Orchestra Test");
  writeFileSync(join(root, "worker.txt"), "worker-before\n");
  writeFileSync(join(root, "staged.txt"), "staged-before\n");
  writeFileSync(join(root, "unstaged.txt"), "unstaged-before\n");
  writeFileSync(join(root, "delete.txt"), "delete-before\n");
  git(root, "add", ".");
  git(root, "commit", "-m", "initial");

  if (dirtyBaseline) {
    writeFileSync(join(root, "staged.txt"), "staged-canonical\n");
    git(root, "add", "staged.txt");
    writeFileSync(join(root, "unstaged.txt"), "unstaged-canonical\n");
    writeFileSync(join(root, "preexisting-untracked.txt"), "preexisting-untracked\n");
  }
  return root;
}

function requestFor(repoRoot, id, allowedPaths = ["**"]) {
  const identity = readWorkspaceFingerprint(repoRoot, { excludedPaths: [".orchestra/state/**"] });
  return {
    schema: "orchestra.delegation-request.v2",
    delegationId: id,
    taskId: `${id}-task`,
    source: { provider: "provider-a", actorIdHash: "sha256:source" },
    target: { provider: "provider-b", logicalRole: "IMPLEMENTER" },
    purpose: "IMPLEMENTATION",
    packet: {
      schema: "orchestra.implementation-packet.v1",
      taskId: `${id}-task`,
      candidateGeneration: 7,
      goal: "produce one promotable worker mutation",
      direction: { change: "edit authorized files", preserve: ["CONTROL authority"] },
      anchors: [{ file: "worker.txt" }],
      scope: { allowedAreas: allowedPaths, forbidden: [".git/**", ".orchestra/state/**"] },
      permissions: { discovery: "DIRECTED", tests: "MODIFY_AUTHORIZED_TARGETS", sideEffects: ["WORKSPACE_EDIT"] },
      validation: ["sealed artifact integrity"],
      failurePolicy: { selfCaused: "REPAIR", unrelatedOrUncertain: "RETURN_TO_CONTROL" },
    },
    authority: {
      capabilities: ["LOCAL_READ", "PROCESS_EXEC", "WORKSPACE_EDIT"],
      mutation: "WORKSPACE_ONLY",
      network: "FORBIDDEN",
      mayDelegate: false,
    },
    workspace: {
      sourceFingerprint: identity.fingerprint,
      sourceRevision: identity.head,
      isolation: "EPHEMERAL_CLONE",
      mutationScope: { allowedPaths, forbiddenPaths: [] },
    },
    limits: { timeoutMs: 120000, maxOutputBytes: 65536, delegationDepth: 1 },
  };
}

function actor(overrides = {}) {
  return {
    provider: "provider-a",
    actorIdHash: "sha256:source",
    actorKind: "ROOT",
    isRoot: true,
    ...overrides,
  };
}

async function sealedFixture(t, {
  id = `artifact-${Math.random().toString(16).slice(2)}`,
  dirtyBaseline = false,
  mutate = null,
  allowedPaths = ["**"],
} = {}) {
  const repoRoot = createRepo({ dirtyBaseline });
  t.after(() => rmSync(repoRoot, { recursive: true, force: true }));
  const request = requestFor(repoRoot, id, allowedPaths);
  const baseDir = mkdtempSync(join(tmpdir(), "orchestra-artifact-review-"));
  t.after(() => rmSync(baseDir, { recursive: true, force: true }));
  const workspace = await prepareMutableDelegationWorkspace({ repoRoot, request, baseDir });
  t.after(async () => { await cleanupMutableDelegationWorkspace(workspace); });

  if (mutate) {
    await mutate({ repoRoot, request, workspace });
  } else {
    writeFileSync(join(workspace.path, "worker.txt"), "worker-after\n");
  }

  const descriptor = await sealDelegationArtifact({
    repoRoot,
    request,
    generation: 7,
    actor: actor(),
    workspace,
    report: { summary: "worker claim", findings: [], evidenceRefs: [] },
  });
  return { repoRoot, request, workspace, descriptor };
}

function artifactPaths(repoRoot, artifactId) {
  const dir = join(repoRoot, ".orchestra", "state", "delegation", "artifacts", artifactId);
  return {
    dir,
    manifest: join(dir, "manifest.json"),
    patch: join(dir, "candidate.patch"),
  };
}

function currentFileFact(root, path, deletedMode = null) {
  const absolute = join(root, path);
  if (!existsSync(absolute)) {
    return { path, kind: "DELETED", mode: deletedMode, contentHash: null };
  }
  const stat = lstatSync(absolute);
  if (stat.isSymbolicLink()) {
    return {
      path,
      kind: "SYMLINK",
      mode: "120000",
      contentHash: `sha256:${sha256(Buffer.from(readlinkSync(absolute), "utf8"))}`,
    };
  }
  assert.equal(stat.isFile(), true, `unsupported fact kind for ${path}`);
  return {
    path,
    kind: "FILE",
    mode: (stat.mode & 0o111) !== 0 ? "100755" : "100644",
    contentHash: `sha256:${sha256(readFileSync(absolute))}`,
  };
}

function mutationDigest(facts) {
  return `sha256:${sha256(Buffer.from(JSON.stringify(facts), "utf8"))}`;
}

test("inspect validates sealed artifact integrity without mutating canonical product state", async (t) => {
  const fixture = await sealedFixture(t, { id: "artifact-inspect" });
  const before = readWorkspaceFingerprint(fixture.repoRoot, { excludedPaths: [".orchestra/state/**"] });

  const inspected = await inspectDelegationArtifact({
    repoRoot: fixture.repoRoot,
    artifactId: fixture.descriptor.artifactId,
  });

  assert.equal(inspected.integrity.valid, true);
  assert.equal(inspected.integrity.reason, null);
  assert.equal(inspected.manifest.state, "READY_FOR_REVIEW");
  assert.equal(inspected.reviewPath, fixture.workspace.path);
  assert.equal(readFileSync(join(fixture.repoRoot, "worker.txt"), "utf8"), "worker-before\n");
  const after = readWorkspaceFingerprint(fixture.repoRoot, { excludedPaths: [".orchestra/state/**"] });
  assert.equal(after.fingerprint, before.fingerprint);
});

test("inspect reports retained file, index, patch, or manifest tampering", async (t) => {
  const cases = [
    {
      id: "artifact-tamper-file",
      tamper({ workspace }) {
        writeFileSync(join(workspace.path, "worker.txt"), "tampered-after-seal\n");
      },
    },
    {
      id: "artifact-tamper-index",
      tamper({ workspace }) {
        writeFileSync(join(workspace.path, "extra.txt"), "extra-after-seal\n");
        git(workspace.path, "add", "extra.txt");
      },
    },
    {
      id: "artifact-tamper-patch",
      tamper({ repoRoot, descriptor }) {
        const paths = artifactPaths(repoRoot, descriptor.artifactId);
        writeFileSync(paths.patch, Buffer.concat([readFileSync(paths.patch), Buffer.from("\n# tampered\n")]));
      },
    },
    {
      id: "artifact-tamper-manifest",
      tamper({ repoRoot, descriptor }) {
        const paths = artifactPaths(repoRoot, descriptor.artifactId);
        const manifest = JSON.parse(readFileSync(paths.manifest, "utf8"));
        manifest.patchSha256 = "sha256:tampered-manifest";
        writeFileSync(paths.manifest, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
      },
    },
  ];

  for (const entry of cases) {
    await t.test(entry.id, async (subtest) => {
      const fixture = await sealedFixture(subtest, { id: entry.id });
      entry.tamper({ ...fixture });
      const inspected = await inspectDelegationArtifact({
        repoRoot: fixture.repoRoot,
        artifactId: fixture.descriptor.artifactId,
      });
      assert.equal(inspected.integrity.valid, false);
      assert.equal(inspected.integrity.reason, "ARTIFACT_TAMPERED");
      assert.equal(readFileSync(join(fixture.repoRoot, "worker.txt"), "utf8"), "worker-before\n");
    });
  }
});

test("promotion denies wrong CONTROL actor or generation before canonical mutation", async (t) => {
  const cases = [
    { id: "artifact-wrong-provider", generation: 7, actor: actor({ provider: "provider-x" }) },
    { id: "artifact-wrong-actor", generation: 7, actor: actor({ actorIdHash: "sha256:other" }) },
    { id: "artifact-wrong-generation", generation: 8, actor: actor() },
  ];

  for (const entry of cases) {
    await t.test(entry.id, async (subtest) => {
      const fixture = await sealedFixture(subtest, { id: entry.id });
      const result = await promoteDelegationArtifact({
        repoRoot: fixture.repoRoot,
        artifactId: fixture.descriptor.artifactId,
        generation: entry.generation,
        actor: entry.actor,
      });
      assert.equal(result.promoted, false);
      assert.equal(result.reason, "CAPABILITY_DENIED");
      assert.equal(readFileSync(join(fixture.repoRoot, "worker.txt"), "utf8"), "worker-before\n");
      assert.equal(readDelegationArtifact(fixture.repoRoot, fixture.descriptor.artifactId).manifest.state, "READY_FOR_REVIEW");
    });
  }
});

test("promotion detects canonical product or Git boundary drift as PROMOTION_STALE", async (t) => {
  const cases = [
    {
      id: "artifact-stale-tracked",
      mutateCanonical(root) { writeFileSync(join(root, "worker.txt"), "canonical-drift\n"); },
    },
    {
      id: "artifact-stale-untracked",
      mutateCanonical(root) { writeFileSync(join(root, "new-canonical.txt"), "canonical-untracked\n"); },
    },
    {
      id: "artifact-stale-index",
      mutateCanonical(root) {
        writeFileSync(join(root, "staged.txt"), "canonical-new-index\n");
        git(root, "add", "staged.txt");
      },
    },
    {
      id: "artifact-stale-ref",
      mutateCanonical(root) { git(root, "tag", "post-seal-tag", "HEAD"); },
    },
    {
      id: "artifact-stale-config",
      mutateCanonical(root) { git(root, "config", "orchestra.postSeal", "changed"); },
    },
  ];

  for (const entry of cases) {
    await t.test(entry.id, async (subtest) => {
      const fixture = await sealedFixture(subtest, { id: entry.id });
      entry.mutateCanonical(fixture.repoRoot);
      const result = await promoteDelegationArtifact({
        repoRoot: fixture.repoRoot,
        artifactId: fixture.descriptor.artifactId,
        generation: 7,
        actor: actor(),
      });
      assert.equal(result.promoted, false);
      assert.equal(result.reason, "PROMOTION_STALE");
      assert.equal(readDelegationArtifact(fixture.repoRoot, fixture.descriptor.artifactId).manifest.state, "READY_FOR_REVIEW");
    });
  }
});

test("promotion preserves canonical staged/unstaged/untracked baseline and applies only sealed worker delta", async (t) => {
  const fixture = await sealedFixture(t, {
    id: "artifact-promote-fidelity",
    dirtyBaseline: true,
  });
  const indexBefore = git(fixture.repoRoot, "diff", "--cached", "--binary", "--full-index", "HEAD", "--");
  const storedBefore = readDelegationArtifact(fixture.repoRoot, fixture.descriptor.artifactId);
  const expectedWorkerFact = currentFileFact(fixture.workspace.path, "worker.txt");
  assert.equal(mutationDigest([expectedWorkerFact]), fixture.descriptor.mutationDigest);

  const result = await promoteDelegationArtifact({
    repoRoot: fixture.repoRoot,
    artifactId: fixture.descriptor.artifactId,
    generation: 7,
    actor: actor(),
  });

  assert.deepEqual(result, {
    promoted: true,
    reason: null,
    changedPaths: ["worker.txt"],
  });
  assert.equal(readFileSync(join(fixture.repoRoot, "worker.txt"), "utf8"), "worker-after\n");
  assert.equal(readFileSync(join(fixture.repoRoot, "staged.txt"), "utf8"), "staged-canonical\n");
  assert.equal(readFileSync(join(fixture.repoRoot, "unstaged.txt"), "utf8"), "unstaged-canonical\n");
  assert.equal(readFileSync(join(fixture.repoRoot, "preexisting-untracked.txt"), "utf8"), "preexisting-untracked\n");
  assert.equal(git(fixture.repoRoot, "diff", "--cached", "--binary", "--full-index", "HEAD", "--"), indexBefore);
  assert.equal(mutationDigest([currentFileFact(fixture.repoRoot, "worker.txt")]), storedBefore.manifest.mutationDigest);
  assert.equal(readDelegationArtifact(fixture.repoRoot, fixture.descriptor.artifactId).manifest.state, "PROMOTED");
  assert.equal(existsSync(fixture.workspace.path), false);
  assert.equal(existsSync(join(fixture.repoRoot, ".orchestra", "state", "candidates")), false);
  assert.equal(existsSync(join(fixture.repoRoot, ".orchestra", "state", "evidence")), false);
});

test("active promotion lock denies a concurrent mutable artifact action", async (t) => {
  const fixture = await sealedFixture(t, { id: "artifact-promotion-lock" });
  const lockPath = join(fixture.repoRoot, ".orchestra", "state", "delegation", "promotion.lock");
  const held = acquireAtomicLock(lockPath, { ownerIdHash: "sha256:other-control", staleAfterMs: 60_000 });
  assert.equal(held.acquired, true);
  t.after(() => releaseAtomicLock(held.handle));

  const result = await promoteDelegationArtifact({
    repoRoot: fixture.repoRoot,
    artifactId: fixture.descriptor.artifactId,
    generation: 7,
    actor: actor(),
  });
  assert.equal(result.promoted, false);
  assert.equal(result.reason, "PROMOTION_FAILED");
  assert.equal(readDelegationArtifact(fixture.repoRoot, fixture.descriptor.artifactId).manifest.state, "READY_FOR_REVIEW");
  assert.equal(readFileSync(join(fixture.repoRoot, "worker.txt"), "utf8"), "worker-before\n");
});

test("discard is CONTROL-owned, cleans only retained clone, and terminal artifact cannot later promote", async (t) => {
  const fixture = await sealedFixture(t, { id: "artifact-discard" });
  const canonicalBefore = readWorkspaceFingerprint(fixture.repoRoot, { excludedPaths: [".orchestra/state/**"] });

  const result = await discardDelegationArtifact({
    repoRoot: fixture.repoRoot,
    artifactId: fixture.descriptor.artifactId,
    generation: 7,
    actor: actor(),
  });
  assert.deepEqual(result, { discarded: true, reason: null });
  assert.equal(existsSync(fixture.workspace.path), false);
  assert.equal(readDelegationArtifact(fixture.repoRoot, fixture.descriptor.artifactId).manifest.state, "DISCARDED");
  const canonicalAfter = readWorkspaceFingerprint(fixture.repoRoot, { excludedPaths: [".orchestra/state/**"] });
  assert.equal(canonicalAfter.fingerprint, canonicalBefore.fingerprint);

  const promoteAfterDiscard = await promoteDelegationArtifact({
    repoRoot: fixture.repoRoot,
    artifactId: fixture.descriptor.artifactId,
    generation: 7,
    actor: actor(),
  });
  assert.equal(promoteAfterDiscard.promoted, false);
  assert.equal(promoteAfterDiscard.reason, "PROMOTION_FAILED");
});

test("promotion verifies executable file mode as part of sealed mutation facts", async (t) => {
  const fixture = await sealedFixture(t, {
    id: "artifact-promote-mode",
    mutate: async ({ workspace }) => {
      writeFileSync(join(workspace.path, "worker.txt"), "#!/bin/sh\necho promoted\n");
      chmodSync(join(workspace.path, "worker.txt"), 0o755);
    },
  });

  const result = await promoteDelegationArtifact({
    repoRoot: fixture.repoRoot,
    artifactId: fixture.descriptor.artifactId,
    generation: 7,
    actor: actor(),
  });
  assert.equal(result.promoted, true);
  assert.equal((lstatSync(join(fixture.repoRoot, "worker.txt")).mode & 0o111) !== 0, true);
});
