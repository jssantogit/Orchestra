#!/usr/bin/env node
import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const schemaDir = join(repoRoot, "schemas");
const generatedDir = join(repoRoot, "core", "schema", "generated");

function outputName(schemaFile) {
  return schemaFile.replace(/\.schema\.json$/, ".mjs");
}

function renderModule(schema) {
  const json = JSON.stringify(schema, null, 2);
  return `// GENERATED FILE. DO NOT EDIT.\nimport { validateAgainstSchema } from "../runtime-validator.mjs";\n\nexport const schema = Object.freeze(${json});\nexport const schemaId = schema.$id;\nexport function validate(value) {\n  return validateAgainstSchema(schema, value);\n}\nexport default validate;\n`;
}

export async function buildSchemaValidators({ checkOnly = false, outputDir = generatedDir } = {}) {
  const schemaFiles = (await readdir(schemaDir)).filter((name) => name.endsWith(".schema.json")).sort();
  const changed = [];
  const missing = [];
  await mkdir(outputDir, { recursive: true });

  for (const schemaFile of schemaFiles) {
    const schema = JSON.parse(await readFile(join(schemaDir, schemaFile), "utf8"));
    const target = join(outputDir, outputName(schemaFile));
    const expected = renderModule(schema);
    let actual = null;
    try { actual = await readFile(target, "utf8"); } catch {}
    if (actual === null) missing.push(target);
    else if (actual !== expected) changed.push(target);
    if (!checkOnly && actual !== expected) await writeFile(target, expected);
  }

  return { changed, missing, count: schemaFiles.length };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const checkOnly = process.argv.includes("--check");
  const result = await buildSchemaValidators({ checkOnly });
  if (checkOnly && (result.changed.length || result.missing.length)) {
    console.error(`Schema validator drift: changed=${result.changed.length} missing=${result.missing.length}`);
    process.exit(1);
  }
  console.log(checkOnly ? `Schema validators: OK (${result.count})` : `Schema validators built: ${result.count}`);
}
