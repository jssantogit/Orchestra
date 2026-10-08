import test from "node:test";
import assert from "node:assert/strict";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");

const validPacket = {
  schema: "orchestra.implementation-packet.v1",
  taskId: "t1",
  candidateGeneration: 0,
  goal: "change one behavior",
  direction: { cause: "known", change: "apply known fix", preserve: [] },
  anchors: [{ symbol: "Known.symbol" }],
  scope: { allowedAreas: ["src/**"], forbidden: [] },
  permissions: { discovery: "DIRECTED", tests: "READ_ONLY", sideEffects: ["WORKSPACE_EDIT"] },
  validation: ["focused tests"],
  failurePolicy: { selfCaused: "REPAIR", unrelatedOrUncertain: "RETURN_TO_CONTROL" },
};

test("schema validator runs from copied core with no package dependencies", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "orchestra-schema-"));
  try {
    const fixtureCore = join(fixture, "core", "schema");
    await cp(join(repoRoot, "core", "schema"), fixtureCore, { recursive: true });
    await writeFile(join(fixture, "package.json"), JSON.stringify({ type: "module" }));

    const validator = await import(pathToFileURL(join(fixtureCore, "validator.mjs")).href);
    const valid = validator.validateSchema("implementation-packet.v1.schema.json", validPacket);
    const invalid = validator.validateSchema("implementation-packet.v1.schema.json", { ...validPacket, unexpected: true });

    assert.equal(valid.valid, true, JSON.stringify(valid.errors));
    assert.equal(invalid.valid, false);
    assert.ok(invalid.errors.some((error) => error.keyword === "additionalProperties"));
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
