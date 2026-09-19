import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CODEX_DREAM_AUTHORITY,
  CODEX_DREAM_LIMITS,
  createCodexCanaryApproval,
  createCodexDreamWorld,
  createCodexPolicyCandidate,
  createCodexShadowDecision,
  replayCodexPolicyCandidate,
} from "../../runtimes/codex/.codex/astra-orchestra/dream-lab.mjs";
import {
  authorizeToolCapability,
  SIDE_EFFECT_CAPABILITIES,
} from "../../runtimes/codex/.codex/astra-orchestra/trust-boundary.mjs";
import {
  createCodexWorkerPacket,
} from "../../runtimes/codex/.codex/astra-orchestra/context-packet.mjs";
import {
  CODEX_MANAGED_RUNTIME_PATHS,
  CODEX_PRESERVED_PROJECT_PATHS,
} from "../../runtimes/codex/.codex/astra-orchestra/codex-runtime-manager.mjs";

const root = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const codexOrchestraDir = join(root, "runtimes/codex/.codex/astra-orchestra");

test("ARCH-M01: active Codex modules never import Antigravity operational code", () => {
  const files = readdirSync(codexOrchestraDir).filter((name) => name.endsWith(".mjs"));
  for (const name of files) {
    const source = readFileSync(join(codexOrchestraDir, name), "utf8");
    assert.equal(
      /(?:from|import|require)\s+["'][^"']*(?:runtimes[\\/]antigravity|\.agents[\\/])/i.test(source),
      false,
      name + " must not import Antigravity runtime code",
    );
  }
});

test("ARCH-M02: feedback metadata has no acceptance/evidence authority primitive", () => {
  const source = readFileSync(join(codexOrchestraDir, "feedback-plane.mjs"), "utf8");
  assert.equal(/acceptanceState\s*=|accepted\s*=\s*true|satisf(?:y|ies)Evidence/i.test(source), false);
});

test("ARCH-M03: remote side effects are default-deny in Codex", () => {
  const result = authorizeToolCapability({
    toolName: "exec_command",
    toolArgs: { command: "git push origin main" },
    activeState: { taskAction: "IMPLEMENT" },
    activeContract: {},
  });
  assert.equal(result.allowed, false);
  assert.equal(result.capability, SIDE_EFFECT_CAPABILITIES.VCS_REMOTE_WRITE);
});

test("ARCH-M04: Codex worker packets reject provider transcript authority", () => {
  assert.throws(() => createCodexWorkerPacket({
    task: { goal: "x" },
    scopeContract: {
      taskAction: "IMPLEMENT",
      taskDomain: "CODE",
      requiredEvidence: [{ id: "bad", class: "LOCAL_FACT", kind: "LOCAL_FACT", transcript: "raw" }],
    },
  }), /CODEX_PACKET_FORBIDDEN_FIELD/);
});

test("ARCH-M05: Codex Dream remains zero-authority until explicit human canary and never rewrites source", () => {
  const world = createCodexDreamWorld({ activeState: { taskId: "m05", state: "BLOCKED" } });
  const candidate = createCodexPolicyCandidate({
    policy_key: "validation-depth",
    decision_class: "VALIDATION_DEPTH",
    parameters: { stages: 2 },
  });
  const replay = replayCodexPolicyCandidate({ world, candidate, evaluation: { accepted_behavior_preserved: true } });
  const shadow = createCodexShadowDecision({ replay });
  assert.equal(world.authority, CODEX_DREAM_AUTHORITY);
  assert.equal(candidate.authority, CODEX_DREAM_AUTHORITY);
  assert.equal(replay.authority, CODEX_DREAM_AUTHORITY);
  assert.equal(shadow.authority, CODEX_DREAM_AUTHORITY);
  assert.equal(shadow.runtime_effect, "NONE");
  assert.equal(shadow.source_rewrite, false);
  const canary = createCodexCanaryApproval({ shadow, approved: true, approvedBy: "human" });
  assert.equal(canary.authority, "HUMAN_GATE");
  assert.equal(canary.automatic_activation, false);
  assert.equal(canary.source_rewrite, false);
});

test("ARCH-M06: Codex exploration ceilings cannot exceed hard limits", () => {
  assert.deepEqual(CODEX_DREAM_LIMITS, {
    max_branches: 3,
    max_parallel: 1,
    max_total_model_calls: 6,
    timeout_ms: 900000,
  });
});

test("ARCH-M07: Codex runtime manager owns code and preserves state in disjoint namespaces", () => {
  assert.deepEqual(CODEX_MANAGED_RUNTIME_PATHS, [
    ".codex/config.toml",
    ".codex/agents",
    ".codex/astra-orchestra",
  ]);
  for (const preserved of CODEX_PRESERVED_PROJECT_PATHS) {
    assert.equal(
      CODEX_MANAGED_RUNTIME_PATHS.some((managed) => preserved === managed || preserved.startsWith(managed + "/")),
      false,
      preserved + " must not be managed runtime code",
    );
  }
});

test("ARCH-M08: Codex parity source contains no Jev service route or provider contamination", () => {
  const files = readdirSync(codexOrchestraDir).filter((name) => name.endsWith(".mjs"));
  for (const name of files) {
    const source = readFileSync(join(codexOrchestraDir, name), "utf8");
    assert.equal(/api\.typesafe\.ai|TYPESAFE_API_KEY|jev-latest|experiments[\\/]jev/i.test(source), false, name);
    const activeLines = source.split("\n").filter((line) => /(?:model|provider|executor|profile)\s*[:=]/i.test(line));
    assert.equal(activeLines.some((line) => /gemini-|claude-|jev/i.test(line)), false, name);
  }
});
