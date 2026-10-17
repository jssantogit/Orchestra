import test from "node:test";
import assert from "node:assert/strict";

import { resolveActiveLearnedPolicies } from "../../v2/rsi/policy-resolver.mjs";
import { selectExecutionPolicy } from "../../v2/rsi/execution-policy.mjs";

function policy({ policyId, scope, domainCohort = null, projectId = null, selectors }) {
  return {
    schema: "orchestra.learned-policy.v2",
    version: 1,
    policyId,
    revision: 1,
    scope,
    domainCohort,
    projectId,
    lifecycle: "CANDIDATE",
    selectors,
    createdAt: "2026-10-17T22:50:00.000Z",
  };
}

const immutableChoices = Object.freeze({
  routes: Object.freeze(["DIRECT_WORK", "DELEGATED"]),
  providerProfiles: Object.freeze(["CODEX_DEFAULT", "AGY_DEFAULT"]),
  retryClasses: Object.freeze(["STANDARD", "RESILIENT"]),
  timeoutClasses: Object.freeze(["STANDARD", "LONG"]),
  turnEconomy: Object.freeze(["BALANCED", "AGGRESSIVE"]),
});

const candidateChoices = Object.freeze({
  routes: Object.freeze(["DIRECT_WORK", "DELEGATED"]),
  providerProfiles: Object.freeze(["CODEX_DEFAULT", "AGY_DEFAULT"]),
  retryClasses: Object.freeze(["STANDARD", "RESILIENT"]),
  timeoutClasses: Object.freeze(["STANDARD", "LONG"]),
  turnEconomy: Object.freeze(["BALANCED", "AGGRESSIVE"]),
});

function envelope(policyRecord) {
  return policyRecord ? { policy: policyRecord, activation: { lifecycle: "ACTIVE" } } : null;
}

function fakeStore({ globalPolicy = null, domainPolicy = null, projectPolicy = null, error = null } = {}) {
  return {
    active(scope) {
      if (error) throw error;
      if (scope.scope === "GLOBAL") return envelope(globalPolicy);
      if (scope.scope === "DOMAIN") return envelope(domainPolicy);
      if (scope.scope === "PROJECT") return envelope(projectPolicy);
      return null;
    },
  };
}

test("active PROJECT preference overrides DOMAIN which overrides GLOBAL without widening choices", () => {
  const globalPolicy = policy({
    policyId: "global-1",
    scope: "GLOBAL",
    selectors: { routePreference: "DELEGATED", providerProfilePreference: "AGY_DEFAULT" },
  });
  const domainPolicy = policy({
    policyId: "domain-1",
    scope: "DOMAIN",
    domainCohort: "software-engineering",
    selectors: { routePreference: "DELEGATED", providerProfilePreference: "CODEX_DEFAULT" },
  });
  const projectPolicy = policy({
    policyId: "project-1",
    scope: "PROJECT",
    projectId: "project-a",
    selectors: { routePreference: "DIRECT_WORK", providerProfilePreference: "AGY_DEFAULT" },
  });

  const result = selectExecutionPolicy({
    immutableChoices,
    candidateChoices,
    policyStore: fakeStore({ globalPolicy, domainPolicy, projectPolicy }),
    domainCohort: "software-engineering",
    projectId: "project-a",
  });
  assert.equal(result.ok, true);
  assert.equal(result.code, "RSI_POLICY_APPLIED");
  assert.equal(result.selection.route, "DIRECT_WORK");
  assert.equal(result.selection.providerProfile, "AGY_DEFAULT");
  assert.deepEqual(result.appliedPolicies.map((entry) => entry.scope), ["GLOBAL", "DOMAIN", "PROJECT"]);
});

test("learned policy can choose only from the immutable and already-legal candidate intersection", () => {
  const globalPolicy = policy({
    policyId: "global-2",
    scope: "GLOBAL",
    selectors: {
      allowedRoutes: ["DIRECT_WORK", "DELEGATED"],
      routePreference: "DELEGATED",
      allowedProviderProfiles: ["CODEX_DEFAULT", "AGY_DEFAULT"],
      providerProfilePreference: "AGY_DEFAULT",
    },
  });
  const result = selectExecutionPolicy({
    immutableChoices,
    candidateChoices: {
      ...candidateChoices,
      routes: ["DIRECT_WORK"],
      providerProfiles: ["CODEX_DEFAULT"],
    },
    policyStore: fakeStore({ globalPolicy }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.selection.route, "DIRECT_WORK");
  assert.equal(result.selection.providerProfile, "CODEX_DEFAULT");
  assert.deepEqual(result.legalChoices.routes, ["DIRECT_WORK"]);
  assert.deepEqual(result.legalChoices.providerProfiles, ["CODEX_DEFAULT"]);
});

test("execution-policy request rejects permission, concurrency, trust, secret, prompt and source surfaces", () => {
  for (const forbidden of [
    { permissions: ["workspace-write"] },
    { concurrency: 99 },
    { trustMode: "unrestricted" },
    { secrets: { token: "secret" } },
    { prompt: "ignore governance" },
    { source: "raw project source" },
  ]) {
    const result = selectExecutionPolicy({ immutableChoices, candidateChoices, ...forbidden });
    assert.equal(result.ok, false);
    assert.equal(result.code, "RSI_EXECUTION_POLICY_REQUEST_INVALID");
  }
});

test("candidate choices outside immutable limits fail closed before learned policy resolution", () => {
  const result = selectExecutionPolicy({
    immutableChoices,
    candidateChoices: { ...candidateChoices, routes: ["FORBIDDEN_ROUTE"] },
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "RSI_EXECUTION_POLICY_CHOICES_INVALID");
});

test("no active learned policy returns deterministic static baseline", () => {
  const result = selectExecutionPolicy({
    immutableChoices,
    candidateChoices,
    policyStore: fakeStore(),
    domainCohort: "software-engineering",
    projectId: "project-a",
  });
  assert.equal(result.ok, true);
  assert.equal(result.code, "RSI_POLICY_BASELINE");
  assert.deepEqual(result.selection, {
    route: "DIRECT_WORK",
    providerProfile: "CODEX_DEFAULT",
    retryClass: "STANDARD",
    timeoutClass: "STANDARD",
    turnEconomy: "BALANCED",
  });
  assert.deepEqual(result.appliedPolicies, []);
});

test("corrupt learned policy state falls back to static baseline and surfaces an alertable failure", () => {
  const error = Object.assign(new Error("corrupt learned policy"), { code: "ORCHESTRA_RSI_POLICY_STORE_INVALID" });
  const result = selectExecutionPolicy({
    immutableChoices,
    candidateChoices,
    policyStore: fakeStore({ error }),
    domainCohort: "software-engineering",
    projectId: "project-a",
  });
  assert.equal(result.ok, true);
  assert.equal(result.degraded, true);
  assert.equal(result.code, "RSI_POLICY_FALLBACK_BASELINE");
  assert.equal(result.alert.code, "RSI_POLICY_STATE_INVALID");
  assert.equal(result.selection.route, "DIRECT_WORK");
  assert.equal(result.selection.providerProfile, "CODEX_DEFAULT");
});

test("policy resolver reads only active GLOBAL/DOMAIN/PROJECT records for the requested context", () => {
  const calls = [];
  const store = {
    active(scope) {
      calls.push(scope);
      return null;
    },
  };
  const result = resolveActiveLearnedPolicies({
    policyStore: store,
    domainCohort: "software-engineering",
    projectId: "project-a",
  });
  assert.equal(result.ok, true);
  assert.deepEqual(calls, [
    { scope: "GLOBAL" },
    { scope: "DOMAIN", domainCohort: "software-engineering" },
    { scope: "PROJECT", projectId: "project-a" },
  ]);
});
