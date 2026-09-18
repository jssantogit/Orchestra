export const EVIDENCE_PROVIDER_REGISTRY_SCHEMA = "orchestra.evidence-provider-registry.v1";

const PROVIDERS = Object.freeze({
  GITHUB_ACTIONS: Object.freeze({
    id: "GITHUB_ACTIONS",
    kind: "REMOTE_CI",
    provenanceSource: "ORCHESTRA_GITHUB_COLLECTOR",
    probeMode: "github-actions",
    supportsWatch: true,
    validateRequirement(requirement = {}) {
      const workflow = requirement.workflow && typeof requirement.workflow === "object"
        ? requirement.workflow
        : null;
      if (!workflow || (workflow.id === undefined && !workflow.path && !workflow.name)) {
        return { valid: false, reason: "REMOTE_CI_WORKFLOW_REQUIRED" };
      }
      if (!Array.isArray(requirement.requiredJobs) || requirement.requiredJobs.length === 0) {
        return { valid: false, reason: "REMOTE_CI_REQUIRED_JOBS_REQUIRED" };
      }
      return { valid: true, reason: null };
    },
  }),
});

export function normalizeEvidenceProviderId(value) {
  return String(value || "").trim().toUpperCase();
}

export function getEvidenceProvider(providerId) {
  return PROVIDERS[normalizeEvidenceProviderId(providerId)] || null;
}

export function listEvidenceProviders() {
  return Object.values(PROVIDERS).map((provider) => ({
    id: provider.id,
    kind: provider.kind,
    provenanceSource: provider.provenanceSource,
    probeMode: provider.probeMode,
    supportsWatch: provider.supportsWatch === true,
  }));
}

export function validateRemoteEvidenceRequirement(requirement = {}) {
  const providerId = normalizeEvidenceProviderId(requirement.provider);
  if (!providerId) {
    return { valid: false, reason: "REMOTE_CI_PROVIDER_REQUIRED", provider: null };
  }
  const provider = getEvidenceProvider(providerId);
  if (!provider) {
    return { valid: false, reason: "REMOTE_CI_PROVIDER_UNSUPPORTED", provider: providerId };
  }
  if (String(requirement.kind || "").toUpperCase() !== provider.kind) {
    return { valid: false, reason: "REMOTE_PROVIDER_KIND_MISMATCH", provider: providerId };
  }
  const validation = provider.validateRequirement(requirement);
  return { ...validation, provider: providerId };
}
