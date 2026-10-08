import test from "node:test";
import assert from "node:assert/strict";
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { syncRuntimeCore } from "../../scripts/sync-runtime-core.mjs";

const repoRoot = resolve(new URL("../..", import.meta.url).pathname);
const CODEX_MIRROR = "runtimes/codex/.codex/astra-orchestra/core";
const AGY_MIRROR = "runtimes/antigravity/.agents/skills/orchestra/core";

async function fixtureRoot() {
  const root = await mkdtemp(join(tmpdir(), "orchestra-runtime-core-sync-"));
  await cp(join(repoRoot, "core"), join(root, "core"), { recursive: true });
  await cp(join(repoRoot, "schemas"), join(root, "schemas"), { recursive: true });
  return root;
}

test("empty runtime mirrors report canonical files as missing", async () => {
  const root = await fixtureRoot();
  try {
    const result = await syncRuntimeCore({ repoRoot: root, checkOnly: true });
    assert.ok(result.missing.some((path) => path.startsWith(`${CODEX_MIRROR}/`)));
    assert.ok(result.missing.some((path) => path.startsWith(`${AGY_MIRROR}/`)));
    assert.deepEqual(result.stale, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("sync repairs missing, stale, and unexpected generated mirror content deterministically", async () => {
  const root = await fixtureRoot();
  try {
    const first = await syncRuntimeCore({ repoRoot: root });
    assert.ok(first.missing.length > 0);

    const clean = await syncRuntimeCore({ repoRoot: root, checkOnly: true });
    assert.deepEqual(clean, { changed: [], stale: [], missing: [] });

    const stalePath = join(root, CODEX_MIRROR, "schema", "generated", "candidate.v1.mjs");
    await writeFile(stalePath, "// stale\n", "utf8");
    await writeFile(join(root, CODEX_MIRROR, "unexpected.mjs"), "// unexpected\n", "utf8");

    const drift = await syncRuntimeCore({ repoRoot: root, checkOnly: true });
    assert.ok(drift.stale.includes(`${CODEX_MIRROR}/schema/generated/candidate.v1.mjs`));
    assert.ok(drift.changed.includes(`${CODEX_MIRROR}/unexpected.mjs`));

    await syncRuntimeCore({ repoRoot: root });
    assert.deepEqual(await syncRuntimeCore({ repoRoot: root, checkOnly: true }), {
      changed: [],
      stale: [],
      missing: [],
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("provider-specific source outside the generated mirror is never copied into neutral core", async () => {
  const root = await fixtureRoot();
  try {
    const providerOnly = join(root, "runtimes/codex/.codex/astra-orchestra/provider-only.mjs");
    await mkdir(dirname(providerOnly), { recursive: true });
    await writeFile(providerOnly, "export const provider = 'codex';\n", "utf8");

    await syncRuntimeCore({ repoRoot: root });

    await assert.rejects(readFile(join(root, AGY_MIRROR, "provider-only.mjs"), "utf8"), { code: "ENOENT" });
    await assert.rejects(readFile(join(root, CODEX_MIRROR, "provider-only.mjs"), "utf8"), { code: "ENOENT" });
    assert.match(await readFile(providerOnly, "utf8"), /codex/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a generated runtime core validates schemas in isolation without Orchestra node_modules", async () => {
  const root = await fixtureRoot();
  const isolated = await mkdtemp(join(tmpdir(), "orchestra-runtime-core-isolated-"));
  try {
    await syncRuntimeCore({ repoRoot: root });
    await cp(join(root, CODEX_MIRROR), join(isolated, "core"), { recursive: true });

    const { validateSchema } = await import(
      `${pathToFileURL(join(isolated, "core", "schema", "validator.mjs")).href}?isolated=${Date.now()}`
    );
    const result = validateSchema("candidate.v1.schema.json", {
      schema: "orchestra.candidate.v1",
      taskId: "task-1",
      candidateId: "candidate-1",
      generation: 1,
      workspaceId: "primary",
      headSha: "abcdef1",
    });
    assert.deepEqual(result, { valid: true, errors: [] });
    await assert.rejects(readFile(join(isolated, "node_modules", "ajv", "package.json"), "utf8"), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(isolated, { recursive: true, force: true });
  }
});
