import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function stableHash(...parts) {
  return `sha256:${createHash('sha256').update(parts.join('\0'), 'utf8').digest('hex')}`;
}

function stableId(prefix, ...parts) {
  return `${prefix}_${stableHash(...parts).slice('sha256:'.length, 'sha256:'.length + 24)}`;
}

function makeWork(project, evidenceRef) {
  return {
    schema: 'orchestra.work-unit.v2',
    workId: stableId('work', project.projectId, 'v2-cutover-isolation'),
    projectId: project.projectId,
    taskId: stableId('task', project.lineageId, 'v2-cutover-isolation'),
    generation: 0,
    runtimeImage: project.runtime.pinnedImage,
    instructionEpoch: project.runtime.instructionEpoch,
    state: 'IMPLEMENTING',
    scopeRef: null,
    directionRef: null,
    candidateRef: null,
    evidenceRefs: [evidenceRef],
    blockers: [],
    continuationRef: null,
  };
}

function makeOperation(project, work, actor, suffix, nowIso) {
  return {
    schema: 'orchestra.operation.v2',
    operationId: stableId('op', project.projectId, work.workId, suffix),
    projectId: project.projectId,
    workId: work.workId,
    generation: work.generation,
    kind: 'DIRECT_MUTATION',
    actorRef: `${actor.provider}:${actor.subjectHash}`,
    capabilities: ['WORKSPACE_EDIT'],
    workflowState: 'RUNNING',
    liveness: 'LIVE',
    startedAt: nowIso,
    heartbeatAt: nowIso,
    deadlineAt: new Date(Date.parse(nowIso) + 60_000).toISOString(),
    runtimeOwnerRef: `owner:${stableHash(project.projectId, work.workId, suffix)}`,
    workspaceRef: `workspace:${project.lineageId}:${suffix}`,
    resultRef: null,
  };
}

function makeAssessment(operation, observedAt, liveness, reason) {
  return {
    schema: 'orchestra.liveness-assessment.v2',
    operationId: operation.operationId,
    observedAt,
    liveness,
    reason,
    evidence: {
      ownerStatus: null,
      heartbeatFresh: null,
      deadlineExpired: true,
    },
  };
}

function osFamily() {
  if (process.platform === 'win32') return 'windows';
  if (process.platform === 'darwin') return 'macos';
  return 'linux';
}

async function loadParts() {
  const [
    registryModule,
    authorityModule,
    reconcilerModule,
    projectorModule,
    queryModule,
  ] = await Promise.all([
    import('../global/project-registry.mjs'),
    import('../authority/work-authority.mjs'),
    import('../reconciliation/reconciler.mjs'),
    import('../experience/projector.mjs'),
    import('../experience/query.mjs'),
  ]);
  return {
    createGlobalProjectRegistry: registryModule.createGlobalProjectRegistry,
    createWorkAuthority: authorityModule.createWorkAuthority,
    createOperationReconciler: reconcilerModule.createOperationReconciler,
    projectExperience: projectorModule.projectExperience,
    createExperienceQuery: queryModule.createExperienceQuery,
  };
}

function projectExperienceInput({ project, work, operation, actor, lineages }) {
  return {
    category: 'EXECUTION',
    sourceProjectId: project.projectId,
    sourceLineageId: project.lineageId,
    workId: work.workId,
    operationId: operation.operationId,
    domainCohort: 'software-engineering',
    facts: {
      providerFamily: actor.provider,
      osFamily: osFamily(),
      runtimeVersion: '2.0.0',
      operationClass: 'IMPLEMENTATION',
      routeClass: 'DIRECT_WORK',
      retryCount: 0,
      latencyBucket: 'LOW',
    },
    outcome: {
      terminalOutcome: 'SUCCEEDED',
      success: true,
    },
    projectLineageIds: lineages,
    requestedScope: 'GLOBAL_CANDIDATE',
    projectionVersion: '1',
  };
}

export async function verifyMultiProjectIsolation({
  home,
  launcherPath,
  projects,
  installThinShim,
  removeThinShim,
  now = () => new Date().toISOString(),
} = {}) {
  if (!nonEmptyString(home) || !nonEmptyString(launcherPath)) {
    throw new TypeError('home and launcherPath are required');
  }
  if (!Array.isArray(projects) || projects.length !== 2) {
    throw new TypeError('exactly two project fixtures are required');
  }
  for (const item of projects) {
    if (!nonEmptyString(item?.root) || !nonEmptyString(item?.runtimeImage)
      || !Number.isInteger(item?.instructionEpoch) || item.instructionEpoch < 0
      || !nonEmptyString(item?.evidenceRef) || !item?.actor) {
      throw new TypeError('each project fixture requires root, runtimeImage, instructionEpoch, evidenceRef and actor');
    }
  }
  if (typeof installThinShim !== 'function' || typeof removeThinShim !== 'function') {
    throw new TypeError('installThinShim and removeThinShim are required');
  }
  if (typeof now !== 'function') throw new TypeError('now must be a function');

  const {
    createGlobalProjectRegistry,
    createWorkAuthority,
    createOperationReconciler,
    projectExperience,
    createExperienceQuery,
  } = await loadParts();

  const registry = createGlobalProjectRegistry({ home });
  try {
    const registeredProjects = [];
    const shims = [];
    for (const fixture of projects) {
      const registration = await registry.registerWorkspace({
        root: resolve(fixture.root),
        runtimeImage: fixture.runtimeImage,
        instructionEpoch: fixture.instructionEpoch,
        trustMode: 'trusted',
      });
      if (!registration?.ok || !registration.project) {
        return Object.freeze({ ok: false, code: 'CUTOVER_MULTI_PROJECT_REGISTRATION_FAILED' });
      }
      registeredProjects.push(registration.project);
      const shim = installThinShim({
        targetDir: resolve(fixture.root),
        launcherPath,
        nodePath: process.execPath,
        orchestraHome: home,
      });
      if (!shim?.ok) return Object.freeze({ ok: false, code: 'CUTOVER_MULTI_PROJECT_SHIM_FAILED' });
      shims.push(shim);
    }

    const [projectA, projectB] = registeredProjects;
    if (projectA.projectId === projectB.projectId || projectA.lineageId === projectB.lineageId) {
      return Object.freeze({ ok: false, code: 'CUTOVER_MULTI_PROJECT_IDENTITY_COLLISION' });
    }

    const authority = createWorkAuthority({ state: registry.state });
    const works = registeredProjects.map((project, index) => makeWork(project, projects[index].evidenceRef));
    for (const work of works) {
      const started = authority.start(work);
      if (!started?.ok) return Object.freeze({ ok: false, code: 'CUTOVER_MULTI_PROJECT_WORK_START_FAILED' });
    }

    const observedAt = now();
    const operations = [
      makeOperation(projectA, works[0], projects[0].actor, 'dirty-a', observedAt),
      makeOperation(projectB, works[1], projects[1].actor, 'completed-b', observedAt),
    ];
    for (const operation of operations) {
      const begun = registry.state.operations.begin({
        expectedGeneration: 0,
        operation,
      });
      if (!begun?.ok) return Object.freeze({ ok: false, code: 'CUTOVER_MULTI_PROJECT_OPERATION_BEGIN_FAILED' });
    }
    const bTerminal = registry.state.operations.terminalize({
      operationId: operations[1].operationId,
      workflowState: 'COMPLETED',
      resultRef: 'cutover:multi-project:b-complete',
    });
    if (!bTerminal?.ok) {
      return Object.freeze({ ok: false, code: 'CUTOVER_MULTI_PROJECT_OPERATION_TERMINALIZE_FAILED' });
    }
    operations[1] = bTerminal.operation ?? registry.state.operations.inspect(operations[1].operationId);

    const deterministicReconciler = createOperationReconciler({
      state: registry.state,
      operationLiveness: {
        async assess(operation) {
          if (operation.operationId === operations[0].operationId) {
            return makeAssessment(operation, observedAt, 'STALE_RECOVERABLE', 'OWNER_ABSENT_BOUNDED_STALE');
          }
          return makeAssessment(operation, observedAt, 'TERMINAL', 'WORKFLOW_TERMINAL');
        },
      },
      workspaceRecovery: {
        async inspect(workspaceRef, operation) {
          if (operation.operationId !== operations[0].operationId) {
            throw new Error('only the stale Project A operation may require workspace inspection');
          }
          return { workspaceRef, status: 'DIRTY' };
        },
        async cleanup() {
          throw new Error('Task 3 isolation inspection must not mutate dirty workspace state');
        },
      },
      now,
    });
    const projectAStatus = await deterministicReconciler.inspect({ projectId: projectA.projectId });
    const projectADirty = projectAStatus.operations.find((entry) => entry.operation.operationId === operations[0].operationId);

    const projectBMutation = await authority.authorize({
      projectId: projectB.projectId,
      expectedWorkId: works[1].workId,
      actor: projects[1].actor,
      observedInstructionEpoch: projectB.runtime.instructionEpoch,
      capability: 'WORKSPACE_EDIT',
      workspaceRef: `workspace:${projectB.lineageId}:next`,
      expectedGeneration: works[1].generation,
    });

    const sessionCrossProject = registry.state.sessionObservations.put({
      provider: projects[0].actor.provider,
      projectId: projectA.projectId,
      actorIdHash: projects[0].actor.subjectHash,
      observedInstructionEpoch: projectA.runtime.instructionEpoch,
      observedWorkId: works[1].workId,
      observedGeneration: works[1].generation,
      observedAt,
    });

    const correlationCrossProject = registry.state.operationCorrelations.put({
      provider: projects[0].actor.provider,
      projectId: projectA.projectId,
      correlationHash: stableHash('cutover-correlation', projectA.projectId, projectB.projectId),
      operationId: operations[1].operationId,
      workId: works[1].workId,
      generation: works[1].generation,
      actorIdHash: projects[0].actor.subjectHash,
    });

    const lineageIds = registeredProjects.map((project) => project.lineageId);
    for (let index = 0; index < registeredProjects.length; index += 1) {
      const projected = projectExperience(projectExperienceInput({
        project: registeredProjects[index],
        work: works[index],
        operation: operations[index],
        actor: projects[index].actor,
        lineages: lineageIds,
      }));
      if (!projected?.valid) {
        return Object.freeze({
          ok: false,
          code: 'CUTOVER_MULTI_PROJECT_EXPERIENCE_PROJECTION_FAILED',
          errors: projected?.errors ?? [],
        });
      }
      const persisted = registry.state.experience.put(projected.experience);
      if (!persisted?.ok) {
        return Object.freeze({ ok: false, code: 'CUTOVER_MULTI_PROJECT_EXPERIENCE_PERSIST_FAILED' });
      }
    }

    const experienceQuery = createExperienceQuery({ persistence: registry.state.experience });
    const crossProject = experienceQuery.crossProject({ filters: { category: 'EXECUTION' } });
    const privateA = experienceQuery.projectPrivate({
      projectId: projectA.projectId,
      filters: { category: 'EXECUTION' },
    });
    const privateB = experienceQuery.projectPrivate({
      projectId: projectB.projectId,
      filters: { category: 'EXECUTION' },
    });
    const crossProjectPrivateIdsAbsent = crossProject.items.every((item) => (
      item.source?.projectId === undefined
      && item.source?.workId === undefined
      && item.source?.operationId === undefined
    ));
    const projectPrivateIsolation = privateA.items.length === 1
      && privateB.items.length === 1
      && privateA.items[0].source.projectId === projectA.projectId
      && privateB.items[0].source.projectId === projectB.projectId;

    const removedA = removeThinShim({
      targetDir: resolve(projects[0].root),
      files: shims[0].files,
    });
    const projectAFilesAbsent = shims[0].files.every((relativePath) => !existsSync(join(projects[0].root, relativePath)));
    const projectBFilesPresent = shims[1].files.every((relativePath) => existsSync(join(projects[1].root, relativePath)));
    const projectBAfterRemoval = registry.state.projects.inspect(projectB.projectId);
    const workBAfterRemoval = registry.state.work.current(projectB.projectId);

    return Object.freeze({
      ok: true,
      projects: Object.freeze(registeredProjects.map((project) => structuredClone(project))),
      works: Object.freeze(works.map((work) => structuredClone(work))),
      operations: Object.freeze(operations.map((operation) => structuredClone(operation))),
      dirtyIsolation: Object.freeze({
        projectAAction: projectADirty?.actionRequired ?? null,
        projectBMutationAllowed: projectBMutation?.allowed === true,
      }),
      providerIsolation: Object.freeze({
        sessionCrossProjectRejected: sessionCrossProject?.ok === false
          && sessionCrossProject.reason === 'SESSION_OBSERVATION_WORK_PROJECT_MISMATCH',
        correlationCrossProjectRejected: correlationCrossProject?.ok === false
          && correlationCrossProject.reason === 'OPERATION_CORRELATION_OPERATION_MISMATCH',
      }),
      experience: Object.freeze({
        crossProjectCount: crossProject.items.length,
        crossProjectPrivateIdsAbsent,
        projectPrivateIsolation,
      }),
      shimIsolation: Object.freeze({
        projectARemoved: removedA?.ok === true && projectAFilesAbsent,
        projectBStateIntact: projectBFilesPresent
          && projectBAfterRemoval?.projectId === projectB.projectId
          && workBAfterRemoval?.workId === works[1].workId,
      }),
    });
  } finally {
    registry.close();
  }
}
