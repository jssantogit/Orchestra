import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
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
  assert.ok(manifest.preservedProjectPaths.includes(".orchestra/state/delegations"));
});

test("delegation runtime installs, inspects cleanly, and repeated ensure is an idempotent noop", async (t) => {
  const { targetDir, builtRuntime } = await fixture(t);

  const installed = await installDelegationProjectRuntime({ targetDir, builtRuntime });
  assert.equal(installed.operation, "install");
  assert.equal(installed.metadata.runtime, "delegation");
  assert.equal(existsSync(join(targetDir, ".orchestra", "runtime", "delegation", "runtime", "delegation", "cli.mjs")), true);

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

test("delegation runtime update preserves durable delegation records and does not own provider runtime trees", async (t) => {
  const { targetDir, builtRuntime } = await fixture(t);
  await installDelegationProjectRuntime({ targetDir, builtRuntime });
  writeDelegationRecord(targetDir, completedRecord());
  const recordPath = join(targetDir, ".orchestra", "state", "delegations", "runtime-update-completed.json");
  const before = readFileSync(recordPath, "utf8");

  appendFileSync(
    join(builtRuntime, ".orchestra", "runtime", "delegation", "runtime", "delegation", "cli.mjs"),
    "\n// deterministic fixture change\n",
  );
  const updated = await updateDelegationProjectRuntime({ targetDir, builtRuntime });
  assert.equal(updated.changed, true);
  assert.equal(readFileSync(recordPath, "utf8"), before);
  assert.equal(existsSync(join(targetDir, ".codex")), false);
  assert.equal(existsSync(join(targetDir, ".agents")), false);
  assert.equal(existsSync(join(targetDir, "GEMINI.md")), false);
});

await import("./delegation-provider-integration.test.mjs");
