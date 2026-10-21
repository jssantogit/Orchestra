import { authorizeAttach, authorizeCapability } from '../authority/authority.mjs';
import { selectExecutionPolicy } from './execution-policy.mjs';

// Process-local capabilities, never deserialized from provider/CLI JSON. The
// global composition root supplies executor facts; hooks do not grant routes.
const selections = new WeakMap();
export function readExecutionSelection(permit) {
  return permit && typeof permit === 'object' ? selections.get(permit) ?? null : null;
}

export function selectNativeExecution({ state, projectId, workId, generation,
  runtimeImageId, instructionEpoch, actor, operationId, readiness = null,
  requestRef = null, policyStore = null, evidenceClass = 'CONTROLLED_TEST' } = {}) {
  const project = state.projects.inspect(projectId), work = state.work.current(projectId);
  const session = state.sessionObservations.get({ provider: actor?.provider, projectId, actorIdHash: actor?.actorIdHash });
  if (!project || !work || !session || work.workId !== workId || work.generation !== generation
    || work.runtimeImage !== runtimeImageId || project.runtime.pinnedImage !== runtimeImageId
    || work.instructionEpoch !== instructionEpoch || project.runtime.instructionEpoch !== instructionEpoch
    || session.observedWorkId !== workId || session.observedGeneration !== generation
    || session.observedInstructionEpoch !== instructionEpoch) return { ok: false, code: 'NATIVE_EXECUTION_AUTHORITY_STALE' };
  const provenance = { schema: 'orchestra.actor-provenance.v2', provider: actor.provider,
    subjectHash: actor.actorIdHash, source: 'PROVIDER_FACT', observedAt: session.observedAt };
  const liveOperations = state.operations.listLive({ projectId, workId, generation });
  const facts = { project, work, actor: provenance, liveOperations };
  const attached = authorizeAttach({ ...facts, observedInstructionEpoch: instructionEpoch });
  const authorized = authorizeCapability({ ...facts, capability: 'WORKSPACE_EDIT',
    expectedGeneration: generation, workspaceRef: project.workspace.canonicalRoot });
  if (!attached.allowed || !authorized.allowed) return { ok: false, code: attached.reason ?? authorized.reason };
  const routes = ['DIRECT_WORK'];
  if (requestRef && readiness?.available === true && readiness.authenticated === true
    && readiness.capabilities?.implementation === true && readiness.provider !== actor.provider
    && ['codex', 'antigravity'].includes(readiness.provider)
    && /^sha256:[a-f0-9]{64}$/.test(readiness.evidenceRef ?? '')) routes.push('DELEGATED');
  const choices = { routes, providerProfiles: ['IMPLEMENTER'], retryClasses: ['RETURN_TO_CONTROL'],
    timeoutClasses: ['BOUNDED'], turnEconomy: ['DIRECTED'] };
  const selected = selectExecutionPolicy({ immutableChoices: choices, candidateChoices: choices,
    policyStore, projectId, domainCohort: 'software-engineering' });
  if (!selected.ok) return selected;
  const permit = Object.freeze({});
  selections.set(permit, Object.freeze({ schema: 'orchestra.execution-selection.v1',
    observedAt: new Date().toISOString(),
    operationId, projectId, workId, generation, runtimeImageId, instructionEpoch,
    actorRef: actor.actorIdHash, sourceProvider: actor.provider,
    immutableRoutes: Object.freeze([...routes]), legalRoutes: Object.freeze([...selected.legalChoices.routes]),
    selectedRoute: selected.selection.route, requestRef,
    readinessRef: routes.length === 2 ? readiness.evidenceRef : null,
    targetProvider: routes.length === 2 ? readiness.provider : null,
    evidenceClass, appliedPolicies: selected.appliedPolicies,
  }));
  return { ok: true, permit, route: selected.selection.route };
}
