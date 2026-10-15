import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { normalizeMutationScope } from "../../core/delegation/mutation-scope.mjs";
import { readWorkspaceFingerprint } from "../../core/leases/workspace-fingerprint.mjs";
import {
  deriveMutationFacts,
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
  }).trim();
}

function createRepo() {
  const root = mkdtempSync(join(tmpdir(), "orchestra-artifact-source-"));
  git(root, "init");
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "user.name", "Orchestra Test");
  writeFileSync(join(root, "edit.txt"), "before\n");
  writeFileSync(join(root, "delete.txt"), "delete me\n");
  writeFileSync(join(root, "mode.sh"), "#!/bin/sh\necho before\n");
  git(root, "add", ".");
  git(root, "commit", "-m", "initial");
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
      goal: "produce one sealed worker mutation",
      direction: { change: "edit authorized files", preserve: ["CONTROL authority"] },
      anchors: [{ file: "edit.txt" }],
      scope: { allowedAreas: allowedPaths, forbidden: [".git/**", ".orchestra/state/**"] },
      permissions: { discovery: "DIRECTED", tests: "MODIFY_AUTHORIZED_TARGETS", sideEffects: ["WORKSPACE_EDIT"] },
      validation: ["sealed patch is factual"],
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

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function prepared(t, repoRoot, request) {
  const baseDir = mkdtempSync(join(tmpdir(), "orchestra-artifact-workspace-"));
  t.after(() => rmSync(baseDir, { recursive: true, force: true }));
  const workspace = await prepareMutableDelegationWorkspace({ repoRoot, request, baseDir });
  t.after(async () => { await cleanupMutableDelegationWorkspace(workspace); });
  return workspace;
}

test("mutation facts and sealed patch are derived from filesystem reality, including binary, mode, symlink, and deletion", async (t) => {
  const repoRoot = createRepo();
  t.after(() => rmSync(repoRoot, { recursive: true, force: true }));
  const request = requestFor(repoRoot, "artifact-factual");
  const workspace = await prepared(t, repoRoot, request);

  writeFileSync(join(workspace.path, "edit.txt"), "after\n");
  unlinkSync(join(workspace.path, "delete.txt"));
  writeFileSync(join(workspace.path, "binary.bin"), Buffer.from([0, 1, 2, 3, 0, 255]));
  chmodSync(join(workspace.path, "mode.sh"), 0o755);
  symlinkSync("edit.txt", join(workspace.path, "link-new"));

  const scope = normalizeMutationScope(request.workspace.mutationScope);
  const derived = await deriveMutationFacts({
    workspacePath: workspace.path,
    baselineSha: workspace.syntheticBaselineSha,
    scope,
  });
  assert.deepEqual(derived.changedPaths, ["binary.bin", "delete.txt", "edit.txt", "link-new", "mode.sh"]);
  assert.equal(derived.facts.find((fact) => fact.path === "delete.txt").kind, "DELETED");
  assert.equal(derived.facts.find((fact) => fact.path === "link-new").kind, "SYMLINK");
  assert.equal(derived.facts.find((fact) => fact.path === "mode.sh").mode, "100755");
  assert.equal(typeof derived.mutationDigest, "string");

  const descriptor = await sealDelegationArtifact({
    repoRoot,
    request,
    generation: 7,
    actor: { provider: "provider-a", actorIdHash: "sha256:source" },
    workspace,
    report: {
      summary: "worker claim",
      findings: [],
      evidenceRefs: [],
      changedPaths: ["fake-from-model.txt"],
      patchSha256: "fake-from-model",
    },
  });
  assert.deepEqual(descriptor.changedPaths, derived.changedPaths);
  assert.equal(descriptor.mutationDigest, derived.mutationDigest);
  assert.equal(descriptor.state, "READY_FOR_REVIEW");

  const stored = readDelegationArtifact(repoRoot, descriptor.artifactId);
  assert.equal(stored.valid, true);
  assert.deepEqual(stored.manifest.changedPaths, derived.changedPaths);
  assert.equal(stored.manifest.mutationDigest, derived.mutationDigest);
  assert.equal(stored.manifest.patchSha256, `sha256:${sha256(stored.patch)}`);
  assert.equal(stored.patch.toString("utf8").includes("GIT binary patch"), true);
  assert.equal("report" in stored.manifest, false);
  assert.equal("workerReport" in stored.manifest, false);
  assert.equal(stored.patch.toString("utf8").includes("fake-from-model.txt"), false);
});

test("synthetic baseline keeps pre-existing canonical dirty state out of the worker patch", async (t) => {
  const repoRoot = createRepo();
  t.after(() => rmSync(repoRoot, { recursive: true, force: true }));
  writeFileSync(join(repoRoot, "edit.txt"), "pre-existing canonical dirty\n");
  writeFileSync(join(repoRoot, "preexisting.txt"), "pre-existing untracked\n");
  const request = requestFor(repoRoot, "artifact-dirty-source", ["edit.txt", "worker-only.txt"]);
  const workspace = await prepared(t, repoRoot, request);
  writeFileSync(join(workspace.path, "worker-only.txt"), "worker delta\n");

  const descriptor = await sealDelegationArtifact({
    repoRoot,
    request,
    generation: 7,
    actor: { provider: "provider-a", actorIdHash: "sha256:source" },
    workspace,
    report: { summary: "done", findings: [], evidenceRefs: [] },
  });
  const stored = readDelegationArtifact(repoRoot, descriptor.artifactId);
  const patch = stored.patch.toString("utf8");
  assert.equal(patch.includes("worker-only.txt"), true);
  assert.equal(patch.includes("preexisting.txt"), false);
  assert.equal(patch.includes("pre-existing canonical dirty"), false);
});

test("artifact sealing ignores parent global Git clean filters", async (t) => {
  const repoRoot = createRepo();
  t.after(() => rmSync(repoRoot, { recursive: true, force: true }));
  writeFileSync(join(repoRoot, ".gitattributes"), "edit.txt filter=orchestra-poison\n");
  git(repoRoot, "add", ".gitattributes");
  git(repoRoot, "commit", "-m", "add filter attribute");

  const request = requestFor(repoRoot, "artifact-parent-git-config", ["edit.txt"]);
  const workspace = await prepared(t, repoRoot, request);
  writeFileSync(join(workspace.path, "edit.txt"), "after\n");

  const scratch = mkdtempSync(join(tmpdir(), "orchestra-artifact-parent-git-"));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const configPath = join(scratch, "global.gitconfig");
  const filterPath = join(scratch, "clean-filter.mjs");
  const markerPath = join(scratch, "filter-ran.txt");
  writeFileSync(filterPath, [
    'import { writeFileSync } from "node:fs";',
    'writeFileSync(process.env.ORCHESTRA_TEST_FILTER_MARKER, "ran\\n");',
    "process.stdin.pipe(process.stdout);",
    "",
  ].join("\n"));
  git(
    scratch,
    "config",
    "--file",
    configPath,
    "filter.orchestra-poison.clean",
    `node "${filterPath.replaceAll("\\", "/")}"`,
  );

  const previousGlobal = process.env.GIT_CONFIG_GLOBAL;
  const previousMarker = process.env.ORCHESTRA_TEST_FILTER_MARKER;
  process.env.GIT_CONFIG_GLOBAL = configPath;
  process.env.ORCHESTRA_TEST_FILTER_MARKER = markerPath;
  let descriptor;
  try {
    descriptor = await sealDelegationArtifact({
      repoRoot,
      request,
      generation: 7,
      actor: { provider: "provider-a", actorIdHash: "sha256:source" },
      workspace,
      report: { summary: "done", findings: [], evidenceRefs: [] },
    });
  } finally {
    if (previousGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = previousGlobal;
    if (previousMarker === undefined) delete process.env.ORCHESTRA_TEST_FILTER_MARKER;
    else process.env.ORCHESTRA_TEST_FILTER_MARKER = previousMarker;
  }

  assert.equal(existsSync(markerPath), false);
  const stored = readDelegationArtifact(repoRoot, descriptor.artifactId);
  assert.equal(stored.valid, true);
  assert.match(stored.patch.toString("utf8"), /\+after/);
});

test("scope, symlink egress, worker staging, and clone git mutation fail closed without an artifact", async (t) => {
  const cases = [
    {
      id: "artifact-outside-scope",
      allowed: ["edit.txt"],
      mutate(workspace) { writeFileSync(join(workspace.path, "outside.txt"), "forbidden\n"); },
    },
    {
      id: "artifact-symlink-egress",
      allowed: ["escape-link"],
      mutate(workspace, repoRoot) { symlinkSync(repoRoot, join(workspace.path, "escape-link")); },
    },
    {
      id: "artifact-worker-staged",
      allowed: ["edit.txt"],
      mutate(workspace) {
        writeFileSync(join(workspace.path, "edit.txt"), "worker edit\n");
        git(workspace.path, "add", "edit.txt");
      },
    },
    {
      id: "artifact-clone-ref",
      allowed: ["edit.txt"],
      mutate(workspace) {
        writeFileSync(join(workspace.path, "edit.txt"), "worker edit\n");
        git(workspace.path, "tag", "worker-tag", "HEAD");
      },
    },
  ];

  for (const entry of cases) {
    const repoRoot = createRepo();
    const request = requestFor(repoRoot, entry.id, entry.allowed);
    const workspace = await prepared(t, repoRoot, request);
    entry.mutate(workspace, repoRoot);

    await assert.rejects(
      sealDelegationArtifact({
        repoRoot,
        request,
        generation: 7,
        actor: { provider: "provider-a", actorIdHash: "sha256:source" },
        workspace,
        report: { summary: "claim", findings: [], evidenceRefs: [] },
      }),
      (error) => error?.code === "SCOPE_VIOLATION",
      entry.id,
    );
    assert.equal(readDelegationArtifact(repoRoot, entry.id).exists, false, entry.id);
    rmSync(repoRoot, { recursive: true, force: true });
  }
});
