#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { syncRuntimeCore } from "./sync-runtime-core.mjs";

export async function checkRuntimeCore(options = {}) {
  const result = await syncRuntimeCore({ ...options, checkOnly: true });
  return {
    ok: result.missing.length === 0 && result.stale.length === 0,
    ...result,
  };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const result = await checkRuntimeCore();
  if (!result.ok) {
    console.error(`Runtime core mirror: DRIFT missing=${result.missing.length} stale=${result.stale.length}`);
    process.exit(1);
  }
  console.log("Runtime core mirror: OK");
}
