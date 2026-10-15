import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const validatorPath = fileURLToPath(new URL("../../core/schema/generated/parallel-implementation-group.v1.mjs", import.meta.url));

test("temporary capture of generated parallel implementation validator", () => {
  const content = readFileSync(validatorPath);
  console.log(`ORCHESTRA_PARALLEL_VALIDATOR_BASE64=${content.toString("base64")}`);
  assert.fail("ORCHESTRA_PARALLEL_VALIDATOR_CAPTURE_COMPLETE");
});
