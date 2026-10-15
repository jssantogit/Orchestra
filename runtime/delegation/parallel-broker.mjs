import { createHash } from "node:crypto";

import { assertDelegationRequest } from "../../core/domain/delegation.mjs";
import { assertParallelImplementationGroup } from "../../core/domain/parallel-implementation.mjs";
import { buildWorkerEnvelope } from "../../core/delegation/worker-envelope.mjs";
import { assessParallelScopeIndependence } from "../../core/delegation/parallel-scope.mjs";
import { readWorkLease } from "../../core/leases/work-lease-store.mjs";
import { readDelegationGitBoundary } from "./git-boundary.mjs";
import {
  cleanupMutableDelegationWorkspace,
  inspectMutableDelegationWorkspace,
  prepareMutableDelegationWorkspace,
} from "./mutable-workspace.mjs";
import { readDelegationProductFingerprint } from "./source-snapshot.mjs";
import { sealDelegationArtifact } from "./artifact-lifecycle.mjs";
import {
  recordDelegationArtifactCleanup,
  transitionDelegationArtifactState,
} from "./artifact-store.mjs";
import {
  createParallelGroup,
  recordParallelGroupCleanup,
  transitionParallelGroupState,
} from "./parallel-group-store.mjs";

const PARALLEL_LIMITS = Object.freeze({
  timeoutMs: 120000,
  maxOutputBytes: 65536,
  delegationDepth: 1,
});

function digest(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function memberDelegationId(groupId, memberId) {
  return `parallel-${digest(`${groupId}:${memberId}`).slice(0, 40)}`;
}

function failureReason(error, fallback = "EXECUTION_FAILED") {
  const code = error?.code ?? error?.reason;
  return typeof code === "string" && code.length > 0 ? code : fallback;
}

function normalizeExecutors(executors) {
  if (!Array.isArray(executors) || executors.length < 2) {
    throw new TypeError("PARALLEL_IMPLEMENTATION_EXECUTORS_REQUIRED");
  }
  const map = new Map();
  for (const executor of executors) {
    if (!executor
        || typeof executor !== "object"
        || typeof executor.provider !== "string"
        || !executor.provider
        || typeof executor.discover !== "function"
        || typeof executor.execute !== "function"
        || map.has(executor.provider)) {
      throw new TypeError("PARALLEL_IMPLEMENTATION_EXECUTOR_INVALID");
    }
    map.set(executor.provider, executor);
  }
  return map;
}

function defaultServices() {
  return {
    readLease: readWorkLease,
    source: {
      readProduct: readDelegationProductFingerprint,
      readGitBoundary: readDelegationGitBoundary,
    },
    workspace: {
      prepare: prepareMutableDelegationWorkspace,
      inspect: inspectMutableDelegationWorkspace,
      cleanup: cleanupMutableDelegationWorkspace,
    },
    artifacts: {
      seal: sealDelegationArtifact,
      async discardBound({ repoRoot, artifactId }) {
        const transition = transitionDelegationArtifactState(repoRoot, artifactId, {
          expectedState: "READY_FOR_REVIEW",
          nextState: "DISCARDED",
        });
        return {
          discarded: transition.transitioned,
          reason: transition.reason,
        };
      },
      recordCleanup: recordDelegationArtifactCleanup,
    },
    groups: {
      create: createParallelGroup,
      transition: transitionParallelGroupState,
      cleanup: recordParallelGroupCleanup,
    },
  };
}

function mergeServices(overrides = {}) {
  const defaults = defaultServices();
  return {
    readLease: overrides.readLease ?? defaults.readLease,
    source: { ...defaults.source, ...(overrides.source ?? {}) },
    workspace: { ...defaults.workspace, ...(overrides.workspace ?? {}) },
    artifacts: { ...defaults.artifacts, ...(overrides.artifacts ?? {}) },
    groups: { ...defaults.groups, ...(overrides.groups ?? {}) },
  };
}

function validControlAuthority(group, actor, leaseResult) {
  if (!actor
      || actor.isRoot !== true
      || actor.provider !== group.source.provider
      || actor.actorIdHash !== group.source.actorIdHash) return false;
  if (!leaseResult?.exists || !leaseResult.valid || !leaseResult.lease) return false;
  const lease = leaseResult.lease;
  return lease.taskId === group.taskId
    && lease.generation === group.generation
    && lease.actor?.provider === group.source.provider
    && lease.actor?.sessionIdHash === group.source.actorIdHash
    && Array.isArray(lease.capabilities)
    && lease.capabilities.includes("CONTROL");
}

function buildMemberRequest(group, member) {
  const request = {
    schema: "orchestra.delegation-request.v2",
    delegationId: memberDelegationId(group.groupId, member.memberId),
    taskId: group.taskId,
    source: {
      provider: group.source.provider,
      actorIdHash: group.source.actorIdHash,
    },
    target: {
      provider: member.targetProvider,
      logicalRole: "IMPLEMENTER",
    },
    purpose: "IMPLEMENTATION",
    packet: member.packet,
    authority: {
      capabilities: ["LOCAL_READ", "PROCESS_EXEC", "WORKSPACE_EDIT"],
      mutation: "WORKSPACE_ONLY",
      network: "FORBIDDEN",
      mayDelegate: false,
    },
    workspace: {
      sourceFingerprint: group.sourceFingerprint,
      sourceRevision: group.sourceRevision,
      isolation: "EPHEMERAL_CLONE",
      mutationScope: member.mutationScope,
    },
    limits: { ...PARALLEL_LIMITS },
  };
  assertDelegationRequest(request);
  return request;
}

async function baselineDecision(repoRoot, group, source) {
  const product = source.readProduct(repoRoot);
  if (!product?.available
      || product.head !== group.sourceRevision
      || product.fingerprint !== group.sourceFingerprint) {
    return { allowed: false, reason: "WORKSPACE_PREP_FAILED" };
  }
  const gitBoundary = await source.readGitBoundary(repoRoot);
  if (!gitBoundary?.available || gitBoundary.fingerprint !== group.canonicalGitFingerprint) {
    return { allowed: false, reason: "WORKSPACE_PREP_FAILED" };
  }
  return { allowed: true, reason: null };
}

async function discoverMembers(group, executorMap) {
  const probes = await Promise.all(group.members.map(async (member) => {
    const executor = executorMap.get(member.targetProvider);
    if (!executor) return { member, executor: null, discovery: null };
    try {
      return { member, executor, discovery: await executor.discover() };
    } catch {
      return { member, executor, discovery: null };
    }
  }));
  for (const probe of probes) {
    if (!probe.executor
        || probe.discovery?.available !== true
        || probe.discovery.provider !== probe.member.targetProvider
        || probe.discovery.capabilities?.implementation !== true) {
      return { ok: false, reason: "PROVIDER_UNAVAILABLE", probes };
    }
  }
  return { ok: true, reason: null, probes };
}

function memberResult(member, request, workspace, execution, artifact = null) {
  return {
    memberId: member.memberId,
    provider: member.targetProvider,
    delegationId: request.delegationId,
    workspace,
    execution,
    artifactId: artifact?.artifactId ?? null,
    report: execution?.report ?? null,
  };
}

async function cleanupContexts(repoRoot, members, services, sealedByMember = new Map()) {
  const cleanupFailures = [];
  for (const entry of members) {
    const artifact = sealedByMember.get(entry.member.memberId) ?? null;
    if (artifact) {
      try {
        await services.artifacts.discardBound({
          repoRoot,
          artifactId: artifact.artifactId,
          workspace: entry.workspace,
        });
      } catch {}
    }

    let cleanup;
    try {
      cleanup = await services.workspace.cleanup(entry.workspace);
    } catch {
      cleanup = { cleaned: false, reason: "WORKSPACE_CLEANUP_FAILED" };
    }
    if (artifact && typeof services.artifacts.recordCleanup === "function") {
      try {
        services.artifacts.recordCleanup(repoRoot, artifact.artifactId, cleanup.cleaned
          ? { cleaned: true, reason: null, recoverablePath: null }
          : {
            cleaned: false,
            reason: "WORKSPACE_CLEANUP_FAILED",
            recoverablePath: entry.workspace.path,
          });
      } catch {}
    }
    if (cleanup.cleaned !== true) {
      cleanupFailures.push({
        memberId: entry.member.memberId,
        recoverablePath: entry.workspace.path,
      });
    }
  }
  return cleanupFailures;
}

function failWithoutState(reason) {
  return { status: "FAILED", reason, groupId: null, members: [] };
}

export async function executeParallelImplementationGroup({
  repoRoot,
  group,
  actor,
  executors,
} = {}, serviceOverrides = {}) {
  const services = mergeServices(serviceOverrides);
  try {
    assertParallelImplementationGroup(group);
  } catch {
    return failWithoutState("CAPABILITY_DENIED");
  }
  const resultBase = { groupId: group.groupId };

  let executorMap;
  try {
    executorMap = normalizeExecutors(executors);
  } catch {
    return { ...resultBase, status: "FAILED", reason: "PROVIDER_UNAVAILABLE", members: [] };
  }

  let lease;
  try {
    lease = services.readLease(repoRoot);
  } catch {
    lease = null;
  }
  if (!validControlAuthority(group, actor, lease)) {
    return { ...resultBase, status: "FAILED", reason: "CAPABILITY_DENIED", members: [] };
  }

  const scopes = assessParallelScopeIndependence(
    group.members[0].mutationScope,
    group.members[1].mutationScope,
  );
  if (!scopes.independent) {
    return { ...resultBase, status: "FAILED", reason: "SCOPE_VIOLATION", members: [] };
  }

  if (!(await baselineDecision(repoRoot, group, services.source)).allowed) {
    return { ...resultBase, status: "FAILED", reason: "WORKSPACE_PREP_FAILED", members: [] };
  }

  const discovery = await discoverMembers(group, executorMap);
  if (!discovery.ok) {
    return { ...resultBase, status: "FAILED", reason: discovery.reason, members: [] };
  }

  try {
    services.groups.create(repoRoot, group);
    const running = services.groups.transition(repoRoot, group.groupId, {
      expectedState: "CREATED",
      nextState: "RUNNING",
    });
    if (!running?.transitioned) {
      return { ...resultBase, status: "FAILED", reason: "PARALLEL_GROUP_STATE_INVALID", members: [] };
    }
  } catch {
    return { ...resultBase, status: "FAILED", reason: "PARALLEL_GROUP_STATE_INVALID", members: [] };
  }

  const planned = discovery.probes.map(({ member, executor }) => ({
    member,
    executor,
    request: buildMemberRequest(group, member),
  }));

  const preparedSettled = await Promise.allSettled(planned.map(async (entry) => ({
    ...entry,
    workspace: await services.workspace.prepare({ repoRoot, request: entry.request }),
  })));
  const prepared = preparedSettled
    .filter((entry) => entry.status === "fulfilled")
    .map((entry) => entry.value);
  const prepFailure = preparedSettled.find((entry) => entry.status === "rejected");
  if (prepFailure) {
    const cleanupFailures = await cleanupContexts(repoRoot, prepared, services);
    services.groups.transition(repoRoot, group.groupId, {
      expectedState: "RUNNING",
      nextState: "FAILED",
      memberArtifactIds: [],
      failureReason: failureReason(prepFailure.reason, "WORKSPACE_PREP_FAILED"),
    });
    if (cleanupFailures.length > 0) services.groups.cleanup(repoRoot, group.groupId, cleanupFailures);
    return {
      ...resultBase,
      status: "FAILED",
      reason: failureReason(prepFailure.reason, "WORKSPACE_PREP_FAILED"),
      members: [],
    };
  }

  const baselineAfterPrep = await baselineDecision(repoRoot, group, services.source);
  if (!baselineAfterPrep.allowed) {
    const cleanupFailures = await cleanupContexts(repoRoot, prepared, services);
    services.groups.transition(repoRoot, group.groupId, {
      expectedState: "RUNNING",
      nextState: "FAILED",
      memberArtifactIds: [],
      failureReason: baselineAfterPrep.reason,
    });
    if (cleanupFailures.length > 0) services.groups.cleanup(repoRoot, group.groupId, cleanupFailures);
    return { ...resultBase, status: "FAILED", reason: baselineAfterPrep.reason, members: [] };
  }

  const executionPromises = prepared.map((entry) => Promise.resolve().then(() => entry.executor.execute({
    request: entry.request,
    workerEnvelope: buildWorkerEnvelope(entry.request),
    workspace: entry.workspace,
  })));
  const executions = await Promise.all(executionPromises.map(async (promise) => {
    try { return await promise; } catch (error) { return { ok: false, reason: failureReason(error) }; }
  }));

  const inspected = await Promise.all(prepared.map(async (entry) => {
    try { return await services.workspace.inspect(entry.workspace); } catch { return null; }
  }));
  const boundaryViolation = inspected.some((value) => !value
    || value.canonicalWorkspaceChanged
    || value.canonicalGitChanged
    || value.cloneGitChanged
    || value.stagedByWorker);
  if (boundaryViolation) {
    const cleanupFailures = await cleanupContexts(repoRoot, prepared, services);
    services.groups.transition(repoRoot, group.groupId, {
      expectedState: "RUNNING",
      nextState: "FAILED",
      memberArtifactIds: [],
      failureReason: "SCOPE_VIOLATION",
    });
    if (cleanupFailures.length > 0) services.groups.cleanup(repoRoot, group.groupId, cleanupFailures);
    return { ...resultBase, status: "FAILED", reason: "SCOPE_VIOLATION", members: [] };
  }

  const executionFailureIndex = executions.findIndex((execution, index) => execution?.ok !== true
    || execution?.provider !== prepared[index].member.targetProvider
    || !execution.report
    || typeof execution.report !== "object");
  if (executionFailureIndex !== -1) {
    const reason = executions[executionFailureIndex]?.reason ?? "INVALID_RESULT";
    const cleanupFailures = await cleanupContexts(repoRoot, prepared, services);
    services.groups.transition(repoRoot, group.groupId, {
      expectedState: "RUNNING",
      nextState: "FAILED",
      memberArtifactIds: [],
      failureReason: reason,
    });
    if (cleanupFailures.length > 0) services.groups.cleanup(repoRoot, group.groupId, cleanupFailures);
    return { ...resultBase, status: "FAILED", reason, members: [] };
  }

  const sealedSettled = await Promise.allSettled(prepared.map((entry, index) => services.artifacts.seal({
    repoRoot,
    request: entry.request,
    generation: group.generation,
    actor,
    workspace: entry.workspace,
    report: executions[index].report,
    parallelBinding: {
      groupId: group.groupId,
      memberId: entry.member.memberId,
    },
  })));
  const sealedByMember = new Map();
  for (let index = 0; index < sealedSettled.length; index += 1) {
    const sealed = sealedSettled[index];
    if (sealed.status === "fulfilled") {
      sealedByMember.set(prepared[index].member.memberId, sealed.value);
    }
  }
  const sealFailure = sealedSettled.find((entry) => entry.status === "rejected");
  if (sealFailure) {
    const artifactIds = [...sealedByMember.values()].map((artifact) => artifact.artifactId).sort();
    const cleanupFailures = await cleanupContexts(repoRoot, prepared, services, sealedByMember);
    const reason = failureReason(sealFailure.reason, "ARTIFACT_SEAL_FAILED");
    services.groups.transition(repoRoot, group.groupId, {
      expectedState: "RUNNING",
      nextState: "FAILED",
      memberArtifactIds: artifactIds,
      failureReason: reason,
    });
    if (cleanupFailures.length > 0) services.groups.cleanup(repoRoot, group.groupId, cleanupFailures);
    return { ...resultBase, status: "FAILED", reason, members: [] };
  }

  const members = prepared.map((entry, index) => memberResult(
    entry.member,
    entry.request,
    entry.workspace,
    executions[index],
    sealedByMember.get(entry.member.memberId),
  ));
  const memberArtifactIds = members.map((member) => member.artifactId);
  const ready = services.groups.transition(repoRoot, group.groupId, {
    expectedState: "RUNNING",
    nextState: "MEMBERS_READY",
    memberArtifactIds,
  });
  if (!ready?.transitioned) {
    const cleanupFailures = await cleanupContexts(repoRoot, prepared, services, sealedByMember);
    return {
      ...resultBase,
      status: "FAILED",
      reason: "PARALLEL_GROUP_STATE_INVALID",
      members: [],
      ...(cleanupFailures.length > 0 ? { cleanupFailures } : {}),
    };
  }

  return {
    ...resultBase,
    status: "MEMBERS_READY",
    reason: null,
    members,
  };
}

export { composeParallelArtifacts } from "./composite-artifact-lifecycle.mjs";
