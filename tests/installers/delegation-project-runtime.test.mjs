import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildRuntime } from "../../runtime/runtime-builder.mjs";
import { loadRuntimeManifest } from "../../runtime/manifest-loader.mjs";
import {
  inspectDelegationProjectRuntime,
  installDelegationProjectRuntime,
  updateDelegationProjectRuntime,
} from "../../runtime/delegation/project-runtime-manager.mjs";
import { writeDelegationRecord } from "../../runtime/delegation/store.mjs";
import {
  createParallelGroup,
  transitionParallelGroupState,
} from "../../runtime/delegation/parallel-group-store.mjs";

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "orchestra-delegation-runtime-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const targetDir = join(root, "project");
  const builtRuntime = join(root, "built");
  await mkdir(targetDir, { recursive: true });
  git(targetDir, "init", "-q");
  git(targetDir, "config", "user.name", "Test");
  git(targetDir, "config", "user.email", "test@example.invalid");
  await buildRuntime({ runtime: "delegation", outputDir: builtRuntime });
  return { root, targetDir, builtRuntime };
}

function startedRecord() {
  return {
    delegationId: "runtime-update-active",
    taskId: "runtime-update-task",
    generation: 4,
    source: { provider: "codex", actorIdHash: "sha256:control" },
    target: { provider: "antigravity", logicalRole: "CRITICAL_REVIEWER" },
    purpose: "INDEPENDENT_REVIEW",
    status: "STARTED",
    startedAt: "2026-10-13T15:00:00.000Z",
    completedAt: null,
    durationMs: null,
    failureReason: null,
    workspace: {
      sourceRevision: "abcdef1234567890",
      initialFingerprint: "sha256:initial",
      finalFingerprint: null,
      dirty: false,
      dirtyFileCount: 0,
      cleaned: false,
      cleanupReason: null,
      recoverablePath: null,
    },
    evidenceRefs: [],
  };
}

function completedRecord() {
  return {
    ...startedRecord(),
    delegationId: "runtime-update-completed",
    status: "COMPLETED",
    completedAt: "2026-10-13T15:00:01.000Z",
    durationMs: 1000,
    workspace: {
      ...startedRecord().workspace,
      finalFingerprint: "sha256:final",
      cleaned: true,
    },
    evidenceRefs: ["worker:test:focused"],
  };
}

function packet(taskId, generation, file) {
  return {
    schema: "orchestra.implementation-packet.v1",
    taskId,
    candidateGeneration: generation,
    goal: `implement ${file}`,
    direction: { change: `change ${file}`, preserve: ["other shard"] },
    anchors: [{ file }],
    scope: { allowedAreas: ["src/**"], forbidden: [] },
    permissions: { discovery: "DIRECTED", tests: "READ_ONLY", sideEffects: [] },
    validation: ["focused tests"],
    failurePolicy: { selfCaused: "REPAIR", unrelatedOrUncertain: "RETURN_TO_CONTROL" },
  };
}

function parallelGroup() {
  const taskId = "runtime-parallel-task";
  const generation = 5;
  return {
    schema: "orchestra.parallel-implementation-group.v1",
    groupId: "runtime-parallel-active",
    taskId,
    generation,
    source: { provider: "codex", actorIdHash: "sha256:control" },
    sourceRevision: "abcdef1234567890",
    sourceFingerprint: "sha256:source",
    canonicalGitFingerprint: "sha256:git",
    members: [
      {
        memberId: "local",
        targetProvider: "codex",
        packet: packet(taskId, generation, "src/home.mjs"),
        mutationScope: { allowedPaths: ["src/home/**"], forbiddenPaths: [] },
      },
      {
        memberId: "external",
        targetProvider: "antigravity",
        packet: packet(taskId, generation, "src/library.mjs"),
        mutationScope: { allowedPaths: ["src/library/**"], forbiddenPaths: [] },
      },
    ],
  };
}

test("delegation manifest owns one independent project-wide neutral runtime", async () => {
  const manifest = await loadRuntimeManifest("delegation");
  const packageVersion = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version;
  assert.equal(manifest.runtime, "delegation");
  assert.equal(manifest.version, packageVersion);
  assert.ok(manifest.sourceRoots.includes("core"));
  assert.ok(manifest.sourceRoots.includes("runtime"));
  assert.ok(manifest.sourceRoots.includes("schemas"));
  assert.ok(manifest.sourceRoots.includes("providers/antigravity"));
  assert.ok(manifest.sourceRoots.includes("providers/codex"));

  const outputs = manifest.managedAssets.map((asset) => asset.output);
  assert.ok(outputs.every((output) => output === ".orchestra/runtime/delegation" || output.startsWith(".orchestra/runtime/delegation/")));
  assert.ok(outputs.includes(".orchestra/runtime/delegation/core"));
  assert.ok(outputs.includes(".orchestra/runtime/delegation/core/schemas"));
  assert.ok(outputs.includes(".orchestra/runtime/delegation/runtime/delegation"));
  assert.ok(outputs.includes(".orchestra/runtime/delegation/providers/antigravity/delegation-executor.mjs"));
  assert.ok(outputs.includes(".orchestra/runtime/delegation/providers/antigravity/model-catalog.mjs"));
  assert.ok(outputs.includes(".orchestra/runtime/delegation/providers/codex/delegation-executor.mjs"));
  assert.ok(outputs.includes(".orchestra/runtime/delegation/providers/codex/model-catalog.mjs"));
  assert.equal(outputs.some((output) => output.startsWith(".codex/") || output.startsWith(".agents/") || output === "GEMINI.md"), false);
  assert.equal(outputs.some((output) => output.includes("/providers/codex/adapter/") || output.includes("/providers/antigravity/adapter/")), false);
  assert.ok(manifest.entrypoints.includes(".orchestra/runtime/delegation/runtime/delegation/cli.mjs"));
  assert.ok(manifest.entrypoints.includes(".orchestra/runtime/delegation/runtime/delegation/artifact-cli.mjs"));
  assert.ok(manifest.entrypoints.includes(".orchestra/runtime/delegation/runtime/delegation/parallel-cli.mjs"));
  assert.ok(manifest.preservedProjectPaths.includes(".orchestra/state/delegations"));
  assert.ok(manifest.preservedProjectPaths.includes(".orchestra/state/delegation/artifacts"));
  assert.ok(manifest.preservedProjectPaths.includes(".orchestra/state/delegation/parallel-groups"));
  assert.ok(manifest.preservedProjectPaths.includes(".orchestra/state/delegation/composite-artifacts"));
});

test("delegation runtime installs, inspects cleanly, and repeated ensure is an idempotent noop", async (t) => {
  const { targetDir, builtRuntime } = await fixture(t);

  const installed = await installDelegationProjectRuntime({ targetDir, builtRuntime });
  assert.equal(installed.operation, "install");
  assert.equal(installed.metadata.runtime, "delegation");
  assert.equal(existsSync(join(targetDir, ".orchestra", "runtime", "delegation", "runtime", "delegation", "cli.mjs")), true);
  assert.equal(existsSync(join(targetDir, ".orchestra", "runtime", "delegation", "runtime", "delegation", "artifact-cli.mjs")), true);
  assert.equal(existsSync(join(targetDir, ".orchestra", "runtime", "delegation", "runtime", "delegation", "parallel-cli.mjs")), true);

  const inspection = await inspectDelegationProjectRuntime({ targetDir, builtRuntime });
  assert.equal(inspection.clean, true);
  assert.equal(inspection.metadataCurrent, true);

  const second = await updateDelegationProjectRuntime({ targetDir, builtRuntime });
  assert.equal(second.operation, "noop");
  assert.equal(second.changed, false);
  assert.equal(git(targetDir, "status", "--short", "--", ".orchestra/state"), "");
});

test("delegation runtime update fails closed while any delegation record is in flight", async (t) => {
  const { targetDir, builtRuntime } = await fixture(t);
  await installDelegationProjectRuntime({ targetDir, builtRuntime });
  writeDelegationRecord(targetDir, startedRecord());

  appendFileSync(
    join(builtRuntime, ".orchestra", "runtime", "delegation", "runtime", "delegation", "cli.mjs"),
    "\n// changed build for quiescence test\n",
  );

  await assert.rejects(
    () => updateDelegationProjectRuntime({ targetDir, builtRuntime }),
    (error) => error?.code === "RUNTIME_NOT_QUIESCENT"
      && error?.quiescence?.reason === "DELEGATION_IN_FLIGHT",
  );

  assert.equal(readFileSync(
    join(targetDir, ".orchestra", "runtime", "delegation", "runtime", "delegation", "cli.mjs"),
    "utf8",
  ).includes("changed build for quiescence test"), false);
});

test("delegation runtime update fails closed while a parallel implementation group is active", async (t) => {
  const { targetDir, builtRuntime } = await fixture(t);
  await installDelegationProjectRuntime({ targetDir, builtRuntime });
  const group = parallelGroup();
  createParallelGroup(targetDir, group);
  const started = transitionParallelGroupState(targetDir, group.groupId, {
    expectedState: "CREATED",
    nextState: "RUNNING",
  });
  assert.equal(started.transitioned, true);

  appendFileSync(
    join(builtRuntime, ".orchestra", "runtime", "delegation", "runtime", "delegation", "cli.mjs"),
    "\n// changed build for parallel quiescence test\n",
  );

  await assert.rejects(
    () => updateDelegationProjectRuntime({ targetDir, builtRuntime }),
    (error) => error?.code === "RUNTIME_NOT_QUIESCENT"
      && error?.quiescence?.reason === "DELEGATION_IN_FLIGHT",
  );
});

test("delegation runtime update preserves durable delegation, parallel group, and composite artifact state", async (t) => {
  const { targetDir, builtRuntime } = await fixture(t);
  await installDelegationProjectRuntime({ targetDir, builtRuntime });
  writeDelegationRecord(targetDir, completedRecord());
  const recordPath = join(targetDir, ".orchestra", "state", "delegations", "runtime-update-completed.json");
  const before = readFileSync(recordPath, "utf8");

  const artifactDir = join(targetDir, ".orchestra", "state", "delegation", "artifacts", "sealed-fixture");
  await mkdir(artifactDir, { recursive: true });
  const artifactManifestPath = join(artifactDir, "manifest.json");
  const artifactPatchPath = join(artifactDir, "candidate.patch");
  writeFileSync(artifactManifestPath, "{\"state\":\"READY_FOR_REVIEW\"}\n", "utf8");
  writeFileSync(artifactPatchPath, "sealed patch fixture\n", "utf8");

  const group = { ...parallelGroup(), groupId: "sealed-group" };
  createParallelGroup(targetDir, group);
  assert.equal(transitionParallelGroupState(targetDir, group.groupId, {
    expectedState: "CREATED",
    nextState: "RUNNING",
  }).transitioned, true);
  assert.equal(transitionParallelGroupState(targetDir, group.groupId, {
    expectedState: "RUNNING",
    nextState: "MEMBERS_READY",
    memberArtifactIds: ["sealed-member-local", "sealed-member-external"],
  }).transitioned, true);
  assert.equal(transitionParallelGroupState(targetDir, group.groupId, {
    expectedState: "MEMBERS_READY",
    nextState: "COMPOSING",
  }).transitioned, true);
  assert.equal(transitionParallelGroupState(targetDir, group.groupId, {
    expectedState: "COMPOSING",
    nextState: "READY_FOR_REVIEW",
    compositeArtifactId: "sealed-composite",
  }).transitioned, true);
  const groupPath = join(targetDir, ".orchestra", "state", "delegation", "parallel-groups", "sealed-group", "group.json");
  const groupBefore = readFileSync(groupPath, "utf8");

  const compositeDir = join(targetDir, ".orchestra", "state", "delegation", "composite-artifacts", "sealed-composite");
  await mkdir(compositeDir, { recursive: true });
  const compositeManifestPath = join(compositeDir, "manifest.json");
  const compositePatchPath = join(compositeDir, "candidate.patch");
  writeFileSync(compositeManifestPath, "{\"state\":\"READY_FOR_REVIEW\"}\n", "utf8");
  writeFileSync(compositePatchPath, "composite patch fixture\n", "utf8");

  appendFileSync(
    join(builtRuntime, ".orchestra", "runtime", "delegation", "runtime", "delegation", "cli.mjs"),
    "\n// deterministic fixture change\n",
  );
  const updated = await updateDelegationProjectRuntime({ targetDir, builtRuntime });
  assert.equal(updated.changed, true);
  assert.equal(readFileSync(recordPath, "utf8"), before);
  assert.equal(readFileSync(artifactManifestPath, "utf8"), "{\"state\":\"READY_FOR_REVIEW\"}\n");
  assert.equal(readFileSync(artifactPatchPath, "utf8"), "sealed patch fixture\n");
  assert.equal(readFileSync(groupPath, "utf8"), groupBefore);
  assert.equal(readFileSync(compositeManifestPath, "utf8"), "{\"state\":\"READY_FOR_REVIEW\"}\n");
  assert.equal(readFileSync(compositePatchPath, "utf8"), "composite patch fixture\n");
  assert.equal(existsSync(join(targetDir, ".codex")), false);
  assert.equal(existsSync(join(targetDir, ".agents")), false);
  assert.equal(existsSync(join(targetDir, "GEMINI.md")), false);
});

await import("./delegation-provider-integration.test.mjs");
