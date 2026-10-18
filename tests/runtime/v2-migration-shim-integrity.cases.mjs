import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile, lstat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

const nodeMajor = Number(process.versions.node.split(".")[0]);
const v2Only = { skip: nodeMajor < 24 };

function sha(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
}

function inventoryDigest(inventory) {
  return sha(Buffer.from(JSON.stringify(stable(inventory.map((item) => ({
    path: item.path ?? null,
    digest: item.digest ?? null,
    category: item.category ?? null,
    disposition: item.disposition ?? null,
    private: item.private === true,
  })))));
}

test("cleanup blocks when a previously verified thin shim changes before legacy runtime deletion", v2Only, async () => {
  const workspace = await mkdtemp(join(tmpdir(), "orchestra-v2-shim-integrity-"));
  try {
    const canonicalRoot = await realpath(workspace);
    const runtimePath = join(canonicalRoot, ".codex", "astra-orchestra", "runtime", "orchestra-v2-runtime.json");
    const shimPath = join(canonicalRoot, ".codex", "orchestra-v2-hook.mjs");
    await mkdir(dirname(runtimePath), { recursive: true });
    await mkdir(dirname(shimPath), { recursive: true });
    const runtimeBytes = Buffer.from('{"schema":"orchestra.runtime-manifest.v1","version":1,"provider":"codex"}\n');
    const verifiedShimBytes = Buffer.from("// verified v2 shim\n");
    await writeFile(runtimePath, runtimeBytes);
    await writeFile(shimPath, "// tampered after verification\n", "utf8");

    const project = {
      projectId: "prj_cleanup_shim_integrity",
      lineageId: "lineage_cleanup_shim_integrity",
      workspace: { canonicalRoot, vcs: "git" },
      runtime: { pinnedImage: "legacy-migration-compat", instructionEpoch: 0 },
    };
    const inventory = [{
      path: ".codex/astra-orchestra/runtime/orchestra-v2-runtime.json",
      digest: sha(runtimeBytes),
      category: "MANAGED_RUNTIME",
      disposition: "RECOVERABLE_IMPORT",
      private: false,
    }];
    const manifest = {
      schema: "orchestra.migration-manifest.v2",
      projectId: project.projectId,
      projectLineageId: project.lineageId,
      workspace: canonicalRoot,
      status: "IMPORTED",
      active: true,
      inventory,
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
      instructionEpoch: 0,
      inventoryDigest: inventoryDigest(inventory),
      integrationMode: "V2_GLOBAL",
      verified: true,
      cleanupEligible: true,
      providers: ["codex"],
      thinShims: [".codex/orchestra-v2-hook.mjs"],
      thinShimDigests: [{
        path: ".codex/orchestra-v2-hook.mjs",
        digest: sha(verifiedShimBytes),
      }],
      globalStatusVerified: true,
      recoveryVerified: false,
      verifiedAt: "2026-10-17T20:00:00.000Z",
    };
    let prepareCalled = false;
    const registry = { inspect() { return project; } };
    const lifecycleStore = {
      async read() { return { ok: true, manifest }; },
      async prepareCleanup() { prepareCalled = true; return { ok: true }; },
      async completeCleanup() { return { ok: true, manifest, replayed: false }; },
    };
    const { createMigrationCleanup } = await import("../../v2/migration/cleanup.mjs");
    const cleanup = createMigrationCleanup({
      registry,
      lifecycleStore,
      home: join(canonicalRoot, "global-home"),
      readActivationReceipt: async () => ({ ok: true, receipt }),
    });

    const result = await cleanup.cleanup({ projectId: project.projectId, commandId: "cleanup-shim-tampered" });
    assert.equal(result.ok, false);
    assert.equal(result.code, "MIGRATION_CLEANUP_BLOCKED");
    assert.equal(result.reason, "MIGRATION_THIN_SHIM_CHANGED");
    assert.equal(prepareCalled, false);
    assert.equal(await lstat(runtimePath).then((stat) => stat.isFile()), true);
    assert.equal(await readFile(shimPath, "utf8"), "// tampered after verification\n");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
