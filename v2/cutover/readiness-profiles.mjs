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
  evidence,
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

  // A provider's 6/6 alone cannot prove a native cross-provider dispatch.
  // Canonical collection must source this record from actual Home receipts.
  const nativeDelegation = evidence?.nativeDelegation ?? null;
  if (nativeDelegation === null) {
    missing.push('nativeDelegation');
  } else if (typeof nativeDelegation !== 'object' || Array.isArray(nativeDelegation)) {
    addInvalid('nativeDelegation:shape');
  } else {
    const exact = {status:'VERIFIED',headSha:expectedHeadSha,runtimeImageId:expectedRuntimeImageId};
    for (const [field,value] of Object.entries(exact)) {
      if (nativeDelegation[field] !== value) addInvalid(`nativeDelegation:${field}`);
    }
    const expectedFacts = {
      sourceProvider:'codex',targetProvider:'antigravity',selectedRoute:'DELEGATED',
      operationKind:'DELEGATED_MUTATION',
    };
    for (const [field,value] of Object.entries(expectedFacts)) {
      if (nativeDelegation.facts?.[field] !== value) addInvalid(`nativeDelegation:${field}`);
    }
    if (!nativeDelegation.facts || DELEGATION_FACTS.some(
      name => nativeDelegation.facts[name] !== true)) addInvalid('nativeDelegation:facts');
    if (!Array.isArray(nativeDelegation.evidenceRefs)
      || nativeDelegation.evidenceRefs.length < 3
      || nativeDelegation.evidenceRefs.some(ref => !SHA256.test(ref))) {
      addInvalid('nativeDelegation:evidenceRefs');
    }
    const keys = new Set(['status','headSha','runtimeImageId','facts','evidenceRefs']);
    if (Object.keys(nativeDelegation).some(key => !keys.has(key))) {
      addInvalid('nativeDelegation:shape');
    }
  }

  const evidenceComplete = missing.length === 0 && invalid.length === 0;
  // Source-bound collection is necessary but not sufficient: a dedicated Core
  // release validator has not yet been integrated. Do not claim cutover.
  return Object.freeze({
    profile: 'CORE', ready: false, evidenceComplete,
    code: evidenceComplete ? 'V2_CORE_EVIDENCE_COMPLETE_UNVERIFIED' : 'V2_CORE_EVIDENCE_INCOMPLETE',
    expectedHeadSha, expectedRuntimeImageId,
    missing: Object.freeze(missing), invalid: Object.freeze(invalid),
    deferred: DEFERRED,
  });
}
