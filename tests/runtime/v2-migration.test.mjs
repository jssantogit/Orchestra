import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, readdir, lstat, rm, symlink } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { tmpdir } from "node:os";

import { inventoryLegacyProject } from "../../v2/migration/inventory.mjs";
import {
  MIGRATION_DISPOSITIONS,
  classifyLegacyInventoryEntry,
} from "../../v2/migration/transient-classifier.mjs";

async function withWorkspace(run) {
  const root = await mkdtemp(join(tmpdir(), "orchestra-v2-migration-inventory-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function writeJson(path, value) {
  await mkdir(path.slice(0, path.lastIndexOf(sep)), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function snapshotTree(root) {
  const rows = [];
  async function walk(dir) {
    for (const name of (await readdir(dir)).sort()) {
      const absolute = join(dir, name);
      const stat = await lstat(absolute);
      const path = relative(root, absolute).split(sep).join("/");
      if (stat.isSymbolicLink()) {
        rows.push({ path, type: "symlink" });
      } else if (stat.isDirectory()) {
        rows.push({ path, type: "directory" });
        await walk(absolute);
      } else {
        rows.push({ path, type: "file", content: await readFile(absolute, "utf8") });
      }
    }
  }
  await walk(root);
  return rows;
}

function parallelGroupRecord(overrides = {}) {
  return {
    schema: "orchestra.parallel-group-state.v1",
    group: { groupId: "migration-group-1" },
    state: "RUNNING",
    memberArtifactIds: [],
    compositeArtifactId: null,
    failureReason: null,
    cleanupFailures: [],
    createdAt: "2026-10-16T15:27:58.440Z",
    updatedAt: "2026-10-16T15:27:58.446Z",
    ...overrides,
  };
}

function entry(overrides = {}) {
  return {
    path: ".orchestra/state/candidates/task-1/candidate.json",
    category: "DURABLE_LEGACY_STATE",
    schema: "orchestra.candidate.v1",
    version: 1,
    digest: `sha256:${"a".repeat(64)}`,
    integrity: "PARSED",
    dispositionBasis: "DURABLE_STATE",
    private: false,
    ...overrides,
  };
}

test("legacy inventory is read-only and does not create Orchestra state in an empty workspace", async () => {
  await withWorkspace(async (workspace) => {
    await writeFile(join(workspace, "README.md"), "user file\n", "utf8");
    const before = await snapshotTree(workspace);
    const result = await inventoryLegacyProject({ workspace });
    const after = await snapshotTree(workspace);

    assert.equal(result.ok, true);
    assert.deepEqual(result.entries, []);
    assert.deepEqual(result.issues, []);
    assert.deepEqual(after, before);
  });
});

test("known parallel-group state records path, schema/version, digest, category and disposition basis", async () => {
  await withWorkspace(async (workspace) => {
    const statePath = join(
      workspace,
      ".orchestra", "state", "delegation", "parallel-groups", "migration-group-1", "group.json",
    );
    await writeJson(statePath, parallelGroupRecord());

    const result = await inventoryLegacyProject({ workspace });
    assert.equal(result.ok, true);
    assert.equal(result.entries.length, 1);
    const [entryRecord] = result.entries;
    assert.deepEqual({
      path: entryRecord.path,
      category: entryRecord.category,
      schema: entryRecord.schema,
      version: entryRecord.version,
      integrity: entryRecord.integrity,
      dispositionBasis: entryRecord.dispositionBasis,
      private: entryRecord.private,
    }, {
      path: ".orchestra/state/delegation/parallel-groups/migration-group-1/group.json",
      category: "TRANSIENT_PARALLEL_GROUP",
      schema: "orchestra.parallel-group-state.v1",
      version: 1,
      integrity: "PARSED",
      dispositionBasis: "TRANSIENT_STATE",
      private: false,
    });
    assert.match(entryRecord.digest, /^sha256:[0-9a-f]{64}$/);
  });
});

test("unknown files are never claimed as Orchestra-managed by path proximity alone", async () => {
  await withWorkspace(async (workspace) => {
    await mkdir(join(workspace, ".orchestra", "state", "delegation", "parallel-groups"), { recursive: true });
    await writeFile(join(workspace, ".orchestra", "state", "notes.txt"), "user notes\n", "utf8");
    await writeFile(join(workspace, ".orchestra", "state", "delegation", "parallel-groups", "README.txt"), "not managed\n", "utf8");
    await writeFile(join(workspace, ".agents", "personal.txt"), "user-owned\n", { encoding: "utf8", flag: "w" }).catch(async () => {
      await mkdir(join(workspace, ".agents"), { recursive: true });
      await writeFile(join(workspace, ".agents", "personal.txt"), "user-owned\n", "utf8");
    });

    const result = await inventoryLegacyProject({ workspace });
    assert.equal(result.ok, true);
    assert.deepEqual(result.entries, []);
    assert.deepEqual(result.issues, []);
  });
});

test("malformed managed JSON is reported factually and never normalized into healthy state", async () => {
  await withWorkspace(async (workspace) => {
    const statePath = join(
      workspace,
      ".orchestra", "state", "delegation", "parallel-groups", "broken", "group.json",
    );
    await mkdir(join(workspace, ".orchestra", "state", "delegation", "parallel-groups", "broken"), { recursive: true });
    await writeFile(statePath, "{ not-json\n", "utf8");

    const result = await inventoryLegacyProject({ workspace });
    assert.equal(result.ok, true);
    assert.equal(result.entries.length, 1);
    assert.deepEqual({
      path: result.entries[0].path,
      category: result.entries[0].category,
      schema: result.entries[0].schema,
      version: result.entries[0].version,
      integrity: result.entries[0].integrity,
      dispositionBasis: result.entries[0].dispositionBasis,
    }, {
      path: ".orchestra/state/delegation/parallel-groups/broken/group.json",
      category: "TRANSIENT_PARALLEL_GROUP",
      schema: null,
      version: null,
      integrity: "MALFORMED_JSON",
      dispositionBasis: "UNSUPPORTED_OR_MALFORMED",
    });
    assert.match(result.entries[0].digest, /^sha256:[0-9a-f]{64}$/);
    assert.equal(await readFile(statePath, "utf8"), "{ not-json\n");
  });
});

test("recognized private delegation artifacts are inventory-only private archive candidates", async () => {
  await withWorkspace(async (workspace) => {
    const artifact = join(workspace, ".orchestra", "state", "delegation", "artifacts", "artifact-1", "result.json");
    await writeJson(artifact, {
      schema: "orchestra.delegation-artifact.v1",
      prompt: "private project prompt",
      source: "private source bytes",
    });

    const result = await inventoryLegacyProject({ workspace });
    assert.equal(result.ok, true);
    assert.equal(result.entries.length, 1);
    assert.equal(result.entries[0].category, "PRIVATE_PROJECT_ARTIFACT");
    assert.equal(result.entries[0].dispositionBasis, "PRIVATE_ARCHIVE");
    assert.equal(result.entries[0].private, true);
    assert.equal("content" in result.entries[0], false);
    assert.equal("record" in result.entries[0], false);
  });
});

test("provider-managed runtime files are inventoried by exact known managed paths, not whole provider directories", async () => {
  await withWorkspace(async (workspace) => {
    const managed = join(workspace, ".codex", "astra-orchestra", "runtime", "orchestra-v2-runtime.json");
    await writeJson(managed, {
      schema: "orchestra.runtime-manifest.v1",
      version: 1,
      provider: "codex",
    });
    await writeFile(join(workspace, ".codex", "notes.txt"), "user data\n", "utf8");

    const result = await inventoryLegacyProject({ workspace });
    assert.equal(result.ok, true);
    assert.equal(result.entries.length, 1);
    assert.equal(result.entries[0].path, ".codex/astra-orchestra/runtime/orchestra-v2-runtime.json");
    assert.equal(result.entries[0].category, "MANAGED_RUNTIME");
    assert.equal(result.entries[0].dispositionBasis, "MANAGED_RUNTIME_COPY");
  });
});

test("symlink or junction egress under a managed state root is blocked without reading outside project root", async () => {
  const outer = await mkdtemp(join(tmpdir(), "orchestra-v2-migration-egress-"));
  try {
    await withWorkspace(async (workspace) => {
      const outsideGroup = join(outer, "outside-group");
      await mkdir(outsideGroup, { recursive: true });
      await writeJson(join(outsideGroup, "group.json"), parallelGroupRecord({ group: { groupId: "outside" } }));

      const groups = join(workspace, ".orchestra", "state", "delegation", "parallel-groups");
      await mkdir(groups, { recursive: true });
      const link = join(groups, "escape");
      await symlink(outsideGroup, link, process.platform === "win32" ? "junction" : "dir");

      const result = await inventoryLegacyProject({ workspace });
      assert.equal(result.ok, false);
      assert.equal(result.entries.some((item) => item.path.endsWith("escape/group.json")), false);
      assert.ok(result.issues.some((issue) => issue.code === "MIGRATION_PATH_ESCAPE_BLOCKED" && issue.path.endsWith("escape")));
      assert.equal(await readFile(join(outsideGroup, "group.json"), "utf8").then((text) => text.includes("outside")), true);
    });
  } finally {
    await rm(outer, { recursive: true, force: true });
  }
});

test("migration classifier exposes exactly the four approved dispositions", () => {
  assert.deepEqual(MIGRATION_DISPOSITIONS, [
    "CLEAN_IMPORT",
    "RECOVERABLE_IMPORT",
    "PRIVATE_ARCHIVE",
    "UNSUPPORTED_BLOCKED",
  ]);
});

test("recognized durable fact with complete provenance classifies CLEAN_IMPORT", () => {
  const result = classifyLegacyInventoryEntry({
    entry: entry(),
    facts: { provenanceComplete: true, unresolvedTransientAuthority: false },
  });
  assert.equal(result.ok, true);
  assert.equal(result.disposition, "CLEAN_IMPORT");
  assert.equal(result.blocksActivation, false);
  assert.equal(result.authorityClaim, false);
});

test("recognized transient RUNNING fact remains RECOVERABLE_IMPORT and never claims liveness or success", () => {
  const result = classifyLegacyInventoryEntry({
    entry: entry({
      path: ".orchestra/state/delegation/parallel-groups/group-1/group.json",
      category: "TRANSIENT_PARALLEL_GROUP",
      schema: "orchestra.parallel-group-state.v1",
      dispositionBasis: "TRANSIENT_STATE",
    }),
    facts: {
      persistedState: "RUNNING",
      ownerProcessProof: "ABSENT",
      survivingWorkspaces: 1,
      canonicalPromotion: false,
      runtimeVersion: "v1.4.2",
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.disposition, "RECOVERABLE_IMPORT");
  assert.equal(result.authorityClaim, false);
  assert.equal(result.reconciliation.liveness, "UNKNOWN");
  assert.equal(result.reconciliation.successClaim, false);
  assert.equal(result.reconciliation.eligible, true);
  assert.equal(result.reconciliation.cleanupAuthorized, false);
});

test("recognized private artifact classifies PRIVATE_ARCHIVE and cannot become authority", () => {
  const result = classifyLegacyInventoryEntry({
    entry: entry({
      path: ".orchestra/state/delegation/artifacts/artifact-1/result.json",
      category: "PRIVATE_PROJECT_ARTIFACT",
      schema: "orchestra.delegation-artifact.v1",
      dispositionBasis: "PRIVATE_ARCHIVE",
      private: true,
    }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.disposition, "PRIVATE_ARCHIVE");
  assert.equal(result.authorityClaim, false);
  assert.equal(result.blocksActivation, false);
});

test("malformed, unsupported-version, or incomplete-provenance records fail closed", () => {
  const malformed = classifyLegacyInventoryEntry({
    entry: entry({ integrity: "MALFORMED_JSON", schema: null, version: null, dispositionBasis: "UNSUPPORTED_OR_MALFORMED" }),
  });
  const unsupported = classifyLegacyInventoryEntry({
    entry: entry({ schema: "orchestra.candidate.v9", version: 9 }),
    facts: { provenanceComplete: true, unresolvedTransientAuthority: false },
  });
  const provenanceMissing = classifyLegacyInventoryEntry({
    entry: entry(),
    facts: { provenanceComplete: false, unresolvedTransientAuthority: false },
  });
  for (const result of [malformed, unsupported, provenanceMissing]) {
    assert.equal(result.ok, true);
    assert.equal(result.disposition, "UNSUPPORTED_BLOCKED");
    assert.equal(result.blocksActivation, true);
    assert.equal(result.authorityClaim, false);
  }
});

const nodeMajor = Number(process.versions.node.split(".")[0]);
const v2Only = { skip: nodeMajor < 24 };

async function initGit(workspace) {
  const { execFileSync } = await import("node:child_process");
  execFileSync("git", ["init", workspace], { stdio: "ignore" });
}

function captureStream() {
  let body = "";
  return {
    stream: { write(chunk) { body += String(chunk); } },
    json() { return body.trim() ? JSON.parse(body.trim()) : null; },
    text() { return body; },
  };
}

async function runMigrationCli({ argv, cwd, env = {} }) {
  const { runGlobalCli } = await import("../../v2/global/cli.mjs");
  const stdout = captureStream();
  const stderr = captureStream();
  const exitCode = await runGlobalCli({
    argv,
    cwd,
    env,
    stdout: stdout.stream,
    stderr: stderr.stream,
  });
  return { exitCode, stdout: stdout.json(), stderr: stderr.json(), stderrText: stderr.text() };
}

async function writePrivateArtifact(workspace, id, text = "private project bytes") {
  const artifact = join(workspace, ".orchestra", "state", "delegation", "artifacts", id, "result.json");
  await writeJson(artifact, {
    schema: "orchestra.delegation-artifact.v1",
    prompt: text,
    source: `${text}-source`,
  });
  return artifact;
}

test("migration inspect CLI is read-only and does not create global registry state", v2Only, async () => {
  await withWorkspace(async (workspace) => {
    await initGit(workspace);
    await writePrivateArtifact(workspace, "inspect-only");
    const home = join(workspace, "global-home-must-not-exist");
    const before = await snapshotTree(workspace);

    const result = await runMigrationCli({
      argv: ["project", "migrate", "inspect", workspace, "--home", home],
      cwd: workspace,
      env: {},
    });

    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout.ok, true);
    assert.equal(result.stdout.code, "MIGRATION_INSPECTION_READY");
    assert.equal(result.stdout.inventory.length, 1);
    assert.equal(result.stdout.classifications[0].disposition, "PRIVATE_ARCHIVE");
    await assert.rejects(lstat(home), { code: "ENOENT" });
    assert.deepEqual(await snapshotTree(workspace), before);
  });
});

test("migration apply refuses UNSUPPORTED_BLOCKED inventory before creating global authority", v2Only, async () => {
  await withWorkspace(async (workspace) => {
    await initGit(workspace);
    const broken = join(workspace, ".orchestra", "state", "delegation", "parallel-groups", "broken", "group.json");
    await mkdir(join(workspace, ".orchestra", "state", "delegation", "parallel-groups", "broken"), { recursive: true });
    await writeFile(broken, "{ broken\n", "utf8");
    const home = join(workspace, "global-home-blocked");

    const result = await runMigrationCli({
      argv: ["project", "migrate", "apply", workspace, "--command-id", "blocked-apply", "--home", home],
      cwd: workspace,
      env: {},
    });

    assert.equal(result.exitCode, 1);
    assert.equal(result.stdout.ok, false);
    assert.equal(result.stdout.code, "MIGRATION_BLOCKED");
    assert.equal(result.stdout.classifications[0].disposition, "UNSUPPORTED_BLOCKED");
    await assert.rejects(lstat(home), { code: "ENOENT" });
  });
});

test("migration apply records sanitized manifest and replays idempotently", v2Only, async () => {
  await withWorkspace(async (workspace) => {
    await initGit(workspace);
    const artifact = await writePrivateArtifact(workspace, "manifest", "private-do-not-inline");
    const original = await readFile(artifact, "utf8");
    const home = join(workspace, "global-home-apply");
    const argv = ["project", "migrate", "apply", workspace, "--command-id", "apply-once", "--home", home];

    const first = await runMigrationCli({ argv, cwd: workspace, env: {} });
    const replay = await runMigrationCli({ argv, cwd: workspace, env: {} });

    assert.equal(first.exitCode, 0);
    assert.equal(first.stdout.ok, true);
    assert.equal(first.stdout.manifest.schema, "orchestra.migration-manifest.v2");
    assert.equal(first.stdout.manifest.status, "IMPORTED");
    assert.equal(first.stdout.manifest.inventory.length, 1);
    assert.equal(first.stdout.manifest.inventory[0].disposition, "PRIVATE_ARCHIVE");
    assert.match(first.stdout.manifest.inventory[0].digest, /^sha256:[0-9a-f]{64}$/);
    assert.equal(JSON.stringify(first.stdout.manifest).includes("private-do-not-inline"), false);
    assert.equal(replay.exitCode, 0);
    assert.equal(replay.stdout.replayed, true);
    assert.equal(replay.stdout.project.projectId, first.stdout.project.projectId);
    assert.equal(replay.stdout.manifest.projectId, first.stdout.manifest.projectId);
    assert.equal(await readFile(artifact, "utf8"), original);
  });
});

test("migration rollback preserves imported audit history and private project data", v2Only, async () => {
  await withWorkspace(async (workspace) => {
    await initGit(workspace);
    const artifact = await writePrivateArtifact(workspace, "rollback", "private-survives-rollback");
    const original = await readFile(artifact, "utf8");
    const home = join(workspace, "global-home-rollback");
    const applied = await runMigrationCli({
      argv: ["project", "migrate", "apply", workspace, "--command-id", "apply-before-rollback", "--home", home],
      cwd: workspace,
      env: {},
    });
    assert.equal(applied.exitCode, 0);

    const rolled = await runMigrationCli({
      argv: ["project", "migrate", "rollback", applied.stdout.project.projectId, "--command-id", "rollback-1", "--home", home],
      cwd: workspace,
      env: {},
    });

    assert.equal(rolled.exitCode, 0);
    assert.equal(rolled.stdout.ok, true);
    assert.equal(rolled.stdout.manifest.status, "ROLLED_BACK");
    assert.equal(rolled.stdout.manifest.active, false);
    assert.equal(rolled.stdout.manifest.inventory[0].disposition, "PRIVATE_ARCHIVE");
    assert.equal(await readFile(artifact, "utf8"), original);
  });
});

test("same migration command id is project-scoped and cannot replay another Project", v2Only, async () => {
  await withWorkspace(async (root) => {
    const projectA = join(root, "project-a");
    const projectB = join(root, "project-b");
    await mkdir(projectA, { recursive: true });
    await mkdir(projectB, { recursive: true });
    await initGit(projectA);
    await initGit(projectB);
    await writePrivateArtifact(projectA, "a", "private-a");
    await writePrivateArtifact(projectB, "b", "private-b");
    const home = join(root, "global-home-cross-project");

    const a = await runMigrationCli({
      argv: ["project", "migrate", "apply", projectA, "--command-id", "shared-command", "--home", home],
      cwd: projectA,
      env: {},
    });
    const b = await runMigrationCli({
      argv: ["project", "migrate", "apply", projectB, "--command-id", "shared-command", "--home", home],
      cwd: projectB,
      env: {},
    });

    assert.equal(a.exitCode, 0);
    assert.equal(b.exitCode, 0);
    assert.notEqual(a.stdout.project.projectId, b.stdout.project.projectId);
    assert.equal(b.stdout.replayed, false);
    assert.equal(a.stdout.manifest.commands[0].commandId, "shared-command");
    assert.equal(b.stdout.manifest.commands[0].commandId, "shared-command");
  });
});

async function prepareManagedMigration(root, name = "managed-project") {
  const workspace = join(root, name);
  await mkdir(workspace, { recursive: true });
  await initGit(workspace);
  const legacyRuntime = join(workspace, ".codex", "astra-orchestra", "runtime", "orchestra-v2-runtime.json");
  await writeJson(legacyRuntime, {
    schema: "orchestra.runtime-manifest.v1",
    version: 1,
    provider: "codex",
  });
  const home = join(root, `${name}-global-home`);
  const applied = await runMigrationCli({
    argv: ["project", "migrate", "apply", workspace, "--command-id", `apply-${name}`, "--home", home],
    cwd: workspace,
    env: {},
  });
  assert.equal(applied.exitCode, 0);
  assert.equal(applied.stdout.ok, true);
  return { workspace, home, legacyRuntime, applied };
}

function verifiedV2Result(overrides = {}) {
  return {
    ok: true,
    mode: "V2_GLOBAL",
    fallbackUsed: false,
    globalStatus: { ok: true },
    providers: {
      codex: { sessionStart: true, attached: true },
      antigravity: { sessionStart: true, attached: true },
    },
    recovery: { ok: true },
    ...overrides,
  };
}

async function loadProviderShimInstallers() {
  const [{ installCodexV2Shim }, { installAntigravityV2Shim }] = await Promise.all([
    import("../../v2/providers/codex/shim-manager.mjs"),
    import("../../v2/providers/antigravity/shim-manager.mjs"),
  ]);
  return { installCodexV2Shim, installAntigravityV2Shim };
}

test("migration activation installs only thin v2 shims, verifies global attach, and preserves legacy runtime", v2Only, async () => {
  await withWorkspace(async (root) => {
    const { workspace, home, legacyRuntime, applied } = await prepareManagedMigration(root, "activation-success");
    const globalDir = join(root, "global-engine");
    await mkdir(globalDir, { recursive: true });
    const launcherPath = join(globalDir, "orchestra.mjs");
    await writeFile(launcherPath, "// global launcher fixture\n", "utf8");

    const { createGlobalProjectRegistry } = await import("../../v2/global/project-registry.mjs");
    const { createMigrationLifecycleStore } = await import("../../v2/migration/rollback.mjs");
    const {
      createMigrationShimActivator,
      readMigrationActivationReceipt,
    } = await import("../../v2/migration/shim-activation.mjs");
    const { installCodexV2Shim, installAntigravityV2Shim } = await loadProviderShimInstallers();

    const registry = createGlobalProjectRegistry({ home });
    try {
      const lifecycleStore = createMigrationLifecycleStore({ home, state: registry.state });
      const activator = createMigrationShimActivator({
        registry,
        lifecycleStore,
        home,
        launcherPath,
        nodePath: process.execPath,
        codexInstaller: installCodexV2Shim,
        antigravityInstaller: installAntigravityV2Shim,
        verify: async ({ project, providers }) => ({
          ...verifiedV2Result(),
          rawSessionId: "must-not-persist",
          projectId: project.projectId,
          verifiedProviders: providers,
        }),
      });
      const activated = await activator.activate({
        projectId: applied.stdout.project.projectId,
        providers: ["codex", "antigravity"],
      });

      assert.equal(activated.ok, true);
      assert.equal(activated.code, "MIGRATION_V2_ACTIVATED");
      assert.equal(activated.cleanupEligible, true);
      assert.equal(activated.receipt.verified, true);
      assert.deepEqual(activated.receipt.providers, ["antigravity", "codex"]);
      assert.deepEqual(activated.receipt.thinShims, [
        ".agents/hooks.json",
        ".agents/orchestra-v2-hook.mjs",
        ".codex/hooks.json",
        ".codex/orchestra-v2-hook.mjs",
      ]);
      assert.equal(JSON.stringify(activated.receipt).includes("must-not-persist"), false);
      assert.equal(await readFile(legacyRuntime, "utf8").then((text) => text.includes("runtime-manifest")), true);
      assert.equal(await lstat(join(workspace, ".codex", "orchestra-v2-hook.mjs")).then((stat) => stat.isFile()), true);
      assert.equal(await lstat(join(workspace, ".agents", "orchestra-v2-hook.mjs")).then((stat) => stat.isFile()), true);

      const persisted = await readMigrationActivationReceipt({ home, projectId: applied.stdout.project.projectId });
      assert.equal(persisted.ok, true);
      assert.equal(persisted.receipt.cleanupEligible, true);
      assert.equal(JSON.stringify(persisted.receipt).includes("must-not-persist"), false);
    } finally {
      registry.close();
    }
  });
});

test("failed or v1-fallback migration verification never opens cleanup and leaves rollback available", v2Only, async () => {
  await withWorkspace(async (root) => {
    const { home, legacyRuntime, applied } = await prepareManagedMigration(root, "activation-failure");
    const globalDir = join(root, "global-engine-failure");
    await mkdir(globalDir, { recursive: true });
    const launcherPath = join(globalDir, "orchestra.mjs");
    await writeFile(launcherPath, "// global launcher fixture\n", "utf8");

    const { createGlobalProjectRegistry } = await import("../../v2/global/project-registry.mjs");
    const { createMigrationLifecycleStore } = await import("../../v2/migration/rollback.mjs");
    const {
      createMigrationShimActivator,
      readMigrationActivationReceipt,
    } = await import("../../v2/migration/shim-activation.mjs");
    const { installCodexV2Shim, installAntigravityV2Shim } = await loadProviderShimInstallers();

    const registry = createGlobalProjectRegistry({ home });
    try {
      const lifecycleStore = createMigrationLifecycleStore({ home, state: registry.state });
      for (const verification of [
        { ok: false, mode: "V2_GLOBAL", fallbackUsed: false },
        verifiedV2Result({ mode: "V1_COMPATIBILITY", fallbackUsed: true }),
      ]) {
        const activator = createMigrationShimActivator({
          registry,
          lifecycleStore,
          home,
          launcherPath,
          nodePath: process.execPath,
          codexInstaller: installCodexV2Shim,
          antigravityInstaller: installAntigravityV2Shim,
          verify: async () => verification,
        });
        const result = await activator.activate({
          projectId: applied.stdout.project.projectId,
          providers: ["codex"],
        });
        assert.equal(result.ok, false);
        assert.equal(result.code, "MIGRATION_V2_VERIFICATION_FAILED");
        assert.equal(result.cleanupEligible, false);
      }

      const receipt = await readMigrationActivationReceipt({ home, projectId: applied.stdout.project.projectId });
      assert.equal(receipt.ok, true);
      assert.equal(receipt.receipt, null);
      assert.equal(await readFile(legacyRuntime, "utf8").then((text) => text.includes("runtime-manifest")), true);

      const rolled = await lifecycleStore.rollback({
        projectId: applied.stdout.project.projectId,
        commandId: "rollback-after-verification-failure",
      });
      assert.equal(rolled.ok, true);
      assert.equal(rolled.manifest.status, "ROLLED_BACK");
    } finally {
      registry.close();
    }
  });
});

test("migration activation requires factual recovery verification when imported transient work exists", v2Only, async () => {
  await withWorkspace(async (root) => {
    const workspace = join(root, "recovery-project");
    await mkdir(workspace, { recursive: true });
    await initGit(workspace);
    const home = join(root, "recovery-home");
    const launcherPath = join(root, "recovery-global-launcher.mjs");
    await writeFile(launcherPath, "// global launcher fixture\n", "utf8");

    const project = {
      projectId: "prj_recovery_fixture",
      lineageId: "lineage_recovery_fixture",
      workspace: { canonicalRoot: workspace, vcs: "git" },
      runtime: { pinnedImage: "legacy-migration-compat", instructionEpoch: 0 },
      trust: { mode: "migration" },
    };
    const manifest = {
      schema: "orchestra.migration-manifest.v2",
      projectId: project.projectId,
      workspace,
      status: "IMPORTED",
      active: true,
      import: { recoveryWorkId: "work_recovery_fixture" },
      integration: { mode: "LEGACY_COMPATIBILITY", verified: false, thinShims: [] },
    };
    const registry = {
      paths: { home },
      inspect(projectId) { return projectId === project.projectId ? project : null; },
      async resolveWorkspace() { return project; },
    };
    const lifecycleStore = {
      async read(projectId) {
        return projectId === project.projectId ? { ok: true, manifest } : { ok: true, manifest: null };
      },
    };
    const fakeInstaller = () => ({ ok: true, files: [".codex/hooks.json", ".codex/orchestra-v2-hook.mjs"] });
    const { createMigrationShimActivator } = await import("../../v2/migration/shim-activation.mjs");

    const activator = createMigrationShimActivator({
      registry,
      lifecycleStore,
      home,
      launcherPath,
      nodePath: process.execPath,
      codexInstaller: fakeInstaller,
      antigravityInstaller: async () => ({ ok: true, files: [] }),
      verify: async () => verifiedV2Result({ recovery: { ok: false } }),
    });
    const blocked = await activator.activate({ projectId: project.projectId, providers: ["codex"] });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.code, "MIGRATION_V2_VERIFICATION_FAILED");
    assert.equal(blocked.reason, "MIGRATION_RECOVERY_VERIFICATION_REQUIRED");
    assert.equal(blocked.cleanupEligible, false);
  });
});
