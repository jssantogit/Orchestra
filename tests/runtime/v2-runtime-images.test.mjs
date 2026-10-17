import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";

import { createSqliteState } from "../../v2/persistence/sqlite/sqlite-state.mjs";
import { createRuntimeImageStore } from "../../v2/runtime-images/store.mjs";
import { validateRuntimeImageRecord } from "../../v2/runtime-images/contracts.mjs";

const FILES = Object.freeze({
  "engine.mjs": Buffer.from("export const runtimeVersion = '2.7.0';\n"),
  "providers/codex.mjs": Buffer.from("export const provider = 'codex';\n"),
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
  const root = await mkdtemp(join(tmpdir(), "orchestra-runtime-images-"));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function blobPath(orchestraHome, digest) {
  return join(orchestraHome, "runtime-images", "blobs", "sha256", digest.slice(7, 9), digest.slice(9));
}

function databasePath(orchestraHome) {
  return join(orchestraHome, "state", "orchestra.db");
}

test("runtime image records require the approved v2 contract", async () => {
  await withHome(async (orchestraHome) => {
    const image = await createRuntimeImageStore({ orchestraHome }).install(installInput());
    assert.equal(validateRuntimeImageRecord(image).valid, true);
    assert.equal("providerAdapterCompatibility" in image, true);
    assert.equal("codexCompatibility" in image, false);
    assert.equal("antigravityCompatibility" in image, false);

    for (const field of [
      "schema", "imageId", "version", "manifestDigest", "manifestRef",
      "engineCompatibility", "providerAdapterCompatibility", "createdAt",
    ]) {
      const incomplete = { ...image };
      delete incomplete[field];
      assert.equal(validateRuntimeImageRecord(incomplete).valid, false, `${field} is required`);
    }
    for (const field of ["codex", "antigravity"]) {
      const invalid = {
        ...image,
        providerAdapterCompatibility: { ...image.providerAdapterCompatibility },
      };
      delete invalid.providerAdapterCompatibility[field];
      assert.equal(validateRuntimeImageRecord(invalid).valid, false, `${field} compatibility is required`);
    }
  });
});

test("identical image files and manifest converge on one immutable image", async () => {
  await withHome(async (orchestraHome) => {
    const store = createRuntimeImageStore({ orchestraHome });
    const input = installInput();

    const first = await store.install(input);
    const replay = await store.install(input);

    assert.equal(replay.imageId, first.imageId);
    assert.deepEqual(replay, first);
    assert.equal(Object.isFrozen(first), true);
    assert.equal(Object.isFrozen(first.engineCompatibility), true);
    assert.equal(Object.isFrozen(first.providerAdapterCompatibility.codex), true);
    assert.deepEqual(await store.readFile(first.imageId, "engine.mjs"), FILES["engine.mjs"]);
  });
});

test("Unicode file paths use host-independent lexical ordering for image identity", async () => {
  await withHome(async (orchestraHome) => {
    const store = createRuntimeImageStore({ orchestraHome });
    const files = {
      "ä.mjs": Buffer.from("export const name = 'umlaut';\n"),
      "z.mjs": Buffer.from("export const name = 'z';\n"),
    };
    const first = await store.install(installInput({ files }));
    const manifest = JSON.parse((await store.readManifest(first.imageId)).toString("utf8"));
    const replay = await store.install(installInput({ files: { "z.mjs": files["z.mjs"], "ä.mjs": files["ä.mjs"] } }));

    assert.deepEqual(manifest.files.map((entry) => entry.path), ["z.mjs", "ä.mjs"]);
    assert.equal(replay.imageId, first.imageId);
    assert.deepEqual(replay, first);
  });
});

test("conflicting bytes for a declared image identity are rejected", async () => {
  await withHome(async (orchestraHome) => {
    const store = createRuntimeImageStore({ orchestraHome });
    const first = await store.install(installInput());

    await assert.rejects(
      store.install(installInput({
        imageId: first.imageId,
        files: { ...FILES, "engine.mjs": Buffer.from("different engine bytes\n") },
      })),
      { code: "ORCHESTRA_RUNTIME_IMAGE_IDENTITY_CONFLICT" },
    );
  });
});

test("tampering with an installed file or manifest fails integrity verification", async () => {
  await withHome(async (orchestraHome) => {
    const store = createRuntimeImageStore({ orchestraHome });
    const image = await store.install(installInput());
    const manifest = JSON.parse((await store.readManifest(image.imageId)).toString("utf8"));
    const engineDigest = manifest.files.find((entry) => entry.path === "engine.mjs").digest;

    await writeFile(blobPath(orchestraHome, engineDigest), "tampered engine bytes");
    const contentVerification = await store.verify(image.imageId);
    assert.equal(contentVerification.valid, false);
    assert.equal(contentVerification.reason, "CONTENT_DIGEST_MISMATCH");

    const manifestStore = createRuntimeImageStore({ orchestraHome: join(orchestraHome, "other-home") });
    const second = await manifestStore.install(installInput());
    await writeFile(blobPath(join(orchestraHome, "other-home"), second.manifestDigest), "tampered manifest");
    const manifestVerification = await manifestStore.verify(second.imageId);
    assert.equal(manifestVerification.valid, false);
    assert.equal(manifestVerification.reason, "MANIFEST_DIGEST_MISMATCH");
  });
});

test("a duplicate install after blob corruption fails closed", async () => {
  await withHome(async (orchestraHome) => {
    const store = createRuntimeImageStore({ orchestraHome });
    const input = installInput();
    const image = await store.install(input);
    await writeFile(blobPath(orchestraHome, image.manifestDigest), "tampered manifest");

    await assert.rejects(store.install(input), { code: "ORCHESTRA_RUNTIME_IMAGE_INTEGRITY_FAILED" });
  });
});

test("concurrent conflicting metadata creates only one immutable image binding", async () => {
  await withHome(async (orchestraHome) => {
    const store = createRuntimeImageStore({ orchestraHome });
    const inputA = installInput();
    const inputB = installInput({
      providerAdapterCompatibility: {
        codex: { min: "2.7.0", max: "2.x" },
        antigravity: { min: "2.8.0", max: "2.x" },
      },
    });

    const results = await Promise.allSettled([store.install(inputA), store.install(inputB)]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.filter((result) => result.status === "rejected").length, 1);
    assert.equal(results.find((result) => result.status === "rejected").reason.code, "ORCHESTRA_RUNTIME_IMAGE_IDENTITY_CONFLICT");
  });
});

test("canonical metadata preserves own __proto__ keys when checking image identity", async () => {
  await withHome(async (orchestraHome) => {
    const store = createRuntimeImageStore({ orchestraHome });
    const engineCompatibilityA = JSON.parse('{"min":"2.7.0","__proto__":{"marker":"a"}}');
    const engineCompatibilityB = JSON.parse('{"min":"2.7.0","__proto__":{"marker":"b"}}');

    await store.install(installInput({ engineCompatibility: engineCompatibilityA }));
    await assert.rejects(
      store.install(installInput({ engineCompatibility: engineCompatibilityB })),
      { code: "ORCHESTRA_RUNTIME_IMAGE_IDENTITY_CONFLICT" },
    );
  });
});

test("returned image records and file bytes cannot mutate installed content", async () => {
  await withHome(async (orchestraHome) => {
    const store = createRuntimeImageStore({ orchestraHome });
    const image = await store.install(installInput());

    assert.equal(Object.isFrozen(image), true);
    assert.throws(() => { image.version = "9.9.9"; }, TypeError);
    const bytes = await store.readFile(image.imageId, "engine.mjs");
    bytes[0] = 0;

    assert.deepEqual(await store.readFile(image.imageId, "engine.mjs"), FILES["engine.mjs"]);
  });
});

test("runtime image files are rooted in Orchestra Home, independent of project workspaces", async () => {
  await withHome(async (orchestraHome) => {
    const store = createRuntimeImageStore({ orchestraHome });
    const image = await store.install(installInput());

    assert.equal(store.root.startsWith(join(orchestraHome, "runtime-images")), true);
    assert.equal(store.locationFor(image.imageId).startsWith(store.root), true);
    assert.equal(store.locationFor(image.imageId).includes("project"), false);
  });
});

test("semantic versions and creation timestamps reject malformed forms", async () => {
  await withHome(async (orchestraHome) => {
    const store = createRuntimeImageStore({ orchestraHome });
    const image = await store.install(installInput());
    const invalidVersions = ["2.7.0-alpha..1", "2.7.0-alpha.01", "2.7.0+build..1"];
    const invalidTimestamps = ["2026", "2026-10-17", "2026-02-30T12:00:00Z", "2026-10-17T12:00:00"];

    for (const version of invalidVersions) {
      assert.equal(validateRuntimeImageRecord({ ...image, version }).valid, false, version);
    }
    for (const createdAt of invalidTimestamps) {
      assert.equal(validateRuntimeImageRecord({ ...image, createdAt }).valid, false, createdAt);
    }
    assert.equal(validateRuntimeImageRecord({ ...image, version: "2.7.0-alpha.1+build.01" }).valid, true);
  });
});

test("installed runtime images survive restart and list deterministically", async () => {
  await withHome(async (orchestraHome) => {
    const firstStore = createRuntimeImageStore({ orchestraHome });
    const first = await firstStore.install(installInput());
    const second = await firstStore.install(installInput({
      version: "2.8.0",
      files: { ...FILES, "feature.mjs": Buffer.from("export const feature = true;\n") },
      createdAt: "2026-10-17T12:01:00.000Z",
    }));

    const reopened = createRuntimeImageStore({ orchestraHome });
    const listed = await reopened.list();

    assert.deepEqual(listed.map((image) => image.imageId), [first.imageId, second.imageId].sort());
    assert.deepEqual(listed.find((image) => image.imageId === first.imageId), first);
    assert.equal((await reopened.verify(first.imageId)).valid, true);
    assert.deepEqual(await reopened.readFile(first.imageId, "engine.mjs"), FILES["engine.mjs"]);
  });
});

test("duplicate install remains idempotent after restart", async () => {
  await withHome(async (orchestraHome) => {
    const input = installInput();
    const first = await createRuntimeImageStore({ orchestraHome }).install(input);
    const reopened = createRuntimeImageStore({ orchestraHome });
    const replay = await reopened.install(input);

    assert.deepEqual(replay, first);
    assert.deepEqual((await reopened.list()).map((image) => image.imageId), [first.imageId]);
  });
});

test("restart revalidates persisted image integrity instead of trusting registry metadata", async () => {
  await withHome(async (orchestraHome) => {
    const firstStore = createRuntimeImageStore({ orchestraHome });
    const image = await firstStore.install(installInput());
    await writeFile(blobPath(orchestraHome, image.manifestDigest), "tampered manifest after install");

    const reopened = createRuntimeImageStore({ orchestraHome });
    const verification = await reopened.verify(image.imageId);
    assert.equal(verification.valid, false);
    assert.equal(verification.reason, "MANIFEST_DIGEST_MISMATCH");
    await assert.rejects(reopened.install(installInput()), { code: "ORCHESTRA_RUNTIME_IMAGE_INTEGRITY_FAILED" });
  });
});

test("unsupported global DB schema fails closed before runtime image mutation", async () => {
  await withHome(async (orchestraHome) => {
    await mkdir(join(orchestraHome, "state"), { recursive: true });
    const db = new DatabaseSync(databasePath(orchestraHome));
    db.exec("PRAGMA user_version = 999");
    db.close();

    assert.throws(
      () => createRuntimeImageStore({ orchestraHome }),
      (error) => error?.code === "ORCHESTRA_V2_SCHEMA_TOO_NEW" && error?.schemaVersion === 999,
    );
  });
});

test("unsupported persisted runtime image schema fails closed on reopen", async () => {
  await withHome(async (orchestraHome) => {
    const store = createRuntimeImageStore({ orchestraHome });
    const image = await store.install(installInput());

    const db = new DatabaseSync(databasePath(orchestraHome));
    db.prepare("UPDATE runtime_images SET record_json = ? WHERE image_id = ?").run(
      JSON.stringify({ ...image, schema: "orchestra.runtime-image.v999" }),
      image.imageId,
    );
    db.close();

    assert.throws(
      () => createRuntimeImageStore({ orchestraHome }),
      (error) => error?.code === "ORCHESTRA_RUNTIME_IMAGE_REGISTRY_INVALID" && error?.imageId === image.imageId,
    );
  });
});

test("projects may pin different installed images without project-local image copies", async () => {
  await withHome(async (orchestraHome) => {
    const store = createRuntimeImageStore({ orchestraHome });
    const first = await store.install(installInput());
    const second = await store.install(installInput({
      version: "2.8.0",
      files: { ...FILES, "next.mjs": Buffer.from("export const next = true;\n") },
      createdAt: "2026-10-17T12:02:00.000Z",
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
    assert.deepEqual((await reopened.list()).map((image) => image.imageId), [first.imageId, second.imageId].sort());
    assert.equal(reopened.locationFor(first.imageId).startsWith(reopened.root), true);
    assert.equal(reopened.locationFor(second.imageId).startsWith(reopened.root), true);
    assert.equal(reopened.locationFor(first.imageId).includes("prj-runtime-a"), false);
    assert.equal(reopened.locationFor(second.imageId).includes("prj-runtime-b"), false);
  });
});
