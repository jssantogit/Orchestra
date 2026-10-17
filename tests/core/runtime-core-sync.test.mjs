import test from "node:test";
import assert from "node:assert/strict";
import { access, cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { buildSchemaValidators, SCHEMA_FILES } from "../../scripts/build-schema-validators.mjs";
import { checkRuntimeCore } from "../../scripts/check-runtime-core.mjs";
import { syncRuntimeCore } from "../../scripts/sync-runtime-core.mjs";

const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const CODEX_MIRROR = "runtimes/codex/.codex/astra-orchestra/core";
const AGY_MIRROR = "runtimes/antigravity/.agents/skills/orchestra/core";
const CODEX_PROVIDER_MIRROR = "runtimes/codex/.codex/astra-orchestra/provider/codex";
const AGY_PROVIDER_MIRROR = "runtimes/antigravity/.agents/skills/orchestra/provider/antigravity";

async function fixtureRoot() {
  const root = await mkdtemp(join(tmpdir(), "orchestra-runtime-core-sync-"));
  await cp(join(repoRoot, "core"), join(root, "core"), { recursive: true });
  await cp(join(repoRoot, "schemas"), join(root, "schemas"), { recursive: true });
  await cp(join(repoRoot, "providers"), join(root, "providers"), { recursive: true });
  await buildSchemaValidators({ repoRoot: root });
  return root;
}

async function changeFixtureCandidateSchema(root) {
  const schemaPath = join(root, "schemas", "candidate.v1.schema.json");
  const schema = JSON.parse(await readFile(schemaPath, "utf8"));
  schema.required.push("fixtureRequiredField");
  schema.properties.fixtureRequiredField = { type: "string", minLength: 1 };
  await writeFile(schemaPath, `${JSON.stringify(schema, null, 2)}\n`, "utf8");
}

test("empty runtime mirrors report canonical files as missing", async () => {
  const root = await fixtureRoot();
  try {
    const result = await syncRuntimeCore({ repoRoot: root, checkOnly: true });
    assert.ok(result.missing.some((path) => path.startsWith(`${CODEX_MIRROR}/`)));
    assert.ok(result.missing.some((path) => path.startsWith(`${AGY_MIRROR}/`)));
    assert.ok(result.missing.some((path) => path.startsWith(`${CODEX_PROVIDER_MIRROR}/`)));
    assert.ok(result.missing.some((path) => path.startsWith(`${AGY_PROVIDER_MIRROR}/`)));
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
    assert.deepEqual(await syncRuntimeCore({ repoRoot: root, checkOnly: true }), { changed: [], stale: [], missing: [] });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("provider-specific source mirrors only into its matching runtime namespace and drift is repairable", async () => {
  const root = await fixtureRoot();
  try {
    const codexFixture = join(root, "providers", "codex", "adapter", "fixture.mjs");
    const agyFixture = join(root, "providers", "antigravity", "adapter", "fixture.mjs");
    await mkdir(dirname(codexFixture), { recursive: true });
    await mkdir(dirname(agyFixture), { recursive: true });
    await writeFile(codexFixture, "export const provider = 'codex';\n", "utf8");
    await writeFile(agyFixture, "export const provider = 'antigravity';\n", "utf8");

    await syncRuntimeCore({ repoRoot: root });

    assert.match(await readFile(join(root, CODEX_PROVIDER_MIRROR, "adapter", "fixture.mjs"), "utf8"), /codex/);
    assert.match(await readFile(join(root, AGY_PROVIDER_MIRROR, "adapter", "fixture.mjs"), "utf8"), /antigravity/);
    await assert.rejects(readFile(join(root, "runtimes/antigravity/.agents/skills/orchestra/provider/codex/adapter/fixture.mjs"), "utf8"), { code: "ENOENT" });
    await assert.rejects(readFile(join(root, "runtimes/codex/.codex/astra-orchestra/provider/antigravity/adapter/fixture.mjs"), "utf8"), { code: "ENOENT" });

    const mirroredCodex = join(root, CODEX_PROVIDER_MIRROR, "adapter", "fixture.mjs");
    await writeFile(mirroredCodex, "// stale provider mirror\n", "utf8");
    const drift = await syncRuntimeCore({ repoRoot: root, checkOnly: true });
    assert.ok(drift.stale.includes(`${CODEX_PROVIDER_MIRROR}/adapter/fixture.mjs`));

    await syncRuntimeCore({ repoRoot: root });
    assert.equal(await readFile(mirroredCodex, "utf8"), "export const provider = 'codex';\n");
    assert.deepEqual(await syncRuntimeCore({ repoRoot: root, checkOnly: true }), { changed: [], stale: [], missing: [] });
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

    const { validateSchema } = await import(`${pathToFileURL(join(isolated, "core", "schema", "validator.mjs")).href}?isolated=${Date.now()}`);
    const result = validateSchema("candidate.v1.schema.json", { schema: "orchestra.candidate.v1", taskId: "task-1", candidateId: "candidate-1", generation: 1, workspaceId: "primary", headSha: "abcdef1" });
    assert.deepEqual(result, { valid: true, errors: [] });
    await assert.rejects(readFile(join(isolated, "node_modules", "ajv", "package.json"), "utf8"), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(isolated, { recursive: true, force: true });
  }
});

test("runtime-core check validates schemas from the supplied fixture root without writing", async () => {
  const root = await fixtureRoot();
  try {
    await syncRuntimeCore({ repoRoot: root });
    const validatorPath = join(root, "core/schema/generated/candidate.v1.mjs");
    const mirrorPath = join(root, CODEX_MIRROR, "schema/generated/candidate.v1.mjs");
    const canonicalBefore = await readFile(validatorPath, "utf8");
    const mirrorBefore = await readFile(mirrorPath, "utf8");

    await changeFixtureCandidateSchema(root);
    const result = await checkRuntimeCore({ repoRoot: root });

    assert.equal(result.valid, false);
    assert.equal(result.reason, "SCHEMA_VALIDATOR_DRIFT");
    assert.ok(result.schema.changed.includes("candidate.v1.mjs"));
    assert.equal(await readFile(validatorPath, "utf8"), canonicalBefore);
    assert.equal(await readFile(mirrorPath, "utf8"), mirrorBefore);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runtime-core sync rejects stale canonical validators before changing mirrors", async () => {
  const root = await fixtureRoot();
  try {
    await buildSchemaValidators({ repoRoot: root });
    await syncRuntimeCore({ repoRoot: root });
    const mirrorPath = join(root, CODEX_MIRROR, "schema/generated/candidate.v1.mjs");
    const mirrorBefore = await readFile(mirrorPath, "utf8");

    await changeFixtureCandidateSchema(root);
    await assert.rejects(syncRuntimeCore({ repoRoot: root }), (error) => error?.code === "SCHEMA_VALIDATOR_DRIFT" && error?.schemaResult?.changed?.includes("candidate.v1.mjs"));

    assert.equal(await readFile(mirrorPath, "utf8"), mirrorBefore);
    await assert.rejects(syncRuntimeCore({ repoRoot: root, checkOnly: true }), { code: "SCHEMA_VALIDATOR_DRIFT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("schema validator check-only mode does not create a missing output directory", async () => {
  const root = await fixtureRoot();
  const outputDir = join(root, "core/schema/check-only-output");
  try {
    await rm(outputDir, { recursive: true, force: true });
    const result = await buildSchemaValidators({ checkOnly: true, repoRoot: root, outputDir });
    assert.equal(result.missing.length, SCHEMA_FILES.length);
    await assert.rejects(access(outputDir), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
