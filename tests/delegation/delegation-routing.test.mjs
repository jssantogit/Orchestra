import test from "node:test";
import assert from "node:assert/strict";

import {
  consumeCrossProviderBudget,
  selectDelegationTarget,
} from "../../core/routing/delegation-target.mjs";

const healthyProviders = () => [
  { provider: "provider-c", available: true, independent: true },
  { provider: "provider-a", available: true, independent: false },
  { provider: "provider-b", available: true, independent: true },
];

function choose(overrides = {}) {
  return selectDelegationTarget({
    sourceProvider: "provider-a",
    logicalRole: "IMPLEMENTER",
    purpose: "MANUAL",
    independenceRequired: false,
    providerCapabilities: healthyProviders(),
    budget: { used: 0, limit: 1 },
    ...overrides,
  });
}

test("normal implementation, quick audit, and investigation stay local", () => {
  for (const logicalRole of ["IMPLEMENTER", "QUICK_AUDITOR", "INVESTIGATOR"]) {
    assert.deepEqual(choose({ logicalRole }), {
      mode: "LOCAL",
      targetProvider: "provider-a",
      reason: "SAME_PROVIDER_DEFAULT",
    });
  }
});

test("critical independent review deterministically selects a healthy independent provider", () => {
  assert.deepEqual(choose({
    logicalRole: "CRITICAL_REVIEWER",
    purpose: "INDEPENDENT_REVIEW",
    independenceRequired: true,
  }), {
    mode: "CROSS_PROVIDER",
    targetProvider: "provider-b",
    reason: "INDEPENDENT_CRITICAL_REVIEW",
  });
});

test("explicit second opinion may cross provider without making investigation automatically cross-provider", () => {
  assert.deepEqual(choose({
    logicalRole: "INVESTIGATOR",
    purpose: "SECOND_OPINION",
    independenceRequired: true,
  }), {
    mode: "CROSS_PROVIDER",
    targetProvider: "provider-b",
    reason: "EXPLICIT_SECOND_OPINION",
  });

  assert.equal(choose({ logicalRole: "INVESTIGATOR", purpose: "MANUAL" }).mode, "LOCAL");
});

test("specialist execution has no automatic v1 cross-provider route", () => {
  assert.deepEqual(choose({
    logicalRole: "INVESTIGATOR",
    purpose: "SPECIALIST_EXECUTION",
    independenceRequired: true,
  }), {
    mode: "NONE",
    targetProvider: null,
    reason: "SPECIALIST_EXECUTION_NOT_AUTOMATIC",
  });
});

test("required cross-provider routing fails closed when no independent provider is healthy", () => {
  const providerCapabilities = [
    { provider: "provider-a", available: true, independent: false },
    { provider: "provider-b", available: false, independent: true },
  ];
  assert.deepEqual(choose({
    logicalRole: "CRITICAL_REVIEWER",
    purpose: "INDEPENDENT_REVIEW",
    independenceRequired: true,
    providerCapabilities,
  }), {
    mode: "NONE",
    targetProvider: null,
    reason: "PROVIDER_UNAVAILABLE",
  });
});

test("cross-provider budget prevents repeated fan-out in one logical stage", () => {
  assert.deepEqual(consumeCrossProviderBudget({ used: 0, limit: 1 }), {
    allowed: true,
    remaining: 0,
    reason: "AVAILABLE",
  });
  assert.deepEqual(consumeCrossProviderBudget({ used: 1, limit: 1 }), {
    allowed: false,
    remaining: 0,
    reason: "CROSS_PROVIDER_BUDGET_EXHAUSTED",
  });

  assert.deepEqual(choose({
    logicalRole: "CRITICAL_REVIEWER",
    purpose: "INDEPENDENT_REVIEW",
    independenceRequired: true,
    budget: { used: 1, limit: 1 },
  }), {
    mode: "NONE",
    targetProvider: null,
    reason: "CROSS_PROVIDER_BUDGET_EXHAUSTED",
  });
});

test("provider target selection remains generic and excludes the source provider", () => {
  const decision = choose({
    logicalRole: "CRITICAL_REVIEWER",
    purpose: "INDEPENDENT_REVIEW",
    independenceRequired: true,
    providerCapabilities: [
      { provider: "provider-z", available: true, independent: true },
      { provider: "provider-a", available: true, independent: true },
      { provider: "provider-m", available: true, independent: true },
    ],
  });
  assert.equal(decision.targetProvider, "provider-m");
  assert.notEqual(decision.targetProvider, "provider-a");
});
