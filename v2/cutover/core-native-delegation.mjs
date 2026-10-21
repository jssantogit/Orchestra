// Read-only projection of the native Home journal. Its listObserved() reopens
// and validates Work/Operation, selection, provider auth blob, child close,
// process provenance and artifact. Git HEAD requires canonical collection.
const REF = /^sha256:[0-9a-f]{64}$/;
const fail = code => Object.freeze({ ok: false, code, evidenceRefs: Object.freeze([]) });

export function inspectCoreNativeDelegation({ state, runtimeImageId } = {}) {
  if (!REF.test(runtimeImageId ?? '') || !state?.nativeRsi?.listObserved
    || !state?.nativeRsi?.inspectExecutionSelection || !state?.operations?.inspect) {
    return fail('CORE_NATIVE_DELEGATION_STORE_INVALID');
  }
  let observations;
  try { observations = state.nativeRsi.listObserved({runtimeImageId}); }
  catch { return fail('CORE_NATIVE_DELEGATION_JOURNAL_UNVERIFIED'); }
  if (!Array.isArray(observations)) return fail('CORE_NATIVE_DELEGATION_JOURNAL_UNVERIFIED');
  for (const observation of observations) {
    if (observation?.schema !== 'orchestra.rsi-decision-outcome.v1'
      || observation.decision?.selectedRoute !== 'DELEGATED'
      || !observation.decision?.legalRoutes?.includes('DELEGATED')
      || observation.outcome?.success !== true) continue;
    const operationId = observation.source?.operationId;
    if (typeof operationId !== 'string' || !operationId) continue;
    let selection, operation;
    try {
      selection = state.nativeRsi.inspectExecutionSelection(operationId);
      operation = state.operations.inspect(operationId);
    } catch { continue; }
    const refs = [observation.evidence?.choiceRef, observation.evidence?.outcomeRef, selection?.readinessRef];
    if (!refs.every(ref => REF.test(ref ?? ''))
      || selection?.evidenceClass !== 'NATIVE'
      || selection.runtimeImageId !== runtimeImageId
      || selection.operationId !== operationId
      || selection.selectedRoute !== 'DELEGATED'
      || selection.sourceProvider !== 'codex'
      || selection.targetProvider !== 'antigravity'
      || !selection.legalRoutes?.includes('DELEGATED')
      || operation?.operationId !== operationId
      || operation.projectId !== selection.projectId
      || operation.workId !== selection.workId
      || operation.generation !== selection.generation
      || operation.kind !== 'DELEGATED_MUTATION'
      || operation.workflowState !== 'SUCCEEDED'
      || operation.liveness !== 'TERMINAL'
      || !/^delegation-artifact:sha256:[0-9a-f]{64}$/.test(operation.resultRef ?? '')) continue;
    return Object.freeze({ ok: true,
      facts: Object.freeze({
        sourceProvider: 'codex', targetProvider: 'antigravity', selectedRoute: 'DELEGATED',
        operationKind: 'DELEGATED_MUTATION', workAuthorityVerified: true,
        selectionVerified: true, terminalVerified: true, artifactVerified: true,
        processProvenanceVerified: true,
      }),
      evidenceRefs: Object.freeze(refs),
    });
  }
  return fail('CORE_NATIVE_DELEGATION_MISSING');
}
