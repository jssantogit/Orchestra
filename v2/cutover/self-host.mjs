import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import { createWorkAuthority } from '../authority/work-authority.mjs';
import { createGlobalProjectRegistry } from '../global/project-registry.mjs';
import { createGlobalStatusReconciler } from '../global/reconciliation.mjs';
import { installCodexV2Shim } from '../providers/codex/shim-manager.mjs';

function failure(code, fields = {}) {
  return Object.freeze({ ok: false, code, ...fields });
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isWithin(root, candidate) {
  const fromRoot = relative(resolve(root), resolve(candidate));
  return fromRoot === '' || (
    fromRoot !== '..'
    && !fromRoot.startsWith(`..${sep}`)
    && !isAbsolute(fromRoot)
  );
}

function readOrchestraIdentity(projectRoot) {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8'));
  } catch {
    return false;
  }
  if (manifest?.name !== 'orchestra') return false;
  try {
    return statSync(join(projectRoot, 'v2', 'global', 'orchestra.mjs')).isFile();
  } catch {
    return false;
  }
}

function stableId(prefix, ...parts) {
  const digest = createHash('sha256').update(parts.join('\0'), 'utf8').digest('hex').slice(0, 24);
  return `${prefix}_${digest}`;
}

function actorRef(actor) {
  return `${actor.provider}:${actor.subjectHash}`;
}

function operationDeadline(nowIso) {
  return new Date(Date.parse(nowIso) + 60_000).toISOString();
}

export async function verifyOrchestraSelfHost({
  projectRoot,
  home,
  launcherPath,
  nodePath = process.execPath,
  runtimeImage,
  instructionEpoch,
  trustMode = 'trusted',
  actor,
  now = () => new Date().toISOString(),
} = {}) {
  if (!nonEmptyString(projectRoot) || !nonEmptyString(home) || !nonEmptyString(launcherPath)) {
    throw new TypeError('projectRoot, home and launcherPath are required');
  }
  if (!nonEmptyString(runtimeImage)) throw new TypeError('runtimeImage is required');
  if (!Number.isInteger(instructionEpoch) || instructionEpoch < 0) {
    throw new TypeError('instructionEpoch must be a non-negative integer');
  }
  if (!actor || typeof actor !== 'object') throw new TypeError('actor is required');
  if (typeof now !== 'function') throw new TypeError('now must be a function');

  const root = resolve(projectRoot);
  if (!readOrchestraIdentity(root)) {
    return failure('CUTOVER_SELF_HOST_NOT_ORCHESTRA');
  }

  const registry = createGlobalProjectRegistry({ home });
  try {
    const registered = await registry.registerWorkspace({
      root,
      runtimeImage,
      instructionEpoch,
      trustMode,
    });
    if (!registered?.ok || !registered.project) {
      return failure('CUTOVER_SELF_HOST_REGISTRATION_FAILED', { registration: registered ?? null });
    }
    const project = registered.project;

    const shim = installCodexV2Shim({
      targetDir: root,
      launcherPath,
      nodePath,
      orchestraHome: home,
    });
    if (!shim?.ok) return failure('CUTOVER_SELF_HOST_SHIM_FAILED');

    const work = {
      schema: 'orchestra.work-unit.v2',
      workId: stableId('work', project.projectId, 'v2-cutover-self-host'),
      projectId: project.projectId,
      taskId: stableId('task', project.lineageId, 'v2-cutover-self-host'),
      generation: 0,
      runtimeImage: project.runtime.pinnedImage,
      instructionEpoch: project.runtime.instructionEpoch,
      state: 'IMPLEMENTING',
      scopeRef: null,
      directionRef: null,
      candidateRef: null,
      evidenceRefs: [],
      blockers: [],
      continuationRef: null,
    };

    const authority = createWorkAuthority({ state: registry.state });
    const started = authority.start(work);
    if (!started?.ok) {
      return failure('CUTOVER_SELF_HOST_WORK_START_FAILED', { start: started });
    }
    const currentWork = started.work ?? registry.state.work.current(project.projectId);

    const attach = authority.attach({
      projectId: project.projectId,
      actor,
      observedInstructionEpoch: project.runtime.instructionEpoch,
    });
    if (!attach?.allowed) {
      return failure('CUTOVER_SELF_HOST_ATTACH_FAILED', { attach });
    }

    const staleEpoch = authority.attach({
      projectId: project.projectId,
      actor,
      observedInstructionEpoch: project.runtime.instructionEpoch + 1,
    });

    const workspaceRef = `workspace:self-host:${project.lineageId}`;
    const mutationAuthorization = await authority.authorize({
      projectId: project.projectId,
      expectedWorkId: currentWork.workId,
      actor,
      observedInstructionEpoch: project.runtime.instructionEpoch,
      capability: 'WORKSPACE_EDIT',
      workspaceRef,
      expectedGeneration: currentWork.generation,
    });
    if (!mutationAuthorization?.allowed) {
      return failure('CUTOVER_SELF_HOST_MUTATION_AUTH_FAILED', { mutationAuthorization });
    }

    const staleGeneration = await authority.authorize({
      projectId: project.projectId,
      expectedWorkId: currentWork.workId,
      actor,
      observedInstructionEpoch: project.runtime.instructionEpoch,
      capability: 'WORKSPACE_EDIT',
      workspaceRef,
      expectedGeneration: currentWork.generation + 1,
    });

    const staleWork = await authority.authorize({
      projectId: project.projectId,
      expectedWorkId: `${currentWork.workId}:stale`,
      actor,
      observedInstructionEpoch: project.runtime.instructionEpoch,
      capability: 'WORKSPACE_EDIT',
      workspaceRef,
      expectedGeneration: currentWork.generation,
    });

    const startedAt = now();
    const operation = {
      schema: 'orchestra.operation.v2',
      operationId: stableId('op', project.projectId, currentWork.workId, String(currentWork.generation)),
      projectId: project.projectId,
      workId: currentWork.workId,
      generation: currentWork.generation,
      kind: 'DIRECT_MUTATION',
      actorRef: actorRef(actor),
      capabilities: ['WORKSPACE_EDIT'],
      workflowState: 'RUNNING',
      liveness: 'LIVE',
      startedAt,
      heartbeatAt: startedAt,
      deadlineAt: operationDeadline(startedAt),
      runtimeOwnerRef: null,
      workspaceRef,
      resultRef: null,
    };
    const operationBegin = registry.state.operations.begin({
      expectedGeneration: currentWork.generation,
      operation,
    });
    if (!operationBegin?.ok) {
      return failure('CUTOVER_SELF_HOST_OPERATION_BEGIN_FAILED', { operationBegin });
    }
    const operationTerminalization = registry.state.operations.terminalize({
      operationId: operation.operationId,
      workflowState: 'COMPLETED',
      resultRef: 'cutover:self-host:verified',
    });
    if (!operationTerminalization?.ok) {
      return failure('CUTOVER_SELF_HOST_OPERATION_TERMINALIZATION_FAILED', { operationTerminalization });
    }

    const statusReconciler = createGlobalStatusReconciler({
      state: registry.state,
      home,
      now,
    });
    const status = await statusReconciler.inspect({ projectId: project.projectId });
    if (!status?.ok) {
      return failure('CUTOVER_SELF_HOST_STATUS_FAILED', { status });
    }

    const globalStateOutsideProject = !isWithin(root, registry.paths.statePath);
    const noFullLocalGovernanceRuntime = shim.files.length === 2
      && shim.files.includes('.codex/hooks.json')
      && shim.files.includes('.codex/orchestra-v2-hook.mjs')
      && !shim.files.some((path) => path.startsWith('v2/') || path.includes('/v2/'));

    return Object.freeze({
      ok: true,
      project,
      work: currentWork,
      attach,
      staleEpoch,
      staleGeneration,
      staleWork,
      mutationAuthorization,
      operationBegin,
      operationTerminalization,
      status,
      shim,
      globalStateOutsideProject,
      noFullLocalGovernanceRuntime,
    });
  } finally {
    registry.close();
  }
}
