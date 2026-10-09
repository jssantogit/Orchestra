import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildSchemaValidators } from "./build-schema-validators.mjs";
import { syncRuntimeCore } from "./sync-runtime-core.mjs";

function hasDrift(result) {
  return result.changed.length > 0 || result.stale.length > 0 || result.missing.length > 0;
}

export async function checkRuntimeCore({ repoRoot }) {
  const schemaResult = await buildSchemaValidators({ checkOnly: true, repoRoot });
  if (schemaResult.changed.length || schemaResult.missing.length) {
    return {
      valid: false,
      reason: "SCHEMA_VALIDATOR_DRIFT",
      schema: schemaResult,
      mirrors: null,
    };
  }

  const mirrors = await syncRuntimeCore({ repoRoot, checkOnly: true });
  return {
    valid: !hasDrift(mirrors),
    reason: hasDrift(mirrors) ? "RUNTIME_CORE_DRIFT" : "OK",
    schema: schemaResult,
    mirrors,
  };
}

async function main() {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(scriptDir, "..");
  const result = await checkRuntimeCore({ repoRoot });
  if (!result.valid) {
    console.error(`Runtime core mirror: ${result.reason}`);
    if (result.mirrors) console.error(JSON.stringify(result.mirrors));
    process.exitCode = 1;
    return;
  }
  console.log("Runtime core mirror: OK");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
