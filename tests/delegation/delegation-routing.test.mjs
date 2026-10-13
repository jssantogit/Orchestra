import test from "node:test";
import assert from "node:assert/strict";

import {
  consumeCrossProviderBudget,
  selectDelegationTarget,
} from "../../core/routing/delegation-target.mjs";

function providers(overrides = {}) {
  const base = [
    { provider: "provider-a", available: true, independent: false },
    { provider: "provider-b", available: true, independent: true },
  ];
  return base.map((entry) => ({ ...entry, ...(overrides[entry.provider] ?? {}) }));
}

function route(overrides = {}) {
  return selectDelegationTarget({
    sourceProvider: "provider-a",
    logicalRole: "IMPLEMENTER",
    purpose: "MANUAL",
    independenceRequired: false,
    providerCapabilities: providers(),
    budget: { used: 0, limit: 1 },
    ...overrides,
  });
}

test("normal implementation, quick audit, and investigation stay local", () => {
  for (const logicalRole of ["IMPLEMENTER", "QUICK_AUDITOR", "INVESTIGATOR"]) {
    assert.deepEqual(route({ logicalRole }), {
      mode: "LOCAL",
      targetProvider: "provider-a",
      reason: "SAME_PROVIDER_DEFAULT",
    });
  }
});

test("critical independent review chooses one healthy independent provider", () => {
  assert.deepEqual(route({
    logicalRole: "CRITICAL_REVIEWER",
    purpose: "INDEPENDENT_REVIEW",
    independenceRequired: true,
  }), {
    mode: "CROSS_PROVIDER",
    targetProvider: "provider-b",
    reason: "INDEPENDENT_REVIEW",
  });
});

test("explicit second opinion may cross providers without making investigation automatic", () => {
  assert.deepEqual(route({
    logicalRole: "INVESTIGATOR",
    purpose: "SECOND_OPINION",
    independenceRequired: true,
  }), {
    mode: "CROSS_PROVIDER",
    targetProvider: "provider-b",
    reason: "SECOND_OPINION",
  });

  assert.deepEqual(route({
    logicalRole: "INVESTIGATOR",
    purpose: "INDEPENDENT_REVIEW",
    independenceRequired: true,
  }), {
    mode: "LOCAL",
    targetProvider: "provider-a",
    reason: "SAME_PROVIDER_DEFAULT",
  });
});

test("specialist execution has no automatic cross-provider route", () => {
  assert.deepEqual(route({
    logicalRole: "IMPLEMENTER",
    purpose: "SPECIALIST_EXECUTION",
    independenceRequired: true,
  }), {
    mode: "NONE",
    targetProvider: null,
    reason: "SPECIALIST_EXECUTION_REQUIRES_CONTROL",
  });
});

test("unavailable independent target returns PROVIDER_UNAVAILABLE and never falls back", () => {
  assert.deepEqual(route({
    logicalRole: "CRITICAL_REVIEWER",
    purpose: "INDEPENDENT_REVIEW",
    independenceRequired: true,
    providerCapabilities: providers({ "provider-b": { available: false } }),
  }), {
    mode: "NONE",
    targetProvider: null,
    reason: "PROVIDER_UNAVAILABLE",
  });
});

test("target selection is provider-neutral and does not assume exactly two providers", () => {
  const providerCapabilities = [
    { provider: "provider-a", available: true, independent: false },
    { provider: "provider-b", available: false, independent: true },
    { provider: "provider-c", available: true, independent: true },
  ];

  assert.deepEqual(route({
    logicalRole: "CRITICAL_REVIEWER",
    purpose: "INDEPENDENT_REVIEW",
    independenceRequired: true,
    providerCapabilities,
  }), {
    mode: "CROSS_PROVIDER",
    targetProvider: "provider-c",
    reason: "INDEPENDENT_REVIEW",
  });
});

test("cross-provider budget is consumed once per logical stage", () => {
  assert.deepEqual(consumeCrossProviderBudget({ used: 0 }), {
    allowed: true,
    remaining: 0,
    reason: null,
  });
  assert.deepEqual(consumeCrossProviderBudget({ used: 1 }), {
    allowed: false,
    remaining: 0,
    reason: "BUDGET_EXHAUSTED",
  });
  assert.deepEqual(consumeCrossProviderBudget({ used: 1, limit: 3 }), {
    allowed: true,
    remaining: 1,
    reason: null,
  });
});

test("routing refuses a second cross-provider delegation when budget is exhausted", () => {
  assert.deepEqual(route({
    logicalRole: "CRITICAL_REVIEWER",
    purpose: "INDEPENDENT_REVIEW",
    independenceRequired: true,
    budget: { used: 1, limit: 1 },
  }), {
    mode: "NONE",
    targetProvider: null,
    reason: "BUDGET_EXHAUSTED",
  });
});
