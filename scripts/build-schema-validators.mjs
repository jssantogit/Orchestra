import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";
import standaloneCode from "ajv/dist/standalone/index.js";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const schemaDir = join(repoRoot, "schemas");
const generatedDir = join(repoRoot, "core", "schema", "generated");

export const SCHEMA_FILES = Object.freeze([
  "audit-result.v1.schema.json",
  "candidate.v1.schema.json",
  "evidence.v1.schema.json",
  "implementation-packet.v1.schema.json",
  "runtime-event.v1.schema.json",
  "scope-contract.v2.schema.json",
  "work-lease.v1.schema.json",
]);

function outputName(schemaFile) {
  return schemaFile.replace(/\.schema\.json$/, ".mjs");
}

function makeDependencyFree(moduleCode, schemaFile) {
  const withInlineLength = moduleCode.replace(
    /const (func\d+) = require\("ajv\/dist\/runtime\/ucs2length"\)\.default;/g,
    "const $1 = (value) => [...value].length;",
  );

  if (/require\(["']ajv\//.test(withInlineLength) || /from ["']ajv\//.test(withInlineLength)) {
    throw new Error(`Generated validator still depends on Ajv runtime: ${schemaFile}`);
  }

  return withInlineLength;
}

async function compileSchema(schemaFile) {
  const schema = JSON.parse(await readFile(join(schemaDir, schemaFile), "utf8"));
  const ajv = new Ajv2020({
    allErrors: true,
    strict: true,
    validateSchema: true,
    code: { source: true, esm: true, optimize: true },
  });
  const validate = ajv.compile(schema);
  const moduleCode = standaloneCode(ajv, validate);
  return `${makeDependencyFree(moduleCode, schemaFile).trimEnd()}\n`;
}

export async function buildSchemaValidators({ checkOnly = false, outputDir = generatedDir } = {}) {
  const changed = [];
  const missing = [];
  await mkdir(outputDir, { recursive: true });

  for (const schemaFile of SCHEMA_FILES) {
    const outputPath = join(outputDir, outputName(schemaFile));
    const expected = await compileSchema(schemaFile);
    let current = null;
    try {
      current = await readFile(outputPath, "utf8");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }

    if (current === expected) continue;
    if (current === null) missing.push(outputName(schemaFile));
    else changed.push(outputName(schemaFile));
    if (!checkOnly) await writeFile(outputPath, expected, "utf8");
  }

  return { changed, missing };
}

async function main() {
  const checkOnly = process.argv.includes("--check");
  const result = await buildSchemaValidators({ checkOnly });
  const drift = [...result.missing, ...result.changed];

  if (checkOnly && drift.length > 0) {
    console.error(`Schema validator drift: ${drift.join(", ")}`);
    process.exitCode = 1;
    return;
  }

  if (checkOnly) console.log("Schema validators: OK");
  else console.log(`Schema validators generated: ${SCHEMA_FILES.length}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
