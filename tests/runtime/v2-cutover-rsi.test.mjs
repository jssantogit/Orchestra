import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const NODE_MAJOR = Number(process.versions.node.split('.')[0]);
const FIXED_NOW = '2026-10-18T01:05:00.000Z';

function sha256(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== 'object') return value;
  const output = {};
  for (const key of Object.keys(value).sort()) output[key] = canonicalValue(value[key]);
  return output;
}

function decisionDigest(evaluation, replay) {
  return sha256(JSON.stringify(canonicalValue({ evaluation, replay })));
}

function git(cwd, ...args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function makeGitProject(name) {
  const root = mkdtempSync(join(tmpdir(), `orchestra-v2-rsi-${name}-`));
  writeFileSync(join(root, 'README.md'), `${name}\n`, 'utf8');
  git(root, 'init');
  git(root, 'config', 'user.email', 'orchestra-v2-tests@example.invalid');
  git(root, 'config', 'user.name', 'Orchestra V2 Tests');
  git(root, 'add', '.');
  git(root, 'commit', '-m', `fixture: ${name}`);
  return root;
}

function experienceId(index) {
  return `exp-${index.toString(16).padStart(24, '0')}`;
}

function experience(project, index) {
  return {
    schema: 'orchestra.experience.v2',
    version: 1,
    experienceId: experienceId(index),
    category: 'EXECUTION',
    source: {
      projectId: project.projectId,
      lineageId: project.lineageId,
      workId: null,
      operationId: null,
    },
    domainCohort: 'software-engineering',
    facts: {
      providerFamily: 'codex',
      routeClass: 'DIRECT_WORK',
      retryCount: 0,
      durationMs: 100,
    },
    outcome: {
      terminalOutcome: 'SUCCEEDED',
      success: true,
    },
    generalization: {
      scope: 'GLOBAL_CANDIDATE',
      projectLineageCount: 4,
    },
    privacy: {
      projectionVersion: '1',
      containsRawProjectContent: false,
    },
  };
}

function policyCandidate() {
  return {
    schema: 'orchestra.learned-policy.v2',
    version: 1,
    policyId: 'policy-cutover-replay',
    revision: 1,
    scope: 'GLOBAL',
    domainCohort: null,
    projectId: null,
    lifecycle: 'CANDIDATE',
    selectors: {
      allowedRoutes: ['DIRECT_WORK', 'DELEGATED'],
      routePreference: 'DIRECT_WORK',
      allowedProviderProfiles: ['CODEX_DEFAULT', 'AGY_DEFAULT'],
      providerProfilePreference: 'CODEX_DEFAULT',
      allowedRetryClasses: ['STANDARD', 'RESILIENT'],
      retryClass: 'STANDARD',
      allowedTimeoutClasses: ['STANDARD', 'LONG'],
      timeoutClass: 'LONG',
      allowedTurnEconomy: ['BALANCED', 'AGGRESSIVE'],
      turnEconomy: 'BALANCED',
    },
    createdAt: FIXED_NOW,
  };
}

const GATE = Object.freeze({
  minTrainLineages: 2,
  requireSuccess: true,
  metrics: Object.freeze({
    retryCount: Object.freeze({ max: 1 }),
    durationMs: Object.freeze({ max: 1_000 }),
  }),
});

const IMMUTABLE_CHOICES = Object.freeze({
  routes: Object.freeze(['DIRECT_WORK', 'DELEGATED']),
  providerProfiles: Object.freeze(['CODEX_DEFAULT', 'AGY_DEFAULT']),
  retryClasses: Object.freeze(['STANDARD', 'RESILIENT']),
  timeoutClasses: Object.freeze(['STANDARD', 'LONG']),
  turnEconomy: Object.freeze(['BALANCED', 'AGGRESSIVE']),
});

function cohort(records, lineageIds) {
  const allowed = new Set(lineageIds);
  const selected = records.filter((record) => allowed.has(record.source.lineageId));
  return {
    lineageIds: [...lineageIds].sort(),
    records: selected,
  };
}

function cohorts(records, lineageIds) {
  return {
    train: cohort(records, lineageIds.slice(0, 2)),
    evaluate: cohort(records, [lineageIds[2]]),
    holdout: cohort(records, [lineageIds[3]]),
  };
}

function work(project) {
  return {
    schema: 'orchestra.work-unit.v2',
    workId: `work-rsi-${project.projectId}`,
    projectId: project.projectId,
    taskId: `task-rsi-${project.projectId}`,
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
}

function actor() {
  return {
    schema: 'orchestra.actor-provenance.v2',
    provider: 'codex',
    subjectHash: `sha256:${'9'.repeat(64)}`,
    source: 'PROVIDER_FACT',
    observedAt: FIXED_NOW,
  };
}

if (NODE_MAJOR < 24) {
  test('V2-11 RSI cutover replay remains gated from the Node 20 v1 baseline', () => {
    assert.ok(NODE_MAJOR < 24);
  });
} else {
  test('four-lineage sanitized RSI replay is deterministic across bootstrap and cannot widen authority', async () => {
    const [
      registryModule,
      queryModule,
      policyStoreModule,
      promotionModule,
      replayModule,
      executionPolicyModule,
      authorityModule,
    ] = await Promise.all([
      import('../../v2/global/project-registry.mjs'),
      import('../../v2/experience/query.mjs'),
      import('../../v2/rsi/policy-store.mjs'),
      import('../../v2/rsi/promotion.mjs'),
      import('../../v2/rsi/replay.mjs'),
      import('../../v2/rsi/execution-policy.mjs'),
      import('../../v2/authority/work-authority.mjs'),
    ]);

    const home = mkdtempSync(join(tmpdir(), 'orchestra-v2-rsi-cutover-home-'));
    const roots = ['train-a', 'train-b', 'evaluate-c', 'holdout-d'].map(makeGitProject);
    let firstRegistry = registryModule.createGlobalProjectRegistry({ home });
    let reopened = null;

    try {
      const projects = [];
      for (const root of roots) {
        const registered = await firstRegistry.registerWorkspace({
          root,
          runtimeImage: 'runtime-rsi-cutover',
          instructionEpoch: 0,
          trustMode: 'trusted',
        });
        assert.equal(registered.ok, true);
        projects.push(registered.project);
      }
      assert.equal(new Set(projects.map((project) => project.lineageId)).size, 4);

      for (let index = 0; index < projects.length; index += 1) {
        const put = firstRegistry.state.experience.put(experience(projects[index], 0x501 + index));
        assert.equal(put.ok, true);
      }

      const firstWork = work(projects[0]);
      assert.equal(firstRegistry.state.work.startCurrent(firstWork).ok, true);

      const experienceQuery = queryModule.createExperienceQuery({ persistence: firstRegistry.state.experience });
      const crossProject = experienceQuery.crossProject({ filters: { category: 'EXECUTION' } });
      assert.equal(crossProject.items.length, 4);
      assert.equal(crossProject.items.every((record) => Object.keys(record.source).join(',') === 'lineageId'), true);
      assert.equal(crossProject.items.every((record) => record.privacy.containsRawProjectContent === false), true);
      const serializedReplayPayload = JSON.stringify(crossProject.items);
      for (const forbidden of ['projectId', 'prompt', 'transcript', 'rawLog', 'providerSessionId', 'sourceCode']) {
        assert.equal(serializedReplayPayload.includes(forbidden), false, forbidden);
      }

      const lineageIds = projects.map((project) => project.lineageId);
      const firstCohorts = cohorts(crossProject.items, lineageIds);
      assert.deepEqual(firstCohorts.train.lineageIds, [...lineageIds.slice(0, 2)].sort());
      assert.deepEqual(firstCohorts.evaluate.lineageIds, [lineageIds[2]]);
      assert.deepEqual(firstCohorts.holdout.lineageIds, [lineageIds[3]]);

      const candidate = policyCandidate();
      const policyStore = policyStoreModule.createLearnedPolicyStore({
        persistence: firstRegistry.state.learnedPolicies,
      });
      assert.equal(policyStore.putCandidate(candidate).ok, true);
      const activation = promotionModule.activatePromotionCandidate({
        candidate,
        cohorts: firstCohorts,
        gate: GATE,
        policyStore,
      });
      assert.equal(activation.ok, true);
      assert.equal(activation.code, 'RSI_POLICY_ACTIVATED');
      assert.equal(activation.evaluation.promotable, true);
      assert.equal(activation.replay.passed, true);
      const firstDigest = decisionDigest(activation.evaluation, activation.replay);

      const firstSelection = executionPolicyModule.selectExecutionPolicy({
        immutableChoices: IMMUTABLE_CHOICES,
        candidateChoices: IMMUTABLE_CHOICES,
        policyStore,
        domainCohort: 'software-engineering',
        projectId: projects[0].projectId,
      });
      assert.equal(firstSelection.ok, true);
      assert.equal(firstSelection.degraded, false);
      assert.equal(firstSelection.code, 'RSI_POLICY_APPLIED');
      assert.equal(firstSelection.selection.timeoutClass, 'LONG');

      const authority = authorityModule.createWorkAuthority({ state: firstRegistry.state });
      const authorizedBeforeBootstrap = await authority.authorize({
        projectId: projects[0].projectId,
        expectedWorkId: firstWork.workId,
        actor: actor(),
        observedInstructionEpoch: 0,
        capability: 'WORKSPACE_EDIT',
        workspaceRef: `workspace:${projects[0].lineageId}:rsi-proof`,
        expectedGeneration: 0,
      });
      assert.equal(authorizedBeforeBootstrap.allowed, true);

      firstRegistry.close();
      firstRegistry = null;
      reopened = registryModule.createGlobalProjectRegistry({ home });

      const reopenedQuery = queryModule.createExperienceQuery({ persistence: reopened.state.experience });
      const replayPayload = reopenedQuery.crossProject({ filters: { category: 'EXECUTION' } });
      assert.deepEqual(replayPayload.items, crossProject.items);
      const replayCohorts = cohorts(replayPayload.items, lineageIds);
      const reopenedStore = policyStoreModule.createLearnedPolicyStore({ persistence: reopened.state.learnedPolicies });
      const reopenedCandidate = reopenedStore.inspect(candidate.policyId, candidate.revision);
      assert.deepEqual(reopenedCandidate, candidate);

      const reevaluation = promotionModule.evaluatePromotionCandidate({
        candidate: reopenedCandidate,
        cohorts: replayCohorts,
        gate: GATE,
      });
      assert.equal(reevaluation.promotable, true);
      const replay = replayModule.evaluateHoldoutReplay({
        candidate: reopenedCandidate,
        promotionEvidence: reevaluation.evidence,
        holdout: replayCohorts.holdout,
        gate: GATE,
      });
      assert.equal(replay.passed, true);
      assert.equal(decisionDigest(reevaluation, replay), firstDigest);

      const secondSelection = executionPolicyModule.selectExecutionPolicy({
        immutableChoices: IMMUTABLE_CHOICES,
        candidateChoices: IMMUTABLE_CHOICES,
        policyStore: reopenedStore,
        domainCohort: 'software-engineering',
        projectId: projects[0].projectId,
      });
      assert.deepEqual(secondSelection, firstSelection);
      assert.equal(secondSelection.selection.timeoutClass, 'LONG');

      const corruptedRecord = structuredClone(replayPayload.items[0]);
      corruptedRecord.privacy.containsRawProjectContent = true;
      const corruptedCohorts = {
        ...replayCohorts,
        train: {
          ...replayCohorts.train,
          records: [corruptedRecord, replayCohorts.train.records[1]],
        },
      };
      const corruptedEvaluation = promotionModule.evaluatePromotionCandidate({
        candidate: reopenedCandidate,
        cohorts: corruptedCohorts,
        gate: GATE,
      });
      assert.equal(corruptedEvaluation.promotable, false);
      assert.notEqual(corruptedEvaluation.code, 'RSI_POLICY_ACTIVATED');

      const reopenedAuthority = authorityModule.createWorkAuthority({ state: reopened.state });
      const authorityStillWorks = await reopenedAuthority.authorize({
        projectId: projects[0].projectId,
        expectedWorkId: firstWork.workId,
        actor: actor(),
        observedInstructionEpoch: 0,
        capability: 'WORKSPACE_EDIT',
        workspaceRef: `workspace:${projects[0].lineageId}:rsi-proof`,
        expectedGeneration: 0,
      });
      assert.equal(authorityStillWorks.allowed, true);

      const staleGenerationStillDenied = await reopenedAuthority.authorize({
        projectId: projects[0].projectId,
        expectedWorkId: firstWork.workId,
        actor: actor(),
        observedInstructionEpoch: 0,
        capability: 'WORKSPACE_EDIT',
        workspaceRef: `workspace:${projects[0].lineageId}:rsi-proof`,
        expectedGeneration: 1,
      });
      assert.equal(staleGenerationStillDenied.allowed, false);
      assert.equal(staleGenerationStillDenied.reason, 'STALE_GENERATION');

      const capabilityInjection = executionPolicyModule.selectExecutionPolicy({
        immutableChoices: IMMUTABLE_CHOICES,
        candidateChoices: IMMUTABLE_CHOICES,
        policyStore: reopenedStore,
        domainCohort: 'software-engineering',
        projectId: projects[0].projectId,
        capability: 'WORKSPACE_EDIT',
      });
      assert.equal(capabilityInjection.ok, false);
      assert.equal(capabilityInjection.code, 'RSI_EXECUTION_POLICY_REQUEST_INVALID');
    } finally {
      if (firstRegistry) firstRegistry.close();
      if (reopened) reopened.close();
      for (const root of roots) rmSync(root, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });
}
