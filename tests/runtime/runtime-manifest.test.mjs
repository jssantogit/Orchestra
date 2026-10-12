import assert from "node:assert/strict";
import test from "node:test";

const LOADER_URL = new URL("../../runtime/manifest-loader.mjs", import.meta.url);

async function runtimeManifestApi() {
  return import(LOADER_URL);
}

function findAsset(manifest, output) {
  return manifest.managedAssets.find((asset) => asset.output === output);
}

function validFixture(overrides = {}) {
  return {
    schema: "orchestra.runtime-manifest.v1",
    runtime: "fixture",
    version: "0.10.0",
    sourceRoots: ["core", "providers/fixture", "runtimes/fixture", "schemas"],
    managedAssets: [
      {
        type: "file",
        source: "runtimes/fixture/config.json",
        output: ".fixture/config.json",
      },
    ],
    preservedProjectPaths: [".orchestra/state"],
    generatedInputs: ["core", "schemas", "providers/fixture"],
    entrypoints: [".fixture/config.json"],
    healthChecks: ["schema-freshness"],
    ...overrides,
  };
}

test("core manifest declares canonical core and schema ownership", async () => {
  const { loadRuntimeManifest } = await runtimeManifestApi();
  const manifest = await loadRuntimeManifest("core");
  assert.equal(manifest.schema, "orchestra.runtime-manifest.v1");
  assert.equal(manifest.runtime, "core");
  assert.ok(manifest.sourceRoots.includes("core"));
  assert.ok(manifest.sourceRoots.includes("schemas"));
  assert.deepEqual(findAsset(manifest, "core"), { type: "tree", source: "core", output: "core" });
  assert.deepEqual(findAsset(manifest, "core/schemas"), { type: "tree", source: "schemas", output: "core/schemas" });
});

test("codex manifest owns the proven runtime image while core and provider stay canonical", async () => {
  const { loadRuntimeManifest } = await runtimeManifestApi();
  const manifest = await loadRuntimeManifest("codex");
  assert.equal(manifest.runtime, "codex");
  assert.ok(manifest.sourceRoots.includes("core"));
  assert.ok(manifest.sourceRoots.includes("providers/codex"));
  assert.ok(manifest.sourceRoots.includes("runtimes/codex"));
  assert.ok(manifest.sourceRoots.includes("schemas"));
  assert.deepEqual(findAsset(manifest, ".codex/config.toml"), { type: "file", source: "runtimes/codex/.codex/config.toml", output: ".codex/config.toml" });
  assert.deepEqual(findAsset(manifest, ".codex/hooks.json"), { type: "file", source: "runtimes/codex/.codex/hooks.json", output: ".codex/hooks.json" });
  assert.equal(findAsset(manifest, ".codex/agents")?.source, "runtimes/codex/.codex/agents");
  assert.equal(findAsset(manifest, ".codex/astra-orchestra/core")?.source, "core");
  assert.equal(findAsset(manifest, ".codex/astra-orchestra/core/schemas")?.source, "schemas");
  assert.equal(findAsset(manifest, ".codex/astra-orchestra/provider/codex")?.source, "providers/codex");
  for (const entrypoint of [
    ".codex/astra-orchestra/routing-policy.mjs",
    ".codex/astra-orchestra/session-hook.mjs",
    ".codex/astra-orchestra/session-post-tool-hook.mjs",
    ".codex/astra-orchestra/codex-runtime-cli.mjs",
  ]) assert.ok(manifest.entrypoints.includes(entrypoint), `missing Codex entrypoint ${entrypoint}`);
});

test("antigravity manifest owns provider/core payload while Dream is sourced from Labs", async () => {
  const { loadRuntimeManifest } = await runtimeManifestApi();
  const manifest = await loadRuntimeManifest("antigravity");
  assert.equal(manifest.runtime, "antigravity");
  assert.ok(manifest.sourceRoots.includes("core"));
  assert.ok(manifest.sourceRoots.includes("providers/antigravity"));
  assert.ok(manifest.sourceRoots.includes("runtimes/antigravity"));
  assert.ok(manifest.sourceRoots.includes("labs/dream"));
  assert.ok(manifest.sourceRoots.includes("schemas"));
  assert.equal(findAsset(manifest, "GEMINI.md")?.source, "runtimes/antigravity/GEMINI.md");
  assert.equal(findAsset(manifest, ".agents/hooks.json")?.source, "runtimes/antigravity/.agents/hooks.json");
  assert.equal(findAsset(manifest, ".agents/hooks")?.source, "runtimes/antigravity/.agents/hooks");
  assert.equal(findAsset(manifest, ".agents/agents")?.source, "runtimes/antigravity/.agents/agents");
  assert.equal(findAsset(manifest, ".agents/dream")?.source, "labs/dream/runtime");
  assert.equal(findAsset(manifest, ".agents/skills/orchestra/core")?.source, "core");
  assert.equal(findAsset(manifest, ".agents/skills/orchestra/core/schemas")?.source, "schemas");
  assert.equal(findAsset(manifest, ".agents/skills/orchestra/provider/antigravity")?.source, "providers/antigravity");
  for (const entrypoint of [
    "GEMINI.md",
    ".agents/hooks/pre-tool-enforce.mjs",
    ".agents/hooks/stop-guard.mjs",
    ".agents/skills/orchestra/project-runtime-cli.mjs",
    ".agents/skills/orchestra/orchestrator-handoff-cli.mjs",
    ".agents/skills/agy-orchestra",
  ]) assert.ok(manifest.entrypoints.includes(entrypoint), `missing Antigravity entrypoint ${entrypoint}`);
});

test("unknown runtime manifests fail closed", async () => {
  const { loadRuntimeManifest } = await runtimeManifestApi();
  await assert.rejects(() => loadRuntimeManifest("does-not-exist"), /unknown runtime manifest/i);
});

test("manifest validation rejects duplicate roots and colliding outputs", async () => {
  const { validateRuntimeManifest } = await runtimeManifestApi();
  assert.throws(() => validateRuntimeManifest(validFixture({ sourceRoots: ["core", "core"] })), /duplicate source root/i);
  assert.throws(() => validateRuntimeManifest(validFixture({
    managedAssets: [
      { type: "file", source: "runtimes/fixture/a", output: ".fixture/same" },
      { type: "file", source: "runtimes/fixture/b", output: ".fixture/same" },
    ],
  })), /output collision/i);
});

test("manifest validation rejects source and glob escapes outside declared canonical roots", async () => {
  const { validateRuntimeManifest } = await runtimeManifestApi();
  assert.throws(() => validateRuntimeManifest(validFixture({
    managedAssets: [{ type: "file", source: "../secret", output: ".fixture/secret" }],
  })), /escape|source root|relative path/i);
  assert.throws(() => validateRuntimeManifest(validFixture({
    managedAssets: [{ type: "tree", source: "runtimes/fixture", output: ".fixture", exclude: ["../secret/**"] }],
  })), /escape|relative path|glob/i);
});

test("manifest validation rejects Windows drive-absolute paths and globs", async () => {
  const { validateRuntimeManifest } = await runtimeManifestApi();
  assert.throws(() => validateRuntimeManifest(validFixture({
    sourceRoots: ["C:/outside", "runtimes/fixture"],
  })), /relative path|bounded/i);
  assert.throws(() => validateRuntimeManifest(validFixture({
    managedAssets: [{ type: "file", source: "runtimes/fixture/config.json", output: "D:/outside/config.json" }],
  })), /relative path|bounded/i);
  assert.throws(() => validateRuntimeManifest(validFixture({
    managedAssets: [{ type: "tree", source: "runtimes/fixture", output: ".fixture", exclude: ["E:/outside/**"] }],
  })), /relative glob|bounded/i);
});

test("preserved project paths cannot overlap managed outputs", async () => {
  const { validateRuntimeManifest } = await runtimeManifestApi();
  assert.throws(() => validateRuntimeManifest(validFixture({ preservedProjectPaths: [".fixture/config.json"] })), /preserved.*managed|overlap/i);
});
