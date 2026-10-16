import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const instructions = fileURLToPath(new URL("../../runtimes/codex/.codex/astra-orchestra/INSTRUCTIONS.md", import.meta.url));

const text = readFileSync(instructions, "utf8");

test("Codex instructions keep serial work default while permitting validated PARALLEL_2 execution", () => {
  assert.match(text, /serial.*default/i);
  assert.match(text, /PARALLEL_2/i);
  assert.match(text, /exactly two.*implementation.*workers/i);
  assert.match(text, /disjoint.*mutation.*scopes/i);
  assert.match(text, /independent hardened clones/i);
  assert.match(text, /do not.*parallel writers.*except.*PARALLEL_2/i);
});
