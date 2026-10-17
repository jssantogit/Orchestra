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
