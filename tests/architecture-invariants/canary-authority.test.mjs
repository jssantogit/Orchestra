import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../..");
const canaryPath = resolve(repoRoot, "runtimes/antigravity/.agents/dream/canary-mode.mjs");
const policyStorePath = resolve(repoRoot, "runtimes/antigravity/.agents/dream/policy-store.mjs");
const preToolPath = resolve(repoRoot, "runtimes/antigravity/.agents/hooks/pre-tool-enforce.mjs");
const stopPath = resolve(repoRoot, "runtimes/antigravity/.agents/hooks/stop-guard.mjs");
const outcomePath = resolve(repoRoot, "runtimes/antigravity/.agents/dream/outcome-recorder.mjs");
const cliPath = resolve(repoRoot, "runtimes/antigravity/.agents/dream/canary-cli.mjs");

test("ARCH-H01: Canary live authority is fixed to 5 percent NORMAL-only tasks", () => {
  const source = readFileSync(canaryPath, "utf8");
  assert.match(source, /initial_traffic_percent:\s*5/);
  assert.match(source, /allowed_criticality:\s*"NORMAL"/);
  assert.match(source, /CANARY_NORMAL_ONLY/);
  assert.match(source, /CANARY_TWO_KEY_EXCLUDED/);
  assert.match(source, /CANARY_CRITICAL_PATH_EXCLUDED/);
  assert.match(source, /CANARY_SCOPE_NOT_LOCAL_REVERSIBLE/);
});

test("ARCH-H02: static/current policy is evaluated before Canary may overlay execution", () => {
  const source = readFileSync(preToolPath, "utf8");
  const staticEval = source.indexOf("const evalRes = evaluatePolicy({");
  const canaryEval = source.indexOf("const canary = evaluateCanaryPolicyOverlay({");
  assert.ok(staticEval >= 0);
  assert.ok(canaryEval > staticEval);
  assert.match(source, /if \(staticResult\.ok\)/);
  assert.match(source, /source:\s*canary\.source/);
});

test("ARCH-H03: Canary has hard rollback hooks for side effects, governance, evidence and exact regression", () => {
  const preTool = readFileSync(preToolPath, "utf8");
  const stop = readFileSync(stopPath, "utf8");
  const outcome = readFileSync(outcomePath, "utf8");
  const canary = readFileSync(canaryPath, "utf8");
  assert.match(preTool, /EXTERNAL_SIDE_EFFECT_ATTEMPT/);
  assert.match(preTool, /GOVERNANCE_MODIFICATION_ATTEMPT/);
  assert.match(stop, /REQUIRED_EVIDENCE_BYPASS_ATTEMPT/);
  assert.match(outcome, /evaluateCanaryOutcome/);
  assert.match(canary, /EXACT_PROVEN_REGRESSION/);
  assert.match(canary, /ILLEGAL_ACTION/);
  assert.match(canary, /POLICY_OR_SCHEMA_CORRUPTION/);
});

test("ARCH-H04: human approval is required separately for Canary and final promotion", () => {
  const canary = readFileSync(canaryPath, "utf8");
  const cli = readFileSync(cliPath, "utf8");
  assert.match(canary, /EXPLICIT_HUMAN_APPROVAL_REQUIRED/);
  assert.match(canary, /EXPLICIT_HUMAN_PROMOTION_REQUIRED/);
  assert.match(canary, /approved_by:\s*"HUMAN_EXPLICIT_CLI"/);
  assert.match(cli, /--confirm is required for human Canary approval/);
  assert.match(cli, /--confirm is required for human policy promotion/);
  assert.match(cli, /--confirm is required for human active-policy rollback/);
  assert.equal(canary.includes("auto_promote"), false);
});

test("ARCH-H05: promoted policy pointer is versioned and atomically fsynced before rename", () => {
  const store = readFileSync(policyStorePath, "utf8");
  assert.match(store, /\.agents\/dream-data\/policies\/active\.json/);
  assert.match(store, /\.agents\/dream-data\/policies\/versions/);
  assert.match(store, /fsyncSync\(fd\)/);
  assert.match(store, /renameSync\(temp, path\)/);
  assert.match(store, /ACTIVE_POLICY_POINTER_INVALID/);
  assert.match(store, /STATIC_ROUTING_FALLBACK/);
  assert.match(store, /HUMAN_EXPLICIT_CLI/);
  assert.match(store, /POLICY_PROMOTED/);
  assert.match(store, /POLICY_ROLLBACK/);
  assert.match(store, /previous_policy_id/);
  assert.match(store, /EXPLICIT_HUMAN_POLICY_ROLLBACK_REQUIRED/);
});
