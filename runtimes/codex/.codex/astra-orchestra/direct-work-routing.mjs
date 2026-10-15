import { decideRoute, normalizeTaskAction } from './routing-policy.mjs';
import { EXECUTION_MODES, selectExecutionMode } from './core/workflow/direct-work-policy.mjs';
import {
  buildImplementationPacket,
  assessImplementationReadiness,
} from './core/workflow/implementation-packet.mjs';
import { assessParallelScopeIndependence } from './core/delegation/parallel-scope.mjs';
import { createCodexWorkerPacket } from './context-packet.mjs';

const DIRECT_WORK_GATES = new Set(['off', 'shadow', 'on']);

export function readCodexDirectWorkMode(env = process.env) {
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
        ? 'luna-auditor'
        : null,
  };
}

export function decideCodexWork(facts = {}, { env = process.env } = {}) {
  const baseline = decideRoute(facts);
  const gate = readCodexDirectWorkMode(env);
  if (gate === 'off') return baseline;

  const action = normalizeTaskAction(facts);
  const applicable = ['IMPLEMENT', 'MECHANICAL_FIX'].includes(action);
  if (!applicable) {
    return {
      ...baseline,
      directWork: { gate, applicable: false },
    };
  }

  const lane = selectExecutionMode(laneFacts(facts));
  const parallel = implementationParallelism(facts);
  if (gate === 'shadow') {
    return {
      ...baseline,
      directWork: {
        ...directWorkMetadata(gate, lane, parallel),
        applicable: true,
        shadow: true,
        actualProfile: baseline.profile,
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
        implementerProfile: baseline.profile,
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

export function createCodexDirectWorkPacket({
  implementation = {},
  task = {},
  scopeContract = {},
  activeState = {},
  auxiliaryRefs = [],
} = {}) {
  const implementationPacket = buildImplementationPacket(implementation);
  const readiness = assessImplementationReadiness(implementationPacket);
  if (!readiness.ready) {
    const error = new Error('PACKET_INSUFFICIENT');
    error.code = 'PACKET_INSUFFICIENT';
    throw error;
  }

  return createCodexWorkerPacket({
    task,
    scopeContract,
    activeState,
    auxiliaryRefs,
    implementationPacket,
    workerRole: 'IMPLEMENTER',
  });
}

export function createCodexQuickAuditPacket({
  implementationPacket,
  candidate,
  diffRef,
  changedFiles = [],
  evidenceRefs = [],
} = {}) {
  return Object.freeze({
    schema: 'orchestra.codex-quick-audit-packet.v1',
    role: 'QUICK_AUDITOR',
    implementationPacket,
    candidate,
    diffRef,
    changedFiles: [...changedFiles],
    evidenceRefs: [...evidenceRefs],
  });
}
