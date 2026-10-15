import { decideRoute, normalizeTaskAction } from './routing-policy.mjs';
import { EXECUTION_MODES, selectExecutionMode } from './core/workflow/direct-work-policy.mjs';
import {
  buildImplementationPacket,
  assessImplementationReadiness,
} from './core/workflow/implementation-packet.mjs';
import { assessParallelScopeIndependence } from './core/delegation/parallel-scope.mjs';

const DIRECT_WORK_GATES = new Set(['off', 'shadow', 'on']);

export function readAntigravityDirectWorkMode(env = process.env) {
  const configured = env?.ORCHESTRA_DIRECT_WORK_MODE;
  if (configured == null || String(configured).trim() === '') return 'on';
  const raw = String(configured).trim().toLowerCase();
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

function implementationParallelism(facts = {}) {
  const request = facts.parallelImplementation;
  if (request?.requestedMode !== 'PARALLEL_2') {
    return { mode: 'SERIAL', reason: 'SERIAL_DEFAULT' };
  }

  const shards = request.shards;
  const prerequisites = facts.bounded === true
    && facts.independentWorkstreams === 2
    && facts.unresolvedDiagnosis !== true
    && facts.openEndedDiagnosis !== true
    && Array.isArray(shards)
    && shards.length === 2
    && shards.every((shard) => shard?.resolved === true
      && shard?.bounded === true
      && shard.mutationScope
      && typeof shard.mutationScope === 'object');
  if (!prerequisites) {
    return { mode: 'SERIAL', reason: 'PARALLEL_PREREQUISITES_UNMET' };
  }

  try {
    const independence = assessParallelScopeIndependence(
      shards[0].mutationScope,
      shards[1].mutationScope,
    );
    if (independence.independent !== true) {
      return { mode: 'SERIAL', reason: 'PARALLEL_PREREQUISITES_UNMET' };
    }
  } catch {
    return { mode: 'SERIAL', reason: 'PARALLEL_PREREQUISITES_UNMET' };
  }

  return { mode: 'PARALLEL_2', reason: 'EXPLICIT_PARALLEL_2' };
}

function directWorkMetadata(gate, lane, parallel) {
  const parallelActive = gate === 'on' && parallel.mode === 'PARALLEL_2';
  return {
    gate,
    mode: lane.mode,
    reason: lane.reason,
    auditRequired: lane.auditRequired,
    implementationParallelism: parallel,
    primaryWorkerCount: parallelActive
      ? 2
      : lane.mode === EXECUTION_MODES.DIRECT_WORK ? 1 : 0,
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
  const parallel = implementationParallelism(facts);
  if (gate === 'shadow') {
    return {
      ...baseline,
      directWork: {
        ...directWorkMetadata(gate, lane, parallel),
        applicable: true,
        shadow: true,
        actualExecutor: baseline.executor,
      },
    };
  }

  if (lane.mode === EXECUTION_MODES.DIRECT_WORK && parallel.mode !== 'PARALLEL_2') {
    return {
      ...baseline,
      directWork: {
        ...directWorkMetadata(gate, lane, parallel),
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
      ...directWorkMetadata(gate, lane, parallel),
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
