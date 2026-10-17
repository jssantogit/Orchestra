import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { assessRuntimeImageCompatibility } from "../../v2/runtime-images/compatibility.mjs";
import { createRuntimeImageStore } from "../../v2/runtime-images/store.mjs";

function image(overrides = {}) {
  return {
    schema: "orchestra.runtime-image.v2",
    imageId: `sha256:${"a".repeat(64)}`,
    version: "2.7.0",
    manifestDigest: `sha256:${"a".repeat(64)}`,
    manifestRef: `blob:sha256:${"a".repeat(64)}`,
    engineCompatibility: { min: "2.7.0", max: "2.x" },
    providerAdapterCompatibility: {
      codex: { min: "2.7.0", max: "2.x" },
      antigravity: { min: "2.7.0", max: "2.x" },
    },
    createdAt: "2026-10-17T12:00:00.000Z",
    ...overrides,
  };
}

function input(overrides = {}) {
  return {
    image: image(),
    engineVersion: "2.8.1",
    provider: "codex",
    providerAdapterVersion: "2.9.0",
    ...overrides,
  };
}

test("compatible engine and selected provider adapter allow activation", () => {
  assert.deepEqual(assessRuntimeImageCompatibility(input()), {
    ok: true,
    code: "RUNTIME_IMAGE_COMPATIBLE",
    imageId: `sha256:${"a".repeat(64)}`,
    provider: "codex",
  });
});

test("engine incompatibility returns a structured activation denial", () => {
  const result = assessRuntimeImageCompatibility(input({ engineVersion: "3.0.0" }));
  assert.equal(result.ok, false);
  assert.equal(result.code, "ENGINE_VERSION_INCOMPATIBLE");
  assert.equal(result.actualVersion, "3.0.0");
  assert.deepEqual(result.required, { min: "2.7.0", max: "2.x" });
});

test("Codex adapter incompatibility is provider-scoped", () => {
  const result = assessRuntimeImageCompatibility(input({ providerAdapterVersion: "3.1.0" }));
  assert.equal(result.ok, false);
  assert.equal(result.code, "PROVIDER_ADAPTER_VERSION_INCOMPATIBLE");
  assert.equal(result.provider, "codex");
  assert.equal(result.actualVersion, "3.1.0");
});

test("Antigravity adapter incompatibility has equivalent semantics", () => {
  const target = image({
    providerAdapterCompatibility: {
      codex: { min: "2.7.0", max: "2.x" },
      antigravity: { min: "3.0.0", max: "3.x" },
    },
  });
  const result = assessRuntimeImageCompatibility(input({
    image: target,
    provider: "antigravity",
    providerAdapterVersion: "2.9.0",
  }));
  assert.equal(result.ok, false);
  assert.equal(result.code, "PROVIDER_ADAPTER_VERSION_INCOMPATIBLE");
  assert.equal(result.provider, "antigravity");
});

test("compatibility assessment is pure and does not mutate image metadata", () => {
  const target = image();
  const before = structuredClone(target);
  assessRuntimeImageCompatibility(input({ image: target }));
  assert.deepEqual(target, before);
});

test("unknown or malformed compatibility metadata fails closed", () => {
  for (const target of [
    image({ engineCompatibility: { min: "2.7.0", max: "latest" } }),
    image({ engineCompatibility: { min: "2.7.0", max: "2.x", unknown: true } }),
    image({ providerAdapterCompatibility: { codex: { min: "2.7.0", max: "2.x" } } }),
  ]) {
    const result = assessRuntimeImageCompatibility(input({ image: target }));
    assert.equal(result.ok, false);
    assert.equal(result.code, "RUNTIME_IMAGE_COMPATIBILITY_INVALID");
  }

  const unsupportedProvider = assessRuntimeImageCompatibility(input({ provider: "other" }));
  assert.equal(unsupportedProvider.ok, false);
  assert.equal(unsupportedProvider.code, "RUNTIME_IMAGE_COMPATIBILITY_INVALID");
});

test("a globally installed image can remain non-activatable for the current engine", async () => {
  const orchestraHome = await mkdtemp(join(tmpdir(), "orchestra-v2-compatibility-"));
  try {
    const store = createRuntimeImageStore({ orchestraHome });
    const installed = await store.install({
      version: "3.0.0",
      files: { "engine.mjs": Buffer.from("export const runtimeVersion = '3.0.0';\n") },
      engineCompatibility: { min: "3.0.0", max: "3.x" },
      providerAdapterCompatibility: {
        codex: { min: "3.0.0", max: "3.x" },
        antigravity: { min: "3.0.0", max: "3.x" },
      },
      createdAt: "2026-10-17T12:10:00.000Z",
    });

    const result = assessRuntimeImageCompatibility({
      image: installed,
      engineVersion: "2.9.0",
      provider: "codex",
      providerAdapterVersion: "2.9.0",
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, "ENGINE_VERSION_INCOMPATIBLE");
    assert.equal((await store.list()).some((entry) => entry.imageId === installed.imageId), true);
  } finally {
    await rm(orchestraHome, { recursive: true, force: true });
  }
});
