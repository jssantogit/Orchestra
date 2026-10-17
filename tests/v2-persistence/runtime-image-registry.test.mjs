import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";

import { createSqliteState } from "../../v2/persistence/sqlite/sqlite-state.mjs";
import { createRuntimeImageStore } from "../../v2/runtime-images/store.mjs";

const FILES = Object.freeze({
  "engine.mjs": Buffer.from("export const runtimeVersion = '2.7.0';\n"),
});

function installInput(overrides = {}) {
  return {
    version: "2.7.0",
    files: FILES,
    engineCompatibility: { min: "2.7.0", max: "2.x" },
    providerAdapterCompatibility: {
      codex: { min: "2.7.0", max: "2.x" },
      antigravity: { min: "2.7.0", max: "2.x" },
    },
    createdAt: "2026-10-17T12:00:00.000Z",
    ...overrides,
  };
}

function databasePath(orchestraHome) {
  return join(orchestraHome, "state", "orchestra.db");
}

function project({ projectId, canonicalRoot, imageId }) {
  return {
    schema: "orchestra.project.v2",
    projectId,
    lineageId: `lineage-${projectId}`,
    workspace: { canonicalRoot, vcs: "git" },
    runtime: { pinnedImage: imageId, instructionEpoch: 1 },
    trust: { mode: "trusted" },
  };
}

async function withHome(fn) {
  const orchestraHome = await mkdtemp(join(tmpdir(), "orchestra-v2-image-registry-"));
  try {
    await fn(orchestraHome);
  } finally {
    await rm(orchestraHome, { recursive: true, force: true });
  }
}

test("runtime image registry survives a fresh store instance", async () => {
  await withHome(async (orchestraHome) => {
    const first = await createRuntimeImageStore({ orchestraHome }).install(installInput());
    const reopened = createRuntimeImageStore({ orchestraHome });

    const listed = await reopened.list();
    assert.deepEqual(listed.map((image) => image.imageId), [first.imageId]);
    assert.equal((await reopened.verify(first.imageId)).valid, true);
  });
});

test("runtime image registry rejects a newer unsupported global DB schema", async () => {
  await withHome(async (orchestraHome) => {
    await mkdir(join(orchestraHome, "state"), { recursive: true });
    const db = new DatabaseSync(databasePath(orchestraHome));
    db.exec("PRAGMA user_version = 999");
    db.close();

    await assert.rejects(
      createRuntimeImageStore({ orchestraHome }).list(),
      (error) => error?.code === "ORCHESTRA_V2_SCHEMA_TOO_NEW" && error?.schemaVersion === 999,
    );
  });
});

test("runtime image registry rejects persisted records with an unsupported image schema", async () => {
  await withHome(async (orchestraHome) => {
    const store = createRuntimeImageStore({ orchestraHome });
    const image = await store.install(installInput());

    const db = new DatabaseSync(databasePath(orchestraHome));
    db.prepare("UPDATE runtime_images SET record_json = ? WHERE image_id = ?").run(
      JSON.stringify({ ...image, schema: "orchestra.runtime-image.v999" }),
      image.imageId,
    );
    db.close();

    await assert.rejects(
      createRuntimeImageStore({ orchestraHome }).list(),
      (error) => error?.code === "ORCHESTRA_RUNTIME_IMAGE_REGISTRY_INVALID" && error?.imageId === image.imageId,
    );
  });
});

test("two projects may pin different global images without per-project runtime image copies", async () => {
  await withHome(async (orchestraHome) => {
    const store = createRuntimeImageStore({ orchestraHome });
    const first = await store.install(installInput());
    const second = await store.install(installInput({
      version: "2.8.0",
      files: { ...FILES, "next.mjs": Buffer.from("export const next = true;\n") },
      createdAt: "2026-10-17T12:01:00.000Z",
    }));

    const state = createSqliteState({ dbPath: databasePath(orchestraHome) });
    assert.equal(state.projects.register(project({
      projectId: "prj-runtime-a",
      canonicalRoot: "C:/Projects/Runtime-A",
      imageId: first.imageId,
    })).ok, true);
    assert.equal(state.projects.register(project({
      projectId: "prj-runtime-b",
      canonicalRoot: "C:/Projects/Runtime-B",
      imageId: second.imageId,
    })).ok, true);
    state.close();

    const reopened = createRuntimeImageStore({ orchestraHome });
    const listed = await reopened.list();
    assert.deepEqual(listed.map((image) => image.imageId), [first.imageId, second.imageId].sort());
    assert.equal(reopened.locationFor(first.imageId).startsWith(reopened.root), true);
    assert.equal(reopened.locationFor(second.imageId).startsWith(reopened.root), true);
    assert.equal(reopened.locationFor(first.imageId).includes("prj-runtime-a"), false);
    assert.equal(reopened.locationFor(second.imageId).includes("prj-runtime-b"), false);
  });
});
