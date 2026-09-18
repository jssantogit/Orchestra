import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../..");
const labPath = resolve(repoRoot, "runtimes/antigravity/.agents/dream/policy-lab.mjs");
const preToolPath = resolve(repoRoot, "runtimes/antigravity/.agents/hooks/pre-tool-enforce.mjs");
const hooksPath = resolve(repoRoot, "runtimes/antigravity/.agents/hooks.json");
const designerPath = resolve(repoRoot, "runtimes/antigravity/.agents/agents/flash-policy-designer.md");

test("ARCH-F01: Policy Lab has zero online routing authority", () => {
  const preTool = readFileSync(preToolPath, "utf8");
  const hooks = readFileSync(hooksPath, "utf8");
  assert.equal(preTool.includes("policy-lab"), false);
  assert.equal(preTool.includes("flash-policy-designer"), false);
  assert.equal(hooks.includes("policy-lab"), false);
  assert.equal(hooks.includes("flash-policy-designer"), false);
});

test("ARCH-F02: flash-policy-designer is tool-less and cannot mutate or inspect runtime state", () => {
  const profile = readFileSync(designerPath, "utf8");
  assert.match(profile, /model:\s*gemini-3\.8-flash-high/);
  assert.match(profile, /mainAgent:\s*false/);
  assert.match(profile, /subagent:\s*true/);
  assert.match(profile, /tools:\s*\[\]/);
  assert.equal(/\n\s*-\s+(?:view_file|grep_search|find_by_name|run_command|write_to_file|replace_file_content|send_message)\b/.test(profile), false);
});

test("ARCH-F03: Policy Lab cannot activate policy or invoke models", () => {
  const source = readFileSync(labPath, "utf8");
  assert.equal(source.includes("node:child_process"), false);
  assert.equal(source.includes("spawnSync"), false);
  assert.equal(source.includes("execFileSync"), false);
  assert.equal(source.includes("fetch("), false);
  assert.equal(source.includes("active.json"), false);
  assert.equal(source.includes("policies/versions"), false);
  assert.equal(source.includes("auto_promote"), false);
  assert.match(source, /activation_allowed:\s*false/);
  assert.match(source, /next_milestone_required_for_activation:\s*"SHADOW_MODE"/);
});

test("ARCH-F04: Policy Lab persistent writes stay under Dream data, never runtime policy source", () => {
  const source = readFileSync(labPath, "utf8");
  assert.match(source, /const LAB_ROOT = "\.agents\/dream-data\/policy-lab"/);
  assert.equal(source.includes("writeFileSync(resolve(repoRoot, \".agents/dream/policies"), false);
  assert.equal(source.includes("atomicJson(resolve(repoRoot, \".agents/dream/policies"), false);
});
