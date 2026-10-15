import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";
import standaloneCode from "ajv/dist/standalone/index.js";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = resolve(scriptDir, "..");

export const SCHEMA_FILES = Object.freeze([
  "audit-result.v1.schema.json",
  "candidate.v1.schema.json",
  "delegation-request.v1.schema.json",
  "delegation-request.v2.schema.json",
  "delegation-result.v1.schema.json",
  "delegation-result.v2.schema.json",
  "evidence.v1.schema.json",
  "implementation-packet.v1.schema.json",
  "runtime-event.v1.schema.json",
  "scope-contract.v2.schema.json",
  "work-lease.v1.schema.json",
]);

function outputName(schemaFile) {
  return schemaFile.replace(/\.schema\.json$/, ".mjs");
}

function normalizeLineEndings(value) {
  return String(value).replace(/\r\n/g, "\n");
}

const INLINE_JSON_EQUAL = `function jsonEqual(left, right) {
  if (left === right) return true;
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    for (let index = 0; index < left.length; index += 1) if (!jsonEqual(left[index], right[index])) return false;
    return true;
  }
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  for (const key of leftKeys) {
    if (!Object.prototype.hasOwnProperty.call(right, key) || !jsonEqual(left[key], right[key])) return false;
  }
  return true;
}`;

function makeDependencyFree(moduleCode, schemaFile) {
  let dependencyFree = moduleCode.replace(
    /const (func\d+) = require\("ajv\/dist\/runtime\/ucs2length"\)\.default;/g,
    "const $1 = (value) => [...value].length;",
  );
  dependencyFree = dependencyFree.replace(
    /const (func\d+) = require\("ajv\/dist\/runtime\/equal"\)\.default;/g,
    (_match, name) => `const ${name} = ${INLINE_JSON_EQUAL};`,
  );

  const runtimeDependencies = [...dependencyFree.matchAll(/(?:require\(|from\s+)["'](ajv\/[^"']+)["']/g)]
    .map((match) => match[1]);
  if (runtimeDependencies.length > 0) {
    throw new Error(`Generated validator still depends on Ajv runtime: ${schemaFile}: ${[...new Set(runtimeDependencies)].join(", ")}`);
  }

  return dependencyFree;
}

async function readSchemas(schemaDir) {
  const entries = await Promise.all(SCHEMA_FILES.map(async (schemaFile) => [
    schemaFile,
    JSON.parse(await readFile(join(schemaDir, schemaFile), "utf8")),
  ]));
  return new Map(entries);
}

async function compileSchema(schemaFile, schemaDir) {
  const schemas = await readSchemas(schemaDir);
  const target = schemas.get(schemaFile);
  const ajv = new Ajv2020({
    allErrors: true,
    strict: true,
    validateSchema: true,
    code: { source: true, esm: true, optimize: true },
  });
  for (const schema of schemas.values()) ajv.addSchema(schema);
  const validate = ajv.getSchema(target.$id);
  if (!validate) throw new Error(`Unable to resolve schema validator: ${schemaFile}`);
  const moduleCode = standaloneCode(ajv, validate);
  return `${makeDependencyFree(moduleCode, schemaFile).trimEnd()}\n`;
}

export async function buildSchemaValidators({
  checkOnly = false,
  repoRoot = defaultRepoRoot,
  schemaDir: schemaDirOption,
  outputDir: outputDirOption,
} = {}) {
  const root = resolve(repoRoot);
  const schemaDir = resolve(root, schemaDirOption || join(root, "schemas"));
  const outputDir = resolve(root, outputDirOption || join(root, "core", "schema", "generated"));
  const changed = [];
  const missing = [];
  if (!checkOnly) await mkdir(outputDir, { recursive: true });

  for (const schemaFile of SCHEMA_FILES) {
    const outputPath = join(outputDir, outputName(schemaFile));
    const expected = await compileSchema(schemaFile, schemaDir);
    let current = null;
    try {
      current = await readFile(outputPath, "utf8");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }

    if (current !== null && normalizeLineEndings(current) === expected) continue;
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
