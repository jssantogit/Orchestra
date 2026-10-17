function emptyResolvedPolicies() {
  return Object.freeze({
    globalPolicy: null,
    domainPolicy: null,
    projectPolicy: null,
  });
}

function invalidState(error = null) {
  return Object.freeze({
    ok: false,
    code: "RSI_POLICY_STATE_INVALID",
    policies: emptyResolvedPolicies(),
    alert: Object.freeze({
      code: "RSI_POLICY_STATE_INVALID",
      sourceCode: typeof error?.code === "string" ? error.code : null,
    }),
  });
}

export function resolveActiveLearnedPolicies({
  policyStore = null,
  domainCohort = null,
  projectId = null,
} = {}) {
  if (policyStore === null) {
    return Object.freeze({
      ok: true,
      code: "RSI_POLICY_STATE_EMPTY",
      policies: emptyResolvedPolicies(),
    });
  }
  if (!policyStore || typeof policyStore.active !== "function") return invalidState();

  try {
    const global = policyStore.active({ scope: "GLOBAL" });
    const domain = domainCohort === null
      ? null
      : policyStore.active({ scope: "DOMAIN", domainCohort });
    const project = projectId === null
      ? null
      : policyStore.active({ scope: "PROJECT", projectId });

    return Object.freeze({
      ok: true,
      code: "RSI_POLICY_STATE_RESOLVED",
      policies: Object.freeze({
        globalPolicy: global?.policy ?? null,
        domainPolicy: domain?.policy ?? null,
        projectPolicy: project?.policy ?? null,
      }),
    });
  } catch (error) {
    return invalidState(error);
  }
}
