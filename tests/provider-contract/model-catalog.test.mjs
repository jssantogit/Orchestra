import test from "node:test";
import assert from "node:assert/strict";

import { LOGICAL_ROLES } from "../../core/domain/logical-role.mjs";
import { resolveModelProfile as resolveCodexModelProfile } from "../../providers/codex/model-catalog.mjs";
import { resolveModelProfile as resolveAntigravityModelProfile } from "../../providers/antigravity/model-catalog.mjs";

const ROLES = Object.freeze([
  "CONTROL",
  "IMPLEMENTER",
  "INVESTIGATOR",
  "QUICK_AUDITOR",
  "CRITICAL_REVIEWER",
  "MANUAL_ESCALATION",
]);

function assertCatalogShape(result, role) {
  assert.deepEqual(Object.keys(result).sort(), ["logicalRole", "model", "profile", "reasoningEffort"]);
  assert.equal(result.logicalRole, role);
  assert.equal(typeof result.profile, "string");
  assert.ok(result.profile.length > 0);
  assert.equal(typeof result.model, "string");
  assert.ok(result.model.length > 0);
  assert.equal(typeof result.reasoningEffort, "string");
  assert.ok(result.reasoningEffort.length > 0);
}

test("logical roles are the canonical provider-neutral vocabulary", () => {
  assert.deepEqual(Object.keys(LOGICAL_ROLES), ROLES);
  assert.deepEqual(Object.values(LOGICAL_ROLES), ROLES);
  assert.equal(Object.isFrozen(LOGICAL_ROLES), true);
});

test("every logical role has an explicit Codex mapping", () => {
  const expected = {
    CONTROL: ["sol-medium", "gpt-6-sol", "medium"],
    IMPLEMENTER: ["luna-max", "gpt-6-luna", "max"],
    INVESTIGATOR: ["sol-high", "gpt-6-sol", "high"],
    QUICK_AUDITOR: ["luna-auditor", "gpt-6-luna", "medium"],
    CRITICAL_REVIEWER: ["sol-review-low", "gpt-6-sol", "low"],
    MANUAL_ESCALATION: ["astra-manual", "gpt-6-astra", "medium"],
  };

  for (const role of ROLES) {
    const result = resolveCodexModelProfile(role);
    assertCatalogShape(result, role);
    assert.deepEqual(
      [result.profile, result.model, result.reasoningEffort],
      expected[role],
      `Codex mapping drift for ${role}`,
    );
  }
});

test("Codex intensity variants preserve the current routing tiers", () => {
  assert.deepEqual(resolveCodexModelProfile(LOGICAL_ROLES.IMPLEMENTER, { intensity: "simple" }), {
    profile: "luna-high",
    model: "gpt-6-luna",
    reasoningEffort: "high",
    logicalRole: "IMPLEMENTER",
  });
  assert.deepEqual(resolveCodexModelProfile(LOGICAL_ROLES.IMPLEMENTER, { intensity: "mechanical" }), {
    profile: "luna-medium",
    model: "gpt-6-luna",
    reasoningEffort: "medium",
    logicalRole: "IMPLEMENTER",
  });
  assert.deepEqual(resolveCodexModelProfile(LOGICAL_ROLES.INVESTIGATOR, { intensity: "xhigh" }), {
    profile: "sol-xhigh",
    model: "gpt-6-sol",
    reasoningEffort: "xhigh",
    logicalRole: "INVESTIGATOR",
  });
  assert.deepEqual(resolveCodexModelProfile(LOGICAL_ROLES.INVESTIGATOR, { intensity: "max" }), {
    profile: "sol-max",
    model: "gpt-6-sol",
    reasoningEffort: "max",
    logicalRole: "INVESTIGATOR",
  });
  assert.deepEqual(resolveCodexModelProfile(LOGICAL_ROLES.CRITICAL_REVIEWER, { intensity: "specialist" }), {
    profile: "sol-review-medium",
    model: "gpt-6-sol",
    reasoningEffort: "medium",
    logicalRole: "CRITICAL_REVIEWER",
  });
});

test("every logical role has an explicit ALL-GEMINI Antigravity mapping", () => {
  const expected = {
    CONTROL: ["flash-orchestrator", "gemini-3.8-flash-medium", "medium"],
    IMPLEMENTER: ["flash-medium-worker", "gemini-3.8-flash-medium", "medium"],
    INVESTIGATOR: ["flash-worker", "gemini-3.8-flash-high", "high"],
    QUICK_AUDITOR: ["flash-quick-auditor", "gemini-3.8-flash-medium", "medium"],
    CRITICAL_REVIEWER: ["flash-reviewer", "gemini-3.8-flash-high", "high"],
    MANUAL_ESCALATION: ["flash-orchestrator", "gemini-3.8-flash-medium", "medium"],
  };

  for (const role of ROLES) {
    const result = resolveAntigravityModelProfile(role);
    assertCatalogShape(result, role);
    assert.deepEqual(
      [result.profile, result.model, result.reasoningEffort],
      expected[role],
      `Antigravity mapping drift for ${role}`,
    );
    assert.match(result.model, /^gemini-3\.8-flash-/);
  }
});

test("Antigravity implementer intensity variants preserve current low/medium/high behavior", () => {
  assert.deepEqual(resolveAntigravityModelProfile(LOGICAL_ROLES.IMPLEMENTER, { intensity: "simple" }), {
    profile: "flash-low-worker",
    model: "gemini-3.8-flash-low",
    reasoningEffort: "low",
    logicalRole: "IMPLEMENTER",
  });
  assert.deepEqual(resolveAntigravityModelProfile(LOGICAL_ROLES.IMPLEMENTER, { intensity: "high" }), {
    profile: "flash-worker",
    model: "gemini-3.8-flash-high",
    reasoningEffort: "high",
    logicalRole: "IMPLEMENTER",
  });
});

test("invalid logical roles fail closed in both provider catalogs", () => {
  assert.throws(() => resolveCodexModelProfile("NOT_A_ROLE"), /INVALID_LOGICAL_ROLE/);
  assert.throws(() => resolveAntigravityModelProfile("NOT_A_ROLE"), /INVALID_LOGICAL_ROLE/);
});
