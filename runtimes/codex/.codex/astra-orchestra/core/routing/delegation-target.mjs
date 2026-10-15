function normalizeBudget(budget = {}) {
  const used = Number.isInteger(budget.used) && budget.used >= 0 ? budget.used : 0;
  const limit = Number.isInteger(budget.limit) && budget.limit >= 0 ? budget.limit : 1;
  return { used, limit };
}

export function consumeCrossProviderBudget({ used, limit = 1 } = {}) {
  const normalizedUsed = Number.isInteger(used) && used >= 0 ? used : 0;
  const normalizedLimit = Number.isInteger(limit) && limit >= 0 ? limit : 1;
  if (normalizedUsed >= normalizedLimit) {
    return { allowed: false, remaining: 0, reason: "BUDGET_EXHAUSTED" };
  }
  return {
    allowed: true,
    remaining: Math.max(0, normalizedLimit - normalizedUsed - 1),
    reason: null,
  };
}

function findIndependentTarget(sourceProvider, providerCapabilities = [], { capability = null } = {}) {
  return providerCapabilities.find((candidate) => candidate
    && typeof candidate.provider === "string"
    && candidate.provider !== sourceProvider
    && candidate.available === true
    && candidate.independent === true
    && (capability === null || candidate.capabilities?.[capability] === true)) ?? null;
}

function crossProviderRoute({ sourceProvider, providerCapabilities, budget, reason, capability = null }) {
  const budgetDecision = consumeCrossProviderBudget(normalizeBudget(budget));
  if (!budgetDecision.allowed) {
    return { mode: "NONE", targetProvider: null, reason: budgetDecision.reason };
  }

  const target = findIndependentTarget(sourceProvider, providerCapabilities, { capability });
  if (!target) {
    return { mode: "NONE", targetProvider: null, reason: "PROVIDER_UNAVAILABLE" };
  }

  return { mode: "CROSS_PROVIDER", targetProvider: target.provider, reason };
}

export function selectDelegationTarget({
  sourceProvider,
  logicalRole,
  purpose,
  independenceRequired = false,
  explicitCrossProvider = false,
  providerCapabilities = [],
  budget = { used: 0, limit: 1 },
} = {}) {
  if (logicalRole === "IMPLEMENTER"
      && purpose === "IMPLEMENTATION"
      && explicitCrossProvider === true) {
    return crossProviderRoute({
      sourceProvider,
      providerCapabilities,
      budget,
      reason: "IMPLEMENTATION",
      capability: "implementation",
    });
  }

  if (purpose === "SPECIALIST_EXECUTION") {
    return {
      mode: "NONE",
      targetProvider: null,
      reason: "SPECIALIST_EXECUTION_REQUIRES_CONTROL",
    };
  }

  if (purpose === "SECOND_OPINION" && independenceRequired) {
    return crossProviderRoute({
      sourceProvider,
      providerCapabilities,
      budget,
      reason: "SECOND_OPINION",
    });
  }

  if (logicalRole === "CRITICAL_REVIEWER"
      && purpose === "INDEPENDENT_REVIEW"
      && independenceRequired) {
    return crossProviderRoute({
      sourceProvider,
      providerCapabilities,
      budget,
      reason: "INDEPENDENT_REVIEW",
    });
  }

  return {
    mode: "LOCAL",
    targetProvider: sourceProvider ?? null,
    reason: "SAME_PROVIDER_DEFAULT",
  };
}
