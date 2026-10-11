import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ORCHESTRATOR_HANDOFF_MODES,
  ORCHESTRATOR_HANDOFF_STATUSES,
  prepareOrchestratorHandoffRecord,
  validateOrchestratorHandoffRecord,
} from "../../runtimes/antigravity/.agents/skills/orchestra/orchestrator-handoff.mjs";
import {
  classifyOrchestratorHandoffControlCommand,
} from "../../runtimes/antigravity/.agents/hooks/pre-tool-enforce.mjs";

const root = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const read = (path) => readFileSync(resolve(root, path), "utf8");

const handoff = read("runtimes/antigravity/.agents/skills/orchestra/orchestrator-handoff.mjs");
const leaseAuthority = read("runtimes/antigravity/.agents/skills/orchestra/work-lease-authority.mjs");
const preInvocation = read("runtimes/antigravity/.agents/hooks/pre-invocation-guard.mjs");
const preInvocationLease = read("runtimes/antigravity/.agents/hooks/work-lease-pre-invocation.mjs");
const preTool = read("runtimes/antigravity/.agents/hooks/pre-tool-enforce.mjs");
const preToolLease = read("runtimes/antigravity/.agents/hooks/work-lease-pre-tool.mjs");
const hooks = JSON.parse(read("runtimes/antigravity/.agents/hooks.json"));
const evidence = read("runtimes/antigravity/.agents/skills/orchestra/evidence-contract.mjs");
const codexPolicy = read("runtimes/codex/.codex/astra-orchestra/routing-policy.mjs");

test("ARCH-N01: session handoff remains single-use recovery state, not transcript migration or primary lease authority", () => {
  assert.match(handoff, /orchestrator-handoff\.json/);
  assert.match(handoff, /ARMED/);
  assert.match(handoff, /CLAIMED/);
  assert.match(handoff, /CANCELLED/);
  assert.match(handoff, /state_fingerprint/);
  assert.match(handoff, /record_hash/);
  assert.match(handoff, /FORMER_ORCHESTRATOR/);
  assert.match(handoff, /authorityStatus:\s*"TRANSFERRED"/);
  for (const forbidden of ["transcript", "messages", "reasoning", "thinking", "stdout", "stderr", "credentials", "environment"]) {
    assert.match(handoff, new RegExp('"' + forbidden + '"'));
  }
  assert.match(leaseAuthority, /sessionIdHash/);
  assert.match(leaseAuthority, /STALE_WORK_LEASE/);
});

test("ARCH-N02: milestone boundary never carries old Scope Contract or evidence ledger", () => {
  const activeState = {
    taskId: "closed",
    state: "DONE",
    acceptanceState: "ACCEPTED",
    mutationSeq: 2,
    conversationId: "old-root",
    scopeContract: {
      allowedPaths: ["secret-old-scope/**"],
      requiredEvidence: [{ id: "old-proof", class: "LOCAL_TEST", kind: "LOCAL_COMMAND", command: "npm test" }],
    },
    evidenceLedger: [{ evidenceId: "old-evidence", stdout: "old-output" }],
  };
  const roleBindings = {
    mainConversationId: "old-root",
    bindings: {
      "old-root": {
        role: "ORCHESTRATOR",
        profile: "flash-orchestrator",
        source: "RUNTIME_BOOTSTRAP",
        confidence: "HIGH",
      },
    },
    pendingSubagents: [],
  };
  const record = prepareOrchestratorHandoffRecord({
    activeState,
    activeContract: activeState.scopeContract,
    roleBindings,
    mode: ORCHESTRATOR_HANDOFF_MODES.MILESTONE_BOUNDARY,
  });
  assert.equal(record.status, ORCHESTRATOR_HANDOFF_STATUSES.ARMED);
  assert.equal(validateOrchestratorHandoffRecord(record).valid, true);
  const encoded = JSON.stringify(record.capsule);
  assert.equal(encoded.includes("secret-old-scope"), false);
  assert.equal(encoded.includes("old-proof"), false);
  assert.equal(encoded.includes("old-evidence"), false);
  assert.equal(encoded.includes("old-output"), false);
});

test("ARCH-N03: Work Lease wrapper owns normal fresh-root claim; legacy handoff claim remains recovery implementation", () => {
  assert.equal(hooks["guard-rails"].PreInvocation[0].command, "node hooks/work-lease-pre-invocation.mjs");
  assert.match(preInvocationLease, /enterAntigravityWorkLease/);
  assert.match(preInvocationLease, /WORK LEASE AUTHORITY/);
  assert.match(preInvocationLease, /Manual orchestrator handoff is recovery-only/);

  const claim = preInvocation.indexOf("claimProjectOrchestratorHandoff");
  const mismatch = preInvocation.indexOf("KNOWN_MAIN_MISMATCH");
  assert.ok(claim >= 0);
  assert.ok(mismatch > claim);
  assert.match(preInvocation, /ORCHESTRATOR AUTHORITY HANDOFF CLAIMED/);
});

test("ARCH-N04: mainConversationId is compatibility projection while Work Lease fences root tools", () => {
  assert.match(preInvocationLease, /roleBindings\.mainConversationId = convId/);
  assert.match(preInvocationLease, /workLeaseGeneration/);
  assert.equal(hooks["scope-enforcer"].PreToolUse[0].hooks[0].command, "node hooks/work-lease-pre-tool.mjs");
  assert.match(preToolLease, /authorizeAntigravityLeaseCapability/);
  assert.match(preToolLease, /ORCHESTRA_WORK_LEASE_AUTHORITY_DENIED/);

  assert.match(preTool, /actorIsCurrentMain/);
  assert.match(preTool, /actor\.actorId\s*===\s*roleBindings\.mainConversationId/);
  assert.match(preTool, /ORCHESTRATOR_AUTHORITY_TRANSFERRED/);
  assert.match(preTool, /FORMER_ORCHESTRATOR/);
});

test("ARCH-N05: model-visible handoff control cannot manually claim or inject shell", () => {
  assert.equal(
    classifyOrchestratorHandoffControlCommand(
      "node .agents/skills/orchestra/orchestrator-handoff-cli.mjs prepare --boundary"
    )?.operation,
    "prepare",
  );
  assert.equal(
    classifyOrchestratorHandoffControlCommand(
      "node .agents/skills/orchestra/orchestrator-handoff-cli.mjs claim --conversation-id stolen"
    ),
    null,
  );
  assert.equal(
    classifyOrchestratorHandoffControlCommand(
      "node .agents/skills/orchestra/orchestrator-handoff-cli.mjs prepare --boundary && rm -rf ."
    ),
    null,
  );
});

test("ARCH-N06: handoff provenance is root-only evidence authority", () => {
  assert.match(evidence, /\["RUNTIME_IDENTITY", "CONVERSATION_BOUND_IDENTITY", "ORCHESTRATOR_HANDOFF"\]/);
  const delegatedStart = evidence.indexOf("const delegatedValidation");
  const parentStart = evidence.indexOf("const parentValidation", delegatedStart);
  assert.ok(delegatedStart >= 0 && parentStart > delegatedStart);
  const delegatedBlock = evidence.slice(delegatedStart, parentStart);
  assert.match(delegatedBlock, /producer\.source\s*===\s*"RUNTIME_IDENTITY"/);
  assert.doesNotMatch(delegatedBlock, /ORCHESTRATOR_HANDOFF/);
});

test("ARCH-N07: Codex runtime does not gain fake Antigravity conversation authority", () => {
  assert.doesNotMatch(codexPolicy, /ORCHESTRATOR_HANDOFF|mainConversationId|orchestrator-handoff\.json/);
  assert.doesNotMatch(handoff, /runtimes[\\/]codex|(?:from|import|require)\s+["'][^"']*\.codex/i);
  assert.doesNotMatch(leaseAuthority, /runtimes[\\/]codex|\.codex\/astra-orchestra/);
  assert.doesNotMatch(handoff, /gpt-5\.6-|gpt-6-astra|CODEX_MODELS|codex-runtime-manager/i);
});
