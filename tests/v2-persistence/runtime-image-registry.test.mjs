import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createRuntimeImageStore } from "../../v2/runtime-images/store.mjs";

const FILES = Object.freeze({
  "engine.mjs": Buffer.from("export const runtimeVersion = '2.7.0';\n"),
});

function installInput() {
  return {
    version: "2.7.0",
    files: FILES,
    engineCompatibility: { min: "2.7.0", max: "2.x" },
    providerAdapterCompatibility: {
      codex: { min: "2.7.0", max: "2.x" },
      antigravity: { min: "2.7.0", max: "2.x" },
    },
    createdAt: "2026-10-17T12:00:00.000Z",
  };
}

test("runtime image registry survives a fresh store instance", async () => {
  const orchestraHome = await mkdtemp(join(tmpdir(), "orchestra-v2-image-registry-"));
  try {
    const first = await createRuntimeImageStore({ orchestraHome }).install(installInput());
    const reopened = createRuntimeImageStore({ orchestraHome });

    const listed = await reopened.list();
    assert.deepEqual(listed.map((image) => image.imageId), [first.imageId]);
    assert.equal((await reopened.verify(first.imageId)).valid, true);
  } finally {
    await rm(orchestraHome, { recursive: true, force: true });
  }
});
