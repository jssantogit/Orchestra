import test from "node:test";
import assert from "node:assert/strict";
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { buildSchemaValidators, SCHEMA_FILES } from "../../scripts/build-schema-validators.mjs";

const orchestraRoot = fileURLToPath(new URL("../../", import.meta.url));

function outputName(schemaFile) {
  return schemaFile.replace(/\.schema\.json$/, ".mjs");
}

test("schema freshness treats CRLF checkout conversion as content-equivalent", async () => {
  const root = await mkdtemp(join(tmpdir(), "orchestra-schema-crlf-"));
  try {
    await mkdir(join(root, "core", "schema"), { recursive: true });
    await cp(join(orchestraRoot, "schemas"), join(root, "schemas"), { recursive: true });

    const generated = await buildSchemaValidators({ repoRoot: root });
    assert.equal(generated.missing.length, SCHEMA_FILES.length);

    for (const schemaFile of SCHEMA_FILES) {
      const path = join(root, "core", "schema", "generated", outputName(schemaFile));
      const lf = await readFile(path, "utf8");
      await writeFile(path, lf.replace(/\n/g, "\r\n"), "utf8");
    }

    const check = await buildSchemaValidators({ repoRoot: root, checkOnly: true });
    assert.deepEqual(check, { changed: [], missing: [] });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
