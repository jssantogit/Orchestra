import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../../runtimes/codex/.codex/astra-orchestra/work-lease-diagnostic-cli.mjs", import.meta.url));

test("diagnostic help requires hook-provided session identity and rejects environment inference guidance", () => {
  const output = execFileSync(process.execPath, [cli, "--help"], { encoding: "utf8" });
  assert.match(output, /factual Codex hook session_id/i);
  assert.match(output, /do not infer.*environment variable/i);
});
