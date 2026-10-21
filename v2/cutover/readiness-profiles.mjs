import { evaluateCutoverReadiness } from './readiness.mjs';

// Additive, read-only classifier, not a field collector or release authorization.
// Only canonical Git-bound evidence collection can establish factual readiness.
const DEFERRED = Object.freeze(['rsiReplay', 'migration.tsuzukiF7Verified']);
const DELEGATION_FACTS = Object.freeze([
  'workAuthorityVerified', 'selectionVerified', 'terminalVerified',
  'artifactVerified', 'processProvenanceVerified',
]);
const SHA256 = /^sha256:[0-9a-f]{64}$/;

export function evaluateV2ReadinessProfile({
  profile = 'ADAPTIVE', expectedHeadSha, expectedRuntimeImageId,
  evidence, nativeDelegation = null,
} = {}) {
  if (profile !== 'CORE' && profile !== 'ADAPTIVE') {
    throw new TypeError('profile must be CORE or ADAPTIVE');
  }
  const original = evaluateCutoverReadiness({ expectedHeadSha, evidence });
  // Do not change the meaning or requirements of the existing cutover gate.
  if (profile === 'ADAPTIVE') return original;
  if (typeof expectedRuntimeImageId !== 'string' || !SHA256.test(expectedRuntimeImageId)) {
    throw new TypeError('expectedRuntimeImageId must be an exact sha256 Runtime Image');
  }

  const missing = original.missing.filter(path => path !== 'rsiReplay');
  const invalid = original.invalid.filter(path =>
    !path.startsWith('rsiReplay:') && path !== 'migration:tsuzukiF7Verified');
  const addInvalid = field => { if (!invalid.includes(field)) invalid.push(field); };

  // Two provider 6/6 sets do not prove a completed cross-provider dispatch.
  // This record must ultimately come from an independently verified Home
  // probe; a caller-made record alone is not authoritative release evidence.
  if (nativeDelegation === null) {
    missing.push('nativeDelegation');
  } else if (!nativeDelegation || typeof nativeDelegation !== 'object' || Array.isArray(nativeDelegation)) {
    addInvalid('nativeDelegation:shape');
  } else {
    const exact = {
      schema: 'orchestra.core-native-delegation-evidence.v1', version: 1,
      status: 'VERIFIED', headSha: expectedHeadSha,
      runtimeImageId: expectedRuntimeImageId,
      sourceProvider: 'codex', targetProvider: 'antigravity',
      evidenceClass: 'NATIVE', selectedRoute: 'DELEGATED',
      operationKind: 'DELEGATED_MUTATION', workflowState: 'SUCCEEDED',
    };
    for (const [field, value] of Object.entries(exact)) {
      if (nativeDelegation[field] !== value) addInvalid(`nativeDelegation:${field}`);
    }
    if (!nativeDelegation.facts || DELEGATION_FACTS.some(
      name => nativeDelegation.facts[name] !== true)) {
      addInvalid('nativeDelegation:facts');
    }
    if (!Array.isArray(nativeDelegation.evidenceRefs)
      || nativeDelegation.evidenceRefs.length === 0
      || nativeDelegation.evidenceRefs.some(ref => !SHA256.test(ref))) {
      addInvalid('nativeDelegation:evidenceRefs');
    }
    const keys = new Set([...Object.keys(exact), 'facts', 'evidenceRefs']);
    if (Object.keys(nativeDelegation).some(key => !keys.has(key))) {
      addInvalid('nativeDelegation:shape');
    }
  }

  const evidenceComplete = missing.length === 0 && invalid.length === 0;
  // The canonical Home probe and collector are not yet connected. Never
  // promote caller-provided evidence shape into a release-ready verdict.
  return Object.freeze({
    profile: 'CORE', ready: false, evidenceComplete,
    code: evidenceComplete ? 'V2_CORE_EVIDENCE_COMPLETE_UNVERIFIED' : 'V2_CORE_EVIDENCE_INCOMPLETE',
    expectedHeadSha, expectedRuntimeImageId,
    missing: Object.freeze(missing), invalid: Object.freeze(invalid),
    deferred: DEFERRED,
  });
}
