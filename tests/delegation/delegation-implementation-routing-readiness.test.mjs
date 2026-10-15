import test from "node:test";
import assert from "node:assert/strict";

import { selectDelegationTarget } from "../../core/routing/delegation-target.mjs";

function route(providerCapabilities) {
  return selectDelegationTarget({
    sourceProvider: "provider-a",
    logicalRole: "IMPLEMENTER",
    purpose: "IMPLEMENTATION",
    explicitCrossProvider: true,
    providerCapabilities,
    budget: { used: 0, limit: 1 },
  });
}

test("implementation routing skips an available independent provider that is not implementation-capable", () => {
  assert.deepEqual(route([
    { provider: "provider-a", available: true, independent: false, capabilities: { implementation: true } },
    { provider: "provider-b", available: true, independent: true, capabilities: { implementation: false } },
    { provider: "provider-c", available: true, independent: true, capabilities: { implementation: true } },
  ]), {
    mode: "CROSS_PROVIDER",
    targetProvider: "provider-c",
    reason: "IMPLEMENTATION",
  });
});

test("implementation routing fails closed when no independent provider explicitly supports implementation", () => {
  assert.deepEqual(route([
    { provider: "provider-a", available: true, independent: false, capabilities: { implementation: true } },
    { provider: "provider-b", available: true, independent: true, capabilities: { implementation: false } },
    { provider: "provider-c", available: true, independent: true },
  ]), {
    mode: "NONE",
    targetProvider: null,
    reason: "PROVIDER_UNAVAILABLE",
  });
});
