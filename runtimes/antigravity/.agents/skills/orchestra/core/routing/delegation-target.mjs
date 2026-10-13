function none(reason) {
  return { mode: "NONE", targetProvider: null, reason };
}

function local(sourceProvider) {
  return { mode: "LOCAL", targetProvider: sourceProvider, reason: "SAME_PROVIDER_DEFAULT" };
}

export function consumeCrossProviderBudget({ used = 0, limit = 1 } = {}) {
  const normalizedUsed = Number.isInteger(used) && used >= 0 ? used : 0;
  const normalizedLimit = Number.isInteger(limit) && limit >= 0 ? limit : 0;
  const remainingBeforeUse = Math.max(0, normalizedLimit - normalizedUsed);

  if (remainingBeforeUse === 0) {
    return {
      allowed: false,
      remaining: 0,
      reason: "CROSS_PROVIDER_BUDGET_EXHAUSTED",
    };
  }

  return {
    allowed: true,
    remaining: remainingBeforeUse - 1,
    reason: "AVAILABLE",
  };
}

function independentCandidates(sourceProvider, providerCapabilities) {
  return (Array.isArray(providerCapabilities) ? providerCapabilities : [])
    .filter((entry) => (
      entry
      && typeof entry.provider === "string"
      && entry.provider.length > 0
      && entry.provider !== sourceProvider
      && entry.available === true
      && entry.independent === true
    ))
    .map((entry) => entry.provider)
    .sort((a, b) => a.localeCompare(b));
}

export function selectDelegationTarget({
  sourceProvider,
  logicalRole,
  purpose,
  independenceRequired = false,
  providerCapabilities = [],
  budget = { used: 0, limit: 1 },
} = {}) {
  if (purpose === "SPECIALIST_EXECUTION") {
    return none("SPECIALIST_EXECUTION_NOT_AUTOMATIC");
  }

  let crossProviderReason = null;
  if (purpose === "SECOND_OPINION") {
    crossProviderReason = "EXPLICIT_SECOND_OPINION";
  } else if (
    logicalRole === "CRITICAL_REVIEWER"
    && purpose === "INDEPENDENT_REVIEW"
    && independenceRequired === true
  ) {
    crossProviderReason = "INDEPENDENT_CRITICAL_REVIEW";
  }

  if (!crossProviderReason) return local(sourceProvider);

  const budgetDecision = consumeCrossProviderBudget(budget);
  if (!budgetDecision.allowed) return none(budgetDecision.reason);

  const candidates = independentCandidates(sourceProvider, providerCapabilities);
  if (candidates.length === 0) return none("PROVIDER_UNAVAILABLE");

  return {
    mode: "CROSS_PROVIDER",
    targetProvider: candidates[0],
    reason: crossProviderReason,
  };
}
