import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

const PROBE_SCHEMA = 'orchestra.cutover-readiness-probe-module.v2';
const FULL_LOCAL_GOVERNANCE_MARKERS = Object.freeze([
  '.codex/astra-orchestra',
  '.codex/agents',
  '.agents/agents',
  '.agents/skills',
  '.agents/dream',
  '.orchestra/runtime/delegation',
]);
const SELF_HOST_THIN_SHIMS = Object.freeze([
  '.codex/hooks.json',
  '.codex/orchestra-v2-hook.mjs',
]);

export const readinessProbeManifest = Object.freeze({
  schema: PROBE_SCHEMA,
  version: 1,
  probes: Object.freeze({
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
  }),
});

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireArgs(args, allowed, required = []) {
  if (!isObject(args) || Object.keys(args).some((key) => !allowed.has(key))) {
    throw new TypeError('probe args contain unknown fields');
  }
  for (const key of required) {
    if (typeof args[key] !== 'string' || args[key].trim().length === 0) {
      throw new TypeError(`${key} is required`);
    }
  }
  return args;
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
}

function evidenceRef(kind, snapshot) {
  const encoded = JSON.stringify(canonicalValue({ kind, snapshot }));
  return `sha256:${createHash('sha256').update(encoded, 'utf8').digest('hex')}`;
}

function result({ ok, expectedHeadSha, expectedRuntimeImageId, facts, kind, snapshot }) {
  return Object.freeze({
    ok: ok === true,
    headSha: expectedHeadSha,
    runtimeImageId: expectedRuntimeImageId,
    facts: Object.freeze(structuredClone(facts)),
    evidenceRefs: Object.freeze([evidenceRef(kind, snapshot)]),
  });
}

function inside(root, candidate) {
  const fromRoot = relative(resolve(root), resolve(candidate));
  return fromRoot === '' || (fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot));
}

function gitTopLevel(root) {
  try {
    return execFileSync('git', ['-C', root, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    }).trim();
  } catch {
    return null;
  }
}

function realDirectory(path) {
  try {
    const stats = lstatSync(path);
    return stats.isDirectory() && !stats.isSymbolicLink() ? realpathSync(path) : null;
  } catch {
    return null;
  }
}

function homeIdentity(home) {
  try {
    const canonical = realpathSync(home);
    const normalized = process.platform === 'win32' ? canonical.toLowerCase() : canonical;
    return `sha256:${createHash('sha256').update(normalized, 'utf8').digest('hex')}`;
  } catch {
    return null;
  }
}

function noFullLocalGovernanceRuntime(root) {
  return FULL_LOCAL_GOVERNANCE_MARKERS.every((marker) => !existsSync(join(root, marker)));
}

async function openRegistry(home) {
  const { createGlobalProjectRegistry } = await import('../global/project-registry.mjs');
  return createGlobalProjectRegistry({ home });
}

function projectMatchesRuntime(projectRecord, expectedRuntimeImageId) {
  return projectRecord?.runtime?.pinnedImage === expectedRuntimeImageId;
}

function inspectRegistryInFreshProcess(home, projectId) {
  const registryModuleUrl = new URL('../global/project-registry.mjs', import.meta.url).href;
  const script = [
    'const module = await import(process.argv[1]);',
    'const registry = module.createGlobalProjectRegistry({ home: process.argv[2] });',
    'try {',
    '  const project = registry.inspect(process.argv[3]);',
    '  process.stdout.write(JSON.stringify(project));',
    '} finally {',
    '  registry.close();',
    '}',
  ].join('\n');
  try {
    const stdout = execFileSync(process.execPath, [
      '--input-type=module',
      '--eval',
      script,
      registryModuleUrl,
      home,
      projectId,
    ], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

export async function registryPersistence({ expectedHeadSha, expectedRuntimeImageId, args } = {}) {
  const input = requireArgs(args, new Set(['home', 'projectId']), ['home', 'projectId']);
  let first;
  const registry = await openRegistry(input.home);
  try {
    first = registry.inspect(input.projectId);
  } finally {
    registry.close();
  }

  let second;
  const reopened = await openRegistry(input.home);
  try {
    second = reopened.inspect(input.projectId);
  } finally {
    reopened.close();
  }

  const sameAfterReopen = first !== null && second !== null && JSON.stringify(first) === JSON.stringify(second);
  const freshProcess = inspectRegistryInFreshProcess(input.home, input.projectId);
  const freshProcessVerified = first !== null
    && freshProcess !== null
    && JSON.stringify(first) === JSON.stringify(freshProcess);
  const restartVerified = sameAfterReopen && freshProcessVerified;
  const ok = restartVerified && projectMatchesRuntime(freshProcess, expectedRuntimeImageId);
  return result({
    ok,
    expectedHeadSha,
    expectedRuntimeImageId,
    kind: 'registry-persistence',
    facts: { restartVerified, freshProcessVerified },
    snapshot: {
      projectId: freshProcess?.projectId ?? null,
      lineageId: freshProcess?.lineageId ?? null,
      runtimeImageId: freshProcess?.runtime?.pinnedImage ?? null,
      sameAfterReopen,
      freshProcessVerified,
    },
  });
}

function parseCommandRow(row) {
  if (!row) return null;
  try {
    return {
      request: JSON.parse(row.request_json),
      result: JSON.parse(row.result_json),
      createdAt: row.created_at,
    };
  } catch {
    return null;
  }
}

export async function runtimeLifecycle({ expectedHeadSha, expectedRuntimeImageId, args } = {}) {
  const input = requireArgs(
    args,
    new Set(['home', 'projectId', 'upgradeCommandId', 'rollbackCommandId']),
    ['home', 'projectId', 'upgradeCommandId', 'rollbackCommandId'],
  );
  const [{ createRuntimeImageStore }, { resolveGlobalRegistryPaths }, sqlite] = await Promise.all([
    import('../runtime-images/store.mjs'),
    import('../global/project-registry.mjs'),
    import('node:sqlite'),
  ]);

  const imageStore = createRuntimeImageStore({ orchestraHome: input.home });
  const installed = await imageStore.verify(expectedRuntimeImageId);
  const registry = await openRegistry(input.home);
  let projectRecord;
  try {
    projectRecord = registry.inspect(input.projectId);
  } finally {
    registry.close();
  }

  const { statePath } = resolveGlobalRegistryPaths({ home: input.home });
  let upgrade = null;
  let rollback = null;
  let database = null;
  try {
    database = new sqlite.DatabaseSync(statePath);
    const statement = database.prepare(`
      SELECT request_json, result_json, created_at
      FROM project_runtime_commands
      WHERE project_id = ? AND command_id = ?
    `);
    upgrade = parseCommandRow(statement.get(input.projectId, input.upgradeCommandId));
    rollback = parseCommandRow(statement.get(input.projectId, input.rollbackCommandId));
  } catch {
    upgrade = null;
    rollback = null;
  } finally {
    database?.close();
  }

  const upgradeTarget = upgrade?.request?.targetImage ?? null;
  const upgradeVerified = upgrade?.request?.projectId === input.projectId
    && upgrade?.request?.commandId === input.upgradeCommandId
    && typeof upgradeTarget === 'string'
    && upgradeTarget.length > 0
    && upgradeTarget !== expectedRuntimeImageId
    && upgrade?.result?.ok === true
    && upgrade?.result?.project?.runtime?.pinnedImage === upgradeTarget;
  const rollbackVerified = rollback?.request?.projectId === input.projectId
    && rollback?.request?.commandId === input.rollbackCommandId
    && rollback?.request?.targetImage === expectedRuntimeImageId
    && rollback?.result?.ok === true
    && rollback?.result?.project?.runtime?.pinnedImage === expectedRuntimeImageId
    && Number.isFinite(Date.parse(upgrade?.createdAt ?? ''))
    && Number.isFinite(Date.parse(rollback?.createdAt ?? ''))
    && Date.parse(rollback.createdAt) >= Date.parse(upgrade.createdAt);
  const pinned = projectMatchesRuntime(projectRecord, expectedRuntimeImageId);
  const ok = installed?.valid === true && pinned && upgradeVerified && rollbackVerified;

  return result({
    ok,
    expectedHeadSha,
    expectedRuntimeImageId,
    kind: 'runtime-lifecycle',
    facts: {
      installed: installed?.valid === true,
      pinned,
      rollbackVerified,
      runtimeImageId: expectedRuntimeImageId,
    },
    snapshot: {
      projectId: input.projectId,
      installed: installed?.valid === true,
      pinned,
      upgradeVerified,
      rollbackVerified,
      currentEpoch: projectRecord?.runtime?.instructionEpoch ?? null,
    },
  });
}

function staleRecovery(record) {
  return record?.outcome === 'RECOVERED'
    && record?.terminal?.workflowState === 'ABORTED'
    && typeof record?.terminal?.resultRef === 'string'
    && ['STALE_RECOVERABLE', 'TERMINAL'].includes(record?.assessment?.liveness);
}

function dirtyRecovery(record) {
  return record?.resolutionAction === 'PRESERVE'
    && record?.outcome === 'STALE_DIRTY'
    && record?.workspace?.status === 'DIRTY'
    && record?.cleanup?.status === 'PRESERVED'
    && record?.terminal?.workflowState === 'ABORTED';
}

export async function reconciliation({ expectedHeadSha, expectedRuntimeImageId, args } = {}) {
  const input = requireArgs(
    args,
    new Set(['home', 'projectId', 'staleOperationId', 'dirtyOperationId']),
    ['home', 'projectId', 'staleOperationId', 'dirtyOperationId'],
  );
  const registry = await openRegistry(input.home);
  let projectRecord;
  let stale;
  let dirty;
  try {
    projectRecord = registry.inspect(input.projectId);
    stale = registry.state.recoveries.latest({ projectId: input.projectId, operationId: input.staleOperationId });
    dirty = registry.state.recoveries.latest({ projectId: input.projectId, operationId: input.dirtyOperationId });
  } finally {
    registry.close();
  }
  const staleRecoveryVerified = staleRecovery(stale);
  const dirtyRecoveryVerified = dirtyRecovery(dirty);
  const ok = projectMatchesRuntime(projectRecord, expectedRuntimeImageId)
    && staleRecoveryVerified
    && dirtyRecoveryVerified;
  return result({
    ok,
    expectedHeadSha,
    expectedRuntimeImageId,
    kind: 'reconciliation',
    facts: { staleRecoveryVerified, dirtyRecoveryVerified },
    snapshot: {
      projectId: input.projectId,
      staleOutcome: stale?.outcome ?? null,
      dirtyOutcome: dirty?.outcome ?? null,
      dirtyResolutionAction: dirty?.resolutionAction ?? null,
    },
  });
}

async function crossProjectExperience(registry) {
  const { createExperienceQuery } = await import('../experience/query.mjs');
  const query = createExperienceQuery({ persistence: registry.state.experience });
  const items = [];
  let cursor = null;
  for (let page = 0; page < 100; page += 1) {
    const resultPage = query.crossProject({ limit: 100, cursor });
    items.push(...resultPage.items);
    if (resultPage.nextCursor === null) return items;
    if (resultPage.nextCursor === cursor) throw new Error('Experience pagination did not advance');
    cursor = resultPage.nextCursor;
  }
  throw new Error('Experience pagination exceeded readiness bound');
}

function sanitizedExperience(record) {
  return isObject(record)
    && isObject(record.source)
    && Object.keys(record.source).length === 1
    && typeof record.source.lineageId === 'string'
    && record.source.projectId === undefined
    && record.source.workId === undefined
    && record.source.operationId === undefined
    && record.privacy?.containsRawProjectContent === false;
}

export async function experiencePrivacy({ expectedHeadSha, expectedRuntimeImageId, args } = {}) {
  const input = requireArgs(args, new Set(['home', 'minRecords']), ['home']);
  if (input.minRecords !== undefined && (!Number.isInteger(input.minRecords) || input.minRecords < 1)) {
    throw new TypeError('minRecords must be a positive integer');
  }
  const registry = await openRegistry(input.home);
  let records;
  try {
    records = await crossProjectExperience(registry);
  } finally {
    registry.close();
  }
  const minRecords = input.minRecords ?? 1;
  const sanitized = records.length >= minRecords && records.every(sanitizedExperience);
  const lineages = new Set(records.map((record) => record.source.lineageId));
  return result({
    ok: sanitized,
    expectedHeadSha,
    expectedRuntimeImageId,
    kind: 'experience-privacy',
    facts: {
      sanitizedGlobalProjectionVerified: sanitized,
      recordCount: records.length,
      lineageCount: lineages.size,
    },
    snapshot: {
      recordCount: records.length,
      lineageCount: lineages.size,
      sanitized,
    },
  });
}

function cohort(records, lineageIds) {
  const allowed = new Set(lineageIds);
  const selected = records.filter((record) => allowed.has(record.source.lineageId));
  return {
    lineageIds: [...new Set(selected.map((record) => record.source.lineageId))].sort(),
    records: selected,
  };
}

function validLineageList(value, minimum = 1) {
  return Array.isArray(value)
    && value.length >= minimum
    && value.every((item) => typeof item === 'string' && item.trim().length > 0)
    && new Set(value).size === value.length;
}

export async function rsiReplay({ expectedHeadSha, expectedRuntimeImageId, args } = {}) {
  // Native RSI evidence is derived exclusively from the durable Home journal.
  // Callers may locate a candidate, but may not supply TRAIN/EVALUATE/HOLDOUT,
  // promotion thresholds, lineage counts or positive readiness facts.
  const input = requireArgs(
    args,
    new Set(['home', 'policyId', 'revision']),
    ['home', 'policyId', 'revision'],
  );
  if (!Number.isInteger(input.revision) || input.revision < 1) {
    throw new TypeError('rsi replay revision is invalid');
  }

  const registry = await openRegistry(input.home);
  let native;
  try {
    const { createLearnedPolicyStore } = await import('../rsi/policy-store.mjs');
    const { verifyNativeRsiReplay } = await import('../rsi/native-pipeline.mjs');
    const policyStore = createLearnedPolicyStore({ persistence: registry.state.learnedPolicies });
    native = verifyNativeRsiReplay({
      policyId: input.policyId,
      revision: input.revision,
      nativeStore: registry.state.nativeRsi,
      policyStore,
      runtimeImageId: expectedRuntimeImageId,
    });
  } finally {
    registry.close();
  }

  const verified = native?.ok === true
    && native?.trainVerified === true
    && native?.evaluateVerified === true
    && native?.holdoutVerified === true
    && native?.lineageCount >= 4;
  return result({
    ok: verified,
    expectedHeadSha,
    expectedRuntimeImageId,
    kind: 'rsi-replay',
    facts: {
      trainVerified: verified,
      evaluateVerified: verified,
      holdoutVerified: verified,
      lineageCount: verified ? native.lineageCount : 0,
    },
    snapshot: {
      policyId: input.policyId,
      revision: input.revision,
      evaluationCode: native?.code ?? 'RSI_NATIVE_UNAVAILABLE',
      replayCode: verified ? 'RSI_NATIVE_REPLAY_PASSED' : null,
      sourceDigest: native?.sourceDigest ?? null,
    },
  });
}

function migrationWorkVerified(work) {
  return work !== null
    && Array.isArray(work.evidenceRefs)
    && work.evidenceRefs.length > 0
    && ['IMPORTED', 'ABANDONED'].includes(work.state);
}

function tsuzukiRecoveryVerified(work) {
  return work !== null
    && typeof work.taskId === 'string'
    && work.taskId.startsWith('migration-recovery:')
    && work.state === 'ABANDONED'
    && Array.isArray(work.evidenceRefs)
    && work.evidenceRefs.length > 0
    && Array.isArray(work.blockers)
    && work.blockers.some((value) => (
      typeof value === 'string'
      && (value.startsWith('MIGRATION_TRANSIENT_UNKNOWN:') || value.startsWith('MIGRATION_TRANSIENT_RECONCILE:'))
    ));
}

export async function migration({ expectedHeadSha, expectedRuntimeImageId, args } = {}) {
  const input = requireArgs(
    args,
    new Set(['home', 'projectId', 'migrationWorkId', 'tsuzukiF7WorkId']),
    ['home', 'projectId', 'migrationWorkId', 'tsuzukiF7WorkId'],
  );
  const registry = await openRegistry(input.home);
  let projectRecord;
  let migrationWork;
  let f7Work;
  try {
    projectRecord = registry.inspect(input.projectId);
    migrationWork = registry.state.work.read(input.projectId, input.migrationWorkId);
    f7Work = registry.state.work.read(input.projectId, input.tsuzukiF7WorkId);
  } finally {
    registry.close();
  }
  const migrationVerified = migrationWorkVerified(migrationWork);
  const tsuzukiF7Verified = tsuzukiRecoveryVerified(f7Work);
  const ok = projectMatchesRuntime(projectRecord, expectedRuntimeImageId)
    && migrationVerified
    && tsuzukiF7Verified;
  return result({
    ok,
    expectedHeadSha,
    expectedRuntimeImageId,
    kind: 'migration',
    facts: { migrationVerified, tsuzukiF7Verified },
    snapshot: {
      projectId: input.projectId,
      migrationState: migrationWork?.state ?? null,
      f7State: f7Work?.state ?? null,
      f7BlockerClass: f7Work?.blockers?.some((value) => String(value).startsWith('MIGRATION_TRANSIENT_UNKNOWN:'))
        ? 'UNKNOWN'
        : f7Work?.blockers?.some((value) => String(value).startsWith('MIGRATION_TRANSIENT_RECONCILE:'))
          ? 'RECONCILE'
          : null,
    },
  });
}

function platformResult({ expectedHeadSha, expectedRuntimeImageId, expectedFamily }) {
  const actualFamily = process.platform === 'win32' ? 'windows' : 'posix';
  const nativeVerified = actualFamily === expectedFamily;
  return result({
    ok: nativeVerified,
    expectedHeadSha,
    expectedRuntimeImageId,
    kind: `platform-${expectedFamily}`,
    facts: {
      nativeVerified,
      platform: process.platform,
      nodeMajor: Number(process.versions.node.split('.')[0]),
    },
    snapshot: {
      actualFamily,
      platform: process.platform,
      nodeVersion: process.versions.node,
    },
  });
}

export async function windowsPlatform({ expectedHeadSha, expectedRuntimeImageId, args } = {}) {
  requireArgs(args, new Set());
  return platformResult({ expectedHeadSha, expectedRuntimeImageId, expectedFamily: 'windows' });
}

export async function posixPlatform({ expectedHeadSha, expectedRuntimeImageId, args } = {}) {
  requireArgs(args, new Set());
  return platformResult({ expectedHeadSha, expectedRuntimeImageId, expectedFamily: 'posix' });
}

export async function project({ expectedHeadSha, expectedRuntimeImageId, args } = {}) {
  const input = requireArgs(args, new Set(['home', 'projectId']), ['home', 'projectId']);
  const homeId = homeIdentity(input.home);
  const registry = await openRegistry(input.home);
  let projectRecord;
  try {
    projectRecord = registry.inspect(input.projectId);
  } finally {
    registry.close();
  }
  const root = projectRecord?.workspace?.canonicalRoot ?? null;
  const realRoot = typeof root === 'string' ? realDirectory(root) : null;
  const gitRoot = realRoot ? gitTopLevel(realRoot) : null;
  let canonicalGit = false;
  if (realRoot && gitRoot) {
    try {
      canonicalGit = realpathSync(gitRoot) === realRoot;
    } catch {
      canonicalGit = false;
    }
  }
  const noLocalBrain = realRoot ? noFullLocalGovernanceRuntime(realRoot) : false;
  const ok = projectRecord !== null
    && projectMatchesRuntime(projectRecord, expectedRuntimeImageId)
    && canonicalGit
    && noLocalBrain
    && homeId !== null;
  return result({
    ok,
    expectedHeadSha,
    expectedRuntimeImageId,
    kind: 'project',
    facts: {
      projectId: projectRecord?.projectId ?? '',
      lineageId: projectRecord?.lineageId ?? '',
      noFullLocalGovernanceRuntime: noLocalBrain,
      homeIdentity: homeId ?? '',
    },
    snapshot: {
      projectId: projectRecord?.projectId ?? null,
      lineageId: projectRecord?.lineageId ?? null,
      runtimeImageId: projectRecord?.runtime?.pinnedImage ?? null,
      canonicalGit,
      noLocalBrain,
      homeIdentity: homeId,
    },
  });
}

function orchestraSourceIdentity(root) {
  try {
    const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    return packageJson?.name === 'orchestra' && statSync(join(root, 'v2/global/orchestra.mjs')).isFile();
  } catch {
    return false;
  }
}

function selfHostThinShim(root, home) {
  try {
    if (!SELF_HOST_THIN_SHIMS.every((path) => statSync(join(root, path)).isFile())) return false;
    const shim = readFileSync(join(root, '.codex/orchestra-v2-hook.mjs'), 'utf8');
    return shim.includes('GLOBAL_ORCHESTRA_HOME') && shim.includes(JSON.stringify(home));
  } catch {
    return false;
  }
}

export async function selfHost({ expectedHeadSha, expectedRuntimeImageId, args } = {}) {
  const input = requireArgs(
    args,
    new Set(['home', 'projectId', 'operationId']),
    ['home', 'projectId', 'operationId'],
  );
  const { resolveGlobalRegistryPaths } = await import('../global/project-registry.mjs');
  const registry = await openRegistry(input.home);
  let projectRecord;
  let operation;
  try {
    projectRecord = registry.inspect(input.projectId);
    operation = registry.state.operations.inspect(input.operationId);
  } finally {
    registry.close();
  }
  const root = projectRecord?.workspace?.canonicalRoot ?? null;
  const realRoot = typeof root === 'string' ? realDirectory(root) : null;
  const homeId = homeIdentity(input.home);
  const statePath = resolveGlobalRegistryPaths({ home: input.home }).statePath;
  const globalStateOutsideProject = realRoot !== null && !inside(realRoot, statePath);
  const sourceIdentity = realRoot !== null && orchestraSourceIdentity(realRoot);
  const thinShim = realRoot !== null && selfHostThinShim(realRoot, input.home);
  const legacyWorkspaceRef = `workspace:self-host:${projectRecord?.lineageId ?? ''}`;
  const workspaceBound = operation?.workspaceRef === realRoot
    || (operation?.workflowState === 'COMPLETED' && operation?.workspaceRef === legacyWorkspaceRef);
  const terminalMutation = operation?.projectId === input.projectId
    && operation?.kind === 'DIRECT_MUTATION'
    && Array.isArray(operation?.capabilities)
    && operation.capabilities.includes('WORKSPACE_EDIT')
    && operation?.liveness === 'TERMINAL'
    && ['COMPLETED', 'SUCCEEDED'].includes(operation?.workflowState)
    && typeof operation?.resultRef === 'string'
    && operation.resultRef.trim().length > 0
    && workspaceBound;
  const noLocalBrain = realRoot !== null
    && noFullLocalGovernanceRuntime(realRoot)
    && globalStateOutsideProject
    && thinShim;
  const ok = projectRecord !== null
    && projectMatchesRuntime(projectRecord, expectedRuntimeImageId)
    && sourceIdentity
    && terminalMutation
    && noLocalBrain
    && homeId !== null;
  return result({
    ok,
    expectedHeadSha,
    expectedRuntimeImageId,
    kind: 'self-host',
    facts: {
      projectId: projectRecord?.projectId ?? '',
      lineageId: projectRecord?.lineageId ?? '',
      runtimeImageId: projectRecord?.runtime?.pinnedImage ?? '',
      noFullLocalGovernanceRuntime: noLocalBrain,
      homeIdentity: homeId ?? '',
    },
    snapshot: {
      projectId: projectRecord?.projectId ?? null,
      lineageId: projectRecord?.lineageId ?? null,
      sourceIdentity,
      terminalMutation,
      globalStateOutsideProject,
      thinShim,
      homeIdentity: homeId,
    },
  });
}
