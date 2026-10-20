import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { collectCanonicalCutoverReadinessFragment } from '../../v2/cutover/readiness-evidence.mjs';

const NODE_MAJOR = Number(process.versions.node.split('.')[0]);
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const HEAD = execFileSync('git', ['-C', REPO_ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const RUNTIME_IMAGE = `sha256:${'b'.repeat(64)}`;
const PROBE_MODULE = 'v2/cutover/readiness-probes.mjs';

function git(cwd, ...args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function makeProject(name = 'probe-project') {
  const root = mkdtempSync(join(tmpdir(), `orchestra-readiness-${name}-`));
  writeFileSync(join(root, 'README.md'), `${name}\n`, 'utf8');
  git(root, 'init');
  git(root, 'config', 'user.email', 'orchestra-tests@example.invalid');
  git(root, 'config', 'user.name', 'Orchestra Tests');
  git(root, 'add', '.');
  git(root, 'commit', '-m', `fixture: ${name}`);
  return root;
}

async function registeredFixture() {
  const projectRoot = makeProject();
  const home = mkdtempSync(join(tmpdir(), 'orchestra-readiness-home-'));
  const { createGlobalProjectRegistry } = await import('../../v2/global/project-registry.mjs');
  const registry = createGlobalProjectRegistry({ home });
  const registered = await registry.registerWorkspace({
    root: projectRoot,
    runtimeImage: RUNTIME_IMAGE,
    instructionEpoch: 3,
    trustMode: 'trusted',
  });
  assert.equal(registered.ok, true);
  registry.close();
  return { projectRoot, home, project: registered.project };
}

function descriptor(exportArgs) {
  return { modulePath: PROBE_MODULE, args: exportArgs };
}

if (NODE_MAJOR < 24) {
  test('source-controlled readiness probes remain gated from the Node 20 v1 baseline', () => {
    assert.ok(NODE_MAJOR < 24);
  });
} else {
  test('source-controlled readiness probe module registers every non-provider readiness family', async () => {
    const module = await import('../../v2/cutover/readiness-probes.mjs');
    assert.deepEqual(module.readinessProbeManifest, {
      schema: 'orchestra.cutover-readiness-probe-module.v2',
      version: 1,
      probes: {
        registryPersistence: 'registryPersistence',
        runtimeLifecycle: 'runtimeLifecycle',
        reconciliation: 'reconciliation',
        experiencePrivacy: 'experiencePrivacy',
        rsiReplay: 'rsiReplay',
        migration: 'migration',
        'platforms.windows': 'windowsPlatform',
        'platforms.posix': 'posixPlatform',
        projects: 'project',
        selfHost: 'selfHost',
      },
    });
  });

  test('canonical registry, native-platform and Project probes derive facts from real state instead of caller facts', async () => {
    const fixture = await registeredFixture();
    try {
      const platformKey = process.platform === 'win32' ? 'windows' : 'posix';
      const fragment = await collectCanonicalCutoverReadinessFragment({
        repoRoot: REPO_ROOT,
        expectedHeadSha: HEAD,
        expectedRuntimeImageId: RUNTIME_IMAGE,
        probes: {
          registryPersistence: descriptor({ home: fixture.home, projectId: fixture.project.projectId }),
          platforms: {
            [platformKey]: descriptor({}),
          },
          projects: [descriptor({ home: fixture.home, projectId: fixture.project.projectId })],
        },
      });

      assert.deepEqual(fragment.errors, []);
      assert.equal(fragment.evidence.registryPersistence.status, 'VERIFIED');
      assert.equal(fragment.evidence.registryPersistence.facts.restartVerified, true);
      assert.equal(fragment.evidence.registryPersistence.facts.freshProcessVerified, true);
      assert.equal(fragment.evidence.platforms[platformKey].facts.nativeVerified, true);
      assert.equal(fragment.evidence.projects[0].facts.projectId, fixture.project.projectId);
      assert.equal(fragment.evidence.projects[0].facts.lineageId, fixture.project.lineageId);
      assert.equal(fragment.evidence.projects[0].facts.noFullLocalGovernanceRuntime, true);
      assert.match(fragment.evidence.projects[0].facts.homeIdentity, /^sha256:[0-9a-f]{64}$/);
      assert.match(fragment.evidenceRefs[0], /^sha256:[0-9a-f]{64}$/);
    } finally {
      rmSync(fixture.projectRoot, { recursive: true, force: true });
      rmSync(fixture.home, { recursive: true, force: true });
    }
  });

  test('production probes reject caller-supplied fact-shaped fields instead of treating them as evidence', async () => {
    const fixture = await registeredFixture();
    try {
      const fragment = await collectCanonicalCutoverReadinessFragment({
        repoRoot: REPO_ROOT,
        expectedHeadSha: HEAD,
        expectedRuntimeImageId: RUNTIME_IMAGE,
        probes: {
          registryPersistence: descriptor({
            home: fixture.home,
            projectId: fixture.project.projectId,
            facts: { restartVerified: true },
          }),
        },
      });
      assert.equal(fragment.evidence.registryPersistence, undefined);
      assert.ok(fragment.errors.includes('registryPersistence:probe-error'));
    } finally {
      rmSync(fixture.projectRoot, { recursive: true, force: true });
      rmSync(fixture.home, { recursive: true, force: true });
    }
  });

  test('Project probe fails closed when a full local governance-runtime marker is present', async () => {
    const fixture = await registeredFixture();
    try {
      mkdirSync(join(fixture.projectRoot, '.orchestra/runtime/delegation'), { recursive: true });
      writeFileSync(join(fixture.projectRoot, '.orchestra/runtime/delegation/brain.mjs'), 'export default true;\n');
      const fragment = await collectCanonicalCutoverReadinessFragment({
        repoRoot: REPO_ROOT,
        expectedHeadSha: HEAD,
        expectedRuntimeImageId: RUNTIME_IMAGE,
        probes: {
          projects: [descriptor({ home: fixture.home, projectId: fixture.project.projectId })],
        },
      });
      assert.equal(fragment.evidence.projects, undefined);
      assert.ok(fragment.errors.includes('projects[0]:ok'));
    } finally {
      rmSync(fixture.projectRoot, { recursive: true, force: true });
      rmSync(fixture.home, { recursive: true, force: true });
    }
  });

  test('self-host probe fails closed when a full local governance-runtime marker is present', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'orchestra-readiness-self-host-'));
    const home = mkdtempSync(join(tmpdir(), 'orchestra-readiness-self-host-home-'));
    try {
      mkdirSync(join(projectRoot, 'v2/global'), { recursive: true });
      writeFileSync(join(projectRoot, 'package.json'), JSON.stringify({ name: 'orchestra' }));
      writeFileSync(join(projectRoot, 'v2/global/orchestra.mjs'), 'export {};\n');
      git(projectRoot, 'init');
      git(projectRoot, 'config', 'user.email', 'orchestra-tests@example.invalid');
      git(projectRoot, 'config', 'user.name', 'Orchestra Tests');
      git(projectRoot, 'add', '.');
      git(projectRoot, 'commit', '-m', 'fixture: minimal Orchestra self-host');

      const { verifyOrchestraSelfHost } = await import('../../v2/cutover/self-host.mjs');
      const { installCodexV2Shim } = await import('../../v2/providers/codex/shim-manager.mjs');
      const setup = await verifyOrchestraSelfHost({
        projectRoot,
        home,
        launcherPath: process.execPath,
        runtimeImage: RUNTIME_IMAGE,
        instructionEpoch: 3,
        actor: {
          schema: 'orchestra.actor-provenance.v2',
          provider: 'codex',
          subjectHash: `sha256:${'a'.repeat(64)}`,
          source: 'PROVIDER_FACT',
          observedAt: new Date().toISOString(),
        },
        installThinShim: installCodexV2Shim,
      });
      assert.equal(setup.ok, true);

      mkdirSync(join(projectRoot, '.orchestra/runtime/delegation'), { recursive: true });
      writeFileSync(join(projectRoot, '.orchestra/runtime/delegation/brain.mjs'), 'export default true;\n');
      const operationId = setup.operationBegin.operation.operationId;
      const { selfHost } = await import('../../v2/cutover/readiness-probes.mjs');
      const probe = await selfHost({
        expectedHeadSha: HEAD,
        expectedRuntimeImageId: RUNTIME_IMAGE,
        args: { home, projectId: setup.project.projectId, operationId },
      });
      const { project } = await import('../../v2/cutover/readiness-probes.mjs');
      const projectProbe = await project({
        expectedHeadSha: HEAD,
        expectedRuntimeImageId: RUNTIME_IMAGE,
        args: { home, projectId: setup.project.projectId },
      });

      assert.equal(probe.ok, false);
      assert.equal(probe.facts.noFullLocalGovernanceRuntime, false);
      assert.match(probe.facts.homeIdentity, /^sha256:[0-9a-f]{64}$/);
      assert.equal(projectProbe.facts.homeIdentity, probe.facts.homeIdentity);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('self-host probe accepts successful native terminal mutations and rejects invalid outcomes or authority', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'orchestra-readiness-self-host-native-'));
    const secondProjectRoot = mkdtempSync(join(tmpdir(), 'orchestra-readiness-self-host-native-second-'));
    const home = mkdtempSync(join(tmpdir(), 'orchestra-readiness-self-host-native-home-'));
    try {
      mkdirSync(join(projectRoot, 'v2/global'), { recursive: true });
      writeFileSync(join(projectRoot, 'package.json'), JSON.stringify({ name: 'orchestra' }));
      writeFileSync(join(projectRoot, 'v2/global/orchestra.mjs'), 'export {};\n');
      git(projectRoot, 'init');
      git(projectRoot, 'config', 'user.email', 'orchestra-tests@example.invalid');
      git(projectRoot, 'config', 'user.name', 'Orchestra Tests');
      git(projectRoot, 'add', '.');
      git(projectRoot, 'commit', '-m', 'fixture: minimal Orchestra self-host');

      const { verifyOrchestraSelfHost } = await import('../../v2/cutover/self-host.mjs');
      const { installCodexV2Shim } = await import('../../v2/providers/codex/shim-manager.mjs');
      const setup = await verifyOrchestraSelfHost({
        projectRoot,
        home,
        launcherPath: process.execPath,
        runtimeImage: RUNTIME_IMAGE,
        instructionEpoch: 3,
        actor: {
          schema: 'orchestra.actor-provenance.v2',
          provider: 'codex',
          subjectHash: `sha256:${'a'.repeat(64)}`,
          source: 'PROVIDER_FACT',
          observedAt: new Date().toISOString(),
        },
        installThinShim: installCodexV2Shim,
      });
      assert.equal(setup.ok, true);

      const { createGlobalProjectRegistry } = await import('../../v2/global/project-registry.mjs');
      const { selfHost } = await import('../../v2/cutover/readiness-probes.mjs');
      let sequence = 0;
      async function probeOperation({
        workflowState = 'SUCCEEDED',
        kind = 'DIRECT_MUTATION',
        capabilities = ['WORKSPACE_EDIT'],
        resultRef = 'provider-result:succeeded:native',
        terminal = true,
        fixtureSetup = setup,
        workspaceRef = fixtureSetup.project.workspace.canonicalRoot,
      } = {}) {
        const registry = createGlobalProjectRegistry({ home });
        const template = fixtureSetup.operationBegin.operation;
        const operationId = `native-self-host-probe-${++sequence}`;
        const operation = {
          ...template,
          operationId,
          kind,
          capabilities,
          workflowState: 'RUNNING',
          liveness: 'LIVE',
          workspaceRef,
          resultRef: null,
        };
        try {
          const begun = registry.state.operations.begin({
            expectedGeneration: operation.generation,
            operation,
          });
          assert.equal(begun.ok, true);
          if (terminal) {
            const completed = registry.state.operations.terminalize({ operationId, workflowState, resultRef });
            assert.equal(completed.ok, true);
            assert.equal(completed.operation.workflowState, workflowState);
            assert.equal(completed.operation.liveness, 'TERMINAL');
            assert.equal(completed.operation.resultRef, resultRef);
          } else {
            assert.equal(begun.operation.workflowState, 'RUNNING');
            assert.equal(begun.operation.liveness, 'LIVE');
          }
        } finally {
          registry.close();
        }
        return selfHost({
          expectedHeadSha: HEAD,
          expectedRuntimeImageId: RUNTIME_IMAGE,
          args: { home, projectId: fixtureSetup.project.projectId, operationId },
        });
      }

      mkdirSync(join(secondProjectRoot, 'v2/global'), { recursive: true });
      writeFileSync(join(secondProjectRoot, 'package.json'), JSON.stringify({ name: 'orchestra' }));
      writeFileSync(join(secondProjectRoot, 'v2/global/orchestra.mjs'), 'export {};\n');
      git(secondProjectRoot, 'init');
      git(secondProjectRoot, 'config', 'user.email', 'orchestra-tests@example.invalid');
      git(secondProjectRoot, 'config', 'user.name', 'Orchestra Tests');
      git(secondProjectRoot, 'add', '.');
      git(secondProjectRoot, 'commit', '-m', 'fixture: second minimal Orchestra self-host');
      const secondSetup = await verifyOrchestraSelfHost({
        projectRoot: secondProjectRoot,
        home,
        launcherPath: process.execPath,
        runtimeImage: RUNTIME_IMAGE,
        instructionEpoch: 3,
        actor: {
          schema: 'orchestra.actor-provenance.v2',
          provider: 'codex',
          subjectHash: `sha256:${'b'.repeat(64)}`,
          source: 'PROVIDER_FACT',
          observedAt: new Date().toISOString(),
        },
        installThinShim: installCodexV2Shim,
      });
      assert.equal(secondSetup.ok, true);

      const outcomes = {
        failed: (await probeOperation({ workflowState: 'FAILED' })).ok,
        aborted: (await probeOperation({ workflowState: 'ABORTED' })).ok,
        unknown: (await probeOperation({ workflowState: 'UNKNOWN' })).ok,
        missingResult: (await probeOperation({ resultRef: null })).ok,
        wrongKind: (await probeOperation({ kind: 'OBSERVATION' })).ok,
        missingCapability: (await probeOperation({ capabilities: [] })).ok,
        wrongWorkspace: (await probeOperation({ workspaceRef: 'workspace:other-project' })).ok,
        wrongProject: (await selfHost({
          expectedHeadSha: HEAD,
          expectedRuntimeImageId: RUNTIME_IMAGE,
          args: {
            home,
            projectId: secondSetup.project.projectId,
            operationId: setup.operationBegin.operation.operationId,
          },
        })).ok,
        runningTerminal: (await probeOperation({ workflowState: 'RUNNING' })).ok,
        completed: (await probeOperation({
          workflowState: 'COMPLETED',
          workspaceRef: setup.operationBegin.operation.workspaceRef,
        })).ok,
        completedNative: (await probeOperation({
          workflowState: 'COMPLETED',
        })).ok,
        succeededSynthetic: (await probeOperation({
          workspaceRef: setup.operationBegin.operation.workspaceRef,
        })).ok,
        succeededNative: (await probeOperation()).ok,
        running: (await probeOperation({
          workflowState: 'RUNNING',
          terminal: false,
          fixtureSetup: secondSetup,
        })).ok,
      };
      assert.deepEqual(outcomes, {
        failed: false,
        aborted: false,
        unknown: false,
        missingResult: false,
        wrongKind: false,
        missingCapability: false,
        wrongWorkspace: false,
        wrongProject: false,
        runningTerminal: false,
        completed: true,
        completedNative: true,
        succeededSynthetic: false,
        succeededNative: true,
        running: false,
      });
    } finally {
      rmSync(projectRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      rmSync(secondProjectRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
}

test("canonical native RSI probe refuses caller-authored cohort lineages and promotion gates", async () => {
  const { rsiReplay } = await import("../../v2/cutover/readiness-probes.mjs");
  await assert.rejects(
    rsiReplay({
      expectedHeadSha: "sha256:candidate",
      expectedRuntimeImageId: "sha256:image",
      args: {
        home: "/unused", policyId: "native-policy", revision: 1,
        trainLineageIds: ["fake-a", "fake-b"],
        evaluateLineageIds: ["fake-c"],
        holdoutLineageIds: ["fake-d"],
        gate: { minTrainLineages: 2, requireSuccess: false, metrics: {} },
      },
    }),
    /probe args contain unknown fields/,
  );
});
