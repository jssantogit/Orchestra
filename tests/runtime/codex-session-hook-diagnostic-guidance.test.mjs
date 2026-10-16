import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const instructions = fileURLToPath(new URL("../../runtimes/codex/.codex/astra-orchestra/INSTRUCTIONS.md", import.meta.url));

test("Codex runtime instructions forbid environment-derived session identity for Work Lease diagnostics", () => {
  const text = readFileSync(instructions, "utf8");
  assert.match(text, /do not use.*CODEX_SESSION_ID/i);
  assert.match(text, /hook.*session_id.*stdin/i);
  assert.match(text, /PreToolUse.*authoritative.*current session/i);
});
