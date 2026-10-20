import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const nodeMajor = Number(process.versions.node.split(".")[0]);
const v2Only = { skip: nodeMajor < 24 };

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
}

function digest(value) {
  return `sha256:${createHash("sha256").update(JSON.stringify(stable(value)), "utf8").digest("hex")}`;
}

function inventoryDigest(inventory) {
  return digest(inventory.map((item) => ({
    path: item.path ?? null,
    digest: item.digest ?? null,
    category: item.category ?? null,
    disposition: item.disposition ?? null,
    private: item.private === true,
  })));
}

test("cleanup rejects a forged MANAGED_RUNTIME path outside approved legacy runtime roots", v2Only, async () => {
  const workspace = await mkdtemp(join(tmpdir(), "orchestra-v2-cleanup-forged-path-"));
  try {
    const canonicalRoot = await realpath(workspace);
    const userFile = join(canonicalRoot, "important-user-file.txt");
    await writeFile(userFile, "must survive cleanup\n", "utf8");
    const fileDigest = `sha256:${createHash("sha256").update(await readFile(userFile)).digest("hex")}`;
    const project = {
      projectId: "prj_cleanup_forged_path",
      lineageId: "lineage_cleanup_forged_path",
      workspace: { canonicalRoot, vcs: "git" },
      runtime: { pinnedImage: "legacy-migration-compat", instructionEpoch: 0 },
      trust: { mode: "migration" },
    };
    const manifest = {
      schema: "orchestra.migration-manifest.v2",
      projectId: project.projectId,
      projectLineageId: project.lineageId,
      workspace: canonicalRoot,
      status: "IMPORTED",
      active: true,
      inventory: [{
        path: "important-user-file.txt",
        digest: fileDigest,
        category: "MANAGED_RUNTIME",
        disposition: "CLEAN_IMPORT",
        private: false,
      }],
      import: { recoveryWorkId: null },
      integration: { mode: "LEGACY_COMPATIBILITY", verified: false, thinShims: [] },
      commands: [],
    };
    const receipt = {
      schema: "orchestra.migration-activation.v2",
      projectId: project.projectId,
      projectLineageId: project.lineageId,
      workspace: canonicalRoot,
      runtimeImage: project.runtime.pinnedImage,
      instructionEpoch: project.runtime.instructionEpoch,
      inventoryDigest: inventoryDigest(manifest.inventory),
      integrationMode: "V2_GLOBAL",
      verified: true,
      cleanupEligible: true,
      providers: ["codex"],
      thinShims: [],
      globalStatusVerified: true,
      recoveryVerified: false,
      verifiedAt: "2026-10-17T20:00:00.000Z",
    };
    let prepareCalled = false;
    const registry = {
      inspect(projectId) { return projectId === project.projectId ? project : null; },
    };
    const lifecycleStore = {
      async read() { return { ok: true, manifest }; },
      async prepareCleanup() { prepareCalled = true; return { ok: true }; },
      async completeCleanup() { throw new Error("must not complete forged cleanup"); },
    };
    const { createMigrationCleanup } = await import("../../v2/migration/cleanup.mjs");
    const cleanup = createMigrationCleanup({
      registry,
      lifecycleStore,
      home: join(canonicalRoot, "global-home"),
      readActivationReceipt: async () => ({ ok: true, receipt }),
    });

    const result = await cleanup.cleanup({ projectId: project.projectId, commandId: "cleanup-forged" });
    assert.equal(result.ok, false);
    assert.equal(result.code, "MIGRATION_CLEANUP_BLOCKED");
    assert.equal(result.reason, "MIGRATION_MANIFEST_CORRUPT");
    assert.equal(prepareCalled, false);
    assert.equal(await readFile(userFile, "utf8"), "must survive cleanup\n");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
