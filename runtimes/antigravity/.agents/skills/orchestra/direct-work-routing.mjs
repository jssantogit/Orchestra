import { decideRoute, normalizeTaskAction } from './routing-policy.mjs';
import { EXECUTION_MODES, selectExecutionMode } from './core/workflow/direct-work-policy.mjs';
import {
  buildImplementationPacket,
  assessImplementationReadiness,
} from './core/workflow/implementation-packet.mjs';

const DIRECT_WORK_GATES = new Set(['off', 'shadow', 'on']);

export function readAntigravityDirectWorkMode(env = process.env) {
  const raw = String(env?.ORCHESTRA_DIRECT_WORK_MODE ?? 'shadow').trim().toLowerCase();
  return DIRECT_WORK_GATES.has(raw) ? raw : 'shadow';
}

function laneFacts(facts = {}) {
  return {
    bounded: facts.bounded,
    criticality: facts.criticality,
    independentWorkstreams: facts.independentWorkstreams,
    unresolvedDiagnosis: facts.unresolvedDiagnosis,
    openEndedDiagnosis: facts.openEndedDiagnosis,
    migrationSensitive: facts.migrationSensitive,
    mechanical: facts.mechanical,
    lowRisk: facts.lowRisk,
    requestedMode: facts.requestedMode,
  };
}

function directWorkMetadata(gate, lane) {
  return {
    gate,
    mode: lane.mode,
    reason: lane.reason,
    auditRequired: lane.auditRequired,
    primaryWorkerCount: lane.mode === EXECUTION_MODES.DIRECT_WORK ? 1 : 0,
    spawnInvestigator: false,
    spawnReviewerBeforeCandidate: false,
    quickAuditorProfile:
      lane.mode === EXECUTION_MODES.DIRECT_WORK && lane.auditRequired
        ? 'flash-quick-auditor'
        : null,
  };
}

export function decideAntigravityWork(facts = {}, { env = process.env } = {}) {
  const baseline = decideRoute(facts);
  const gate = readAntigravityDirectWorkMode(env);
  if (gate === 'off') return baseline;

  const applicable = ['IMPLEMENT', 'MECHANICAL_FIX'].includes(normalizeTaskAction(facts));
  if (!applicable) return { ...baseline, directWork: { gate, applicable: false } };

  const lane = selectExecutionMode(laneFacts(facts));
  if (gate === 'shadow') {
    return {
      ...baseline,
      directWork: {
        ...directWorkMetadata(gate, lane),
        applicable: true,
        shadow: true,
        actualExecutor: baseline.executor,
      },
    };
  }

  if (lane.mode === EXECUTION_MODES.DIRECT_WORK) {
    return {
      ...baseline,
      directWork: {
        ...directWorkMetadata(gate, lane),
        applicable: true,
        shadow: false,
        implementationReadyRequired: true,
        implementerProfile: 'flash-direct-worker',
      },
    };
  }

  const control = decideRoute({ taskAction: 'ORCHESTRATE' });
  return {
    ...control,
    directWork: {
      ...directWorkMetadata(gate, lane),
      applicable: true,
      shadow: false,
      controlReturned: true,
    },
  };
}

export function createAntigravityDirectWorkPacket(implementation = {}) {
  const implementationPacket = buildImplementationPacket(implementation);
  const readiness = assessImplementationReadiness(implementationPacket);
  if (!readiness.ready) {
    const error = new Error('PACKET_INSUFFICIENT');
    error.code = 'PACKET_INSUFFICIENT';
    throw error;
  }
  return Object.freeze({
    schema: 'orchestra.antigravity-direct-work-packet.v1',
    role: 'IMPLEMENTER',
    workerProfile: 'flash-direct-worker',
    implementationPacket,
  });
}

export function createAntigravityQuickAuditPacket({
  implementationPacket,
  candidate,
  diffRef,
  changedFiles = [],
  evidenceRefs = [],
} = {}) {
  return Object.freeze({
    schema: 'orchestra.antigravity-quick-audit-packet.v1',
    role: 'QUICK_AUDITOR',
    workerProfile: 'flash-quick-auditor',
    implementationPacket,
    candidate,
    diffRef,
    changedFiles: [...changedFiles],
    evidenceRefs: [...evidenceRefs],
  });
}
