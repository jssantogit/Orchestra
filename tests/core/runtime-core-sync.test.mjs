import test from "node:test";
import assert from "node:assert/strict";
import { appendFile, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { syncRuntimeCore } from "../../scripts/sync-runtime-core.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");

async function makeFixture() {
  const root = await mkdtemp(join(tmpdir(), "orchestra-runtime-core-"));
  await cp(join(repoRoot, "core"), join(root, "core"), { recursive: true });
  await cp(join(repoRoot, "schemas"), join(root, "schemas"), { recursive: true });
  await mkdir(join(root, "runtimes", "codex", ".codex", "astra-orchestra"), { recursive: true });
  await mkdir(join(root, "runtimes", "antigravity", ".agents", "skills", "orchestra"), { recursive: true });
  return root;
}

async function withFixture(fn) {
  const root = await makeFixture();
  try { await fn(root); } finally { await rm(root, { recursive: true, force: true }); }
}

test("empty runtime mirrors report canonical files as missing in check-only mode", async () => {
  await withFixture(async (root) => {
    const result = await syncRuntimeCore({ repoRoot: root, checkOnly: true });
    assert.equal(result.changed.length, 0);
    assert.ok(result.missing.some((path) => path.includes("runtimes/codex/.codex/astra-orchestra/core/domain/implementation-packet.mjs")));
    assert.ok(result.missing.some((path) => path.includes("runtimes/antigravity/.agents/skills/orchestra/core/schemas/work-lease.v1.schema.json")));
  });
});

test("sync repairs drift exactly and reports modified generated validators as stale", async () => {
  await withFixture(async (root) => {
    const write = await syncRuntimeCore({ repoRoot: root });
    assert.ok(write.changed.length > 0);

    const clean = await syncRuntimeCore({ repoRoot: root, checkOnly: true });
    assert.deepEqual(clean.missing, []);
    assert.deepEqual(clean.stale, []);

    const mirrored = join(root, "runtimes", "codex", ".codex", "astra-orchestra", "core", "schema", "generated", "implementation-packet.v1.mjs");
    await appendFile(mirrored, "\n// drift\n");

    const drift = await syncRuntimeCore({ repoRoot: root, checkOnly: true });
    assert.ok(drift.stale.some((path) => path.endsWith("core/schema/generated/implementation-packet.v1.mjs")));

    await syncRuntimeCore({ repoRoot: root });
    const canonical = await readFile(join(root, "core", "schema", "generated", "implementation-packet.v1.mjs"), "utf8");
    assert.equal(await readFile(mirrored, "utf8"), canonical);
  });
});

test("provider-specific source outside generated mirror is never copied into core", async () => {
  await withFixture(async (root) => {
    const providerFile = join(root, "runtimes", "codex", "provider-secret.mjs");
    await writeFile(providerFile, "export const providerSecret = true;\n");
    await syncRuntimeCore({ repoRoot: root });

    const codexManifest = JSON.parse(await readFile(join(root, "runtimes", "codex", ".codex", "astra-orchestra", "core", "runtime-core-manifest.json"), "utf8"));
    assert.equal(codexManifest.files.some((entry) => entry.path.includes("provider-secret")), false);
    assert.equal(codexManifest.files.some((entry) => entry.path.startsWith("domain/")), true);
    assert.equal(codexManifest.files.some((entry) => entry.path.startsWith("schemas/")), true);
  });
});

test("copied runtime core validates schemas in an isolated project without node_modules", async () => {
  await withFixture(async (root) => {
    await syncRuntimeCore({ repoRoot: root });
    const isolated = await mkdtemp(join(tmpdir(), "orchestra-runtime-isolated-"));
    try {
      const source = join(root, "runtimes", "codex", ".codex", "astra-orchestra", "core");
      const copied = join(isolated, "core");
      await cp(source, copied, { recursive: true });
      await writeFile(join(isolated, "package.json"), JSON.stringify({ type: "module" }));

      const validator = await import(pathToFileURL(join(copied, "schema", "validator.mjs")).href);
      const valid = validator.validateSchema("candidate.v1.schema.json", {
        schema: "orchestra.candidate.v1",
        taskId: "t",
        generation: 1,
        identity: "candidate",
        changedPaths: [],
      });
      assert.equal(valid.valid, true, JSON.stringify(valid.errors));
    } finally {
      await rm(isolated, { recursive: true, force: true });
    }
  });
});
