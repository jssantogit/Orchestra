import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import standaloneCode from 'ajv/dist/standalone/index.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const schemaDir = join(repoRoot, 'schemas');
const outputDir = join(repoRoot, 'core', 'schema', 'generated');
const schemas = [
  'implementation-packet.v1.schema.json',
  'scope-contract.v2.schema.json',
  'candidate.v1.schema.json',
  'evidence.v1.schema.json',
  'audit-result.v1.schema.json',
  'work-lease.v1.schema.json',
  'runtime-event.v1.schema.json',
];

function generatedSource(schemaFile) {
  const schema = JSON.parse(readFileSync(join(schemaDir, schemaFile), 'utf8'));
  const ajv = new Ajv2020({ allErrors: true, strict: true, code: { source: true, esm: true } });
  const validate = ajv.compile(schema);
  return `// GENERATED from schemas/${schemaFile}; do not edit.\n${standaloneCode(ajv, validate)}\n`;
}

let drift = false;
mkdirSync(outputDir, { recursive: true });
for (const schemaFile of schemas) {
  const outFile = join(outputDir, schemaFile.replace('.schema.json', '.mjs'));
  const source = generatedSource(schemaFile);
  if (process.argv.includes('--check')) {
    if (!existsSync(outFile) || readFileSync(outFile, 'utf8') !== source) {
      console.error(`SCHEMA_VALIDATOR_DRIFT:${schemaFile}`);
      drift = true;
    }
  } else {
    writeFileSync(outFile, source);
  }
}
if (drift) process.exitCode = 1;
