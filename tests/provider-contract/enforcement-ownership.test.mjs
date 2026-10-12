import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function source(path) {
  return readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
}

test("Codex session hook composes provider normalization with neutral authorization owners", () => {
  const text = source("runtimes/codex/.codex/astra-orchestra/session-hook.mjs");
  assert.match(text, /provider\/codex\/adapter\/tool-event\.mjs/);
  assert.match(text, /core\/policy\/capability-authorization\.mjs/);
  assert.match(text, /core\/policy\/mutation-authorization\.mjs/);
  assert.match(text, /authorizeMutation\s*\(/);
});

test("Antigravity Work Lease pre-tool entrypoint composes provider normalization with neutral authorization", () => {
  const text = source("runtimes/antigravity/.agents/hooks/work-lease-pre-tool.mjs");
  assert.match(text, /provider\/antigravity\/adapter\/tool-event\.mjs/);
  assert.match(text, /core\/policy\/mutation-authorization\.mjs/);
  assert.match(text, /authorizeMutation\s*\(/);
});

test("provider stop and telemetry entrypoints invoke neutral owners behind compatibility facades", () => {
  const stop = source("runtimes/antigravity/.agents/hooks/stop-guard.mjs");
  const telemetry = source("runtimes/antigravity/.agents/hooks/post-tool-telemetry.mjs");
  assert.match(stop, /core\/acceptance\/stop-decision\.mjs/);
  assert.match(stop, /evaluateStopDecision\s*\(/);
  assert.match(telemetry, /core\/events\/runtime-event\.mjs/);
  assert.match(telemetry, /provider\/antigravity\/adapter\/telemetry\.mjs/);
  assert.match(telemetry, /createRuntimeEvent\s*\(/);
});
