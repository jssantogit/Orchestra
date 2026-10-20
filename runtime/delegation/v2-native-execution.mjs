import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { authorizeDelegationRequest } from "../../core/delegation/policy.mjs";
import { buildWorkerEnvelope } from "../../core/delegation/worker-envelope.mjs";
import { assertDelegationRequest } from "../../core/domain/delegation.mjs";
import { deriveMutationFacts } from "./artifact-lifecycle.mjs";
import {
  prepareMutableDelegationWorkspace,
  inspectMutableDelegationWorkspace,
  cleanupMutableDelegationWorkspace,
} from "./mutable-workspace.mjs";
import { readDelegationProductFingerprint } from "./source-snapshot.mjs";
import { readDelegationGitStdout } from "./git-boundary.mjs";
import { createAntigravityDelegationExecutor } from "../../providers/antigravity/delegation-executor.mjs";
import { createCodexDelegationExecutor } from "../../providers/codex/delegation-executor.mjs";
import { authorizeCapability, authorizeAttach } from "../../v2/authority/authority.mjs";
import { createRuntimeOwnerStore } from "../../v2/liveness/runtime-owner-store.mjs";
import { createHostProcessIdentityReader } from "../../v2/liveness/local-process-probe.mjs";
import { createManagedWorkspaceStore, resolveManagedWorkspacePaths } from "../../v2/workspaces/managed-workspace-store.mjs";

const HASH = /^sha256:[0-9a-f]{64}$/;
const PROVIDERS = new Set(["codex", "antigravity"]);
const MAX_FILES = 128;
const MAX_ARTIFACT_BYTES = 8 * 1024 * 1024;
const MAX_FILE_BYTES = 2 * 1024 * 1024;

// A delegation identity is unique within one immutable Work generation.
// Retries must never create another Operation for the same dispatched member,
// even if the request body changes or the previous worker failed/crashed.
function operationIdForDelegation(projectId, workId, generation, delegationId) {
  const hash = createHash("sha256")
    .update("orchestra.v2.delegated-operation.v1\0")
    .update(JSON.stringify([projectId, workId, generation, delegationId]))
    .digest("hex");
  return "op_delegated_" + hash;
}

function fail(code) {
  return { ok: false, code };
}
function digest(bytes) {
  return "sha256:" + createHash("sha256").update(bytes).digest("hex");
}
function validReport(result, target) {
  const report = result?.report;
  return result?.ok === true && result.provider === target
    && result.execution?.exitCode === 0
    && report && typeof report.summary === "string"
    && report.summary.length > 0 && report.summary.length <= 8192
    && Array.isArray(report.findings) && report.findings.length <= 64
    && report.findings.every((x) => typeof x === "string" && x.length > 0 && x.length <= 4096)
    && Array.isArray(report.evidenceRefs) && report.evidenceRefs.length <= 64
    && new Set(report.evidenceRefs).size === report.evidenceRefs.length
    && report.evidenceRefs.every((x) => typeof x === "string" && x.length > 0 && x.length <= 512);
}
// A real birth identity is required. A PID alone can be reused after a
// crash and must not be promoted to operation-liveness proof.
async function registerDelegationProcessOwner(home, operationId, registeredAt) {
  let identity;
  try { identity = await createHostProcessIdentityReader()(process.pid); }
  catch { return null; }
  if (identity?.status !== "PRESENT" || !identity.processIdentity) return null;
  const ownerId = "owner_delegated_" + randomUUID();
  const record = {
    schema: "orchestra.runtime-owner.v2",
    runtimeOwnerId: ownerId, operationId, kind: "LOCAL_PROCESS",
    registeredAt,
    process: { pid: process.pid, startIdentity: identity.processIdentity },
    proof: { tokenHash: digest(randomBytes(32)) },
  };
  const store = createRuntimeOwnerStore({ rootDir: join(home, "runtime-owners") });
  try {
    const saved = await store.register(record);
    return saved?.ok ? ownerId : null;
  } catch { return null; }
}

// A worker is a distinct process from the controlling session. Observing
// only the controller's PID cannot establish the child's post-crash liveness.
async function registerDelegationChildOwner(home, operationId, pid) {
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false;
  let identity;
  try { identity = await createHostProcessIdentityReader()(pid); }
  catch { return false; }
  if (identity?.status !== "PRESENT" || !identity.processIdentity) return false;
  const owner = {
    schema: "orchestra.runtime-owner.v2",
    runtimeOwnerId: "owner_delegated_child_" + operationId,
    operationId, kind: "LOCAL_PROCESS",
    registeredAt: new Date().toISOString(),
    process: { pid, startIdentity: identity.processIdentity },
    proof: { tokenHash: digest(randomBytes(32)) },
  };
  try {
    const result = await createRuntimeOwnerStore({
      rootDir: join(home, "runtime-owners"),
    }).register(owner);
    return result?.ok === true && result.replayed !== true;
  } catch { return false; }
}

function providerExecutor(target) {
  if (target === "antigravity") return createAntigravityDelegationExecutor();
  if (target === "codex") return createCodexDelegationExecutor();
  return null;
}
function nativeFacts(state, projectId, workId, generation, actor, request) {
  if (!PROVIDERS.has(actor?.provider) || !HASH.test(actor?.actorIdHash ?? "")
    || !request || request.schema !== "orchestra.delegation-request.v2"
    || !PROVIDERS.has(request.target?.provider)
    || request.source?.provider !== actor.provider
    || request.source?.actorIdHash !== actor.actorIdHash
    || request.target.provider === actor.provider) return fail("NATIVE_DELEGATION_IDENTITY_DENIED");

  const project = state.projects.inspect(projectId);
  const work = state.work.current(projectId);
  const session = state.sessionObservations.get({
    provider: actor.provider, projectId, actorIdHash: actor.actorIdHash,
  });
  if (!project || !work || work.workId !== workId || work.generation !== generation
    || work.runtimeImage !== project.runtime.pinnedImage
    || work.instructionEpoch !== project.runtime.instructionEpoch
    || request.taskId !== work.taskId
    || request.packet?.candidateGeneration !== generation
    || project.workspace?.vcs !== "git"
    || !session || session.observedWorkId !== workId
    || session.observedGeneration !== generation
    || session.observedInstructionEpoch !== project.runtime.instructionEpoch) {
    return fail("NATIVE_DELEGATION_WORK_AUTHORITY_DENIED");
  }
  const actorProvenance = {
    schema: "orchestra.actor-provenance.v2",
    provider: actor.provider, subjectHash: actor.actorIdHash,
    source: "PROVIDER_FACT", observedAt: session.observedAt,
  };
  const mutations = state.operations.listLive({ projectId, workId, generation });
  const attached = authorizeAttach({
    project, work, actor: actorProvenance,
    observedInstructionEpoch: session.observedInstructionEpoch,
    liveOperations: mutations,
  });
  if (!attached.allowed) return fail(attached.reason ?? "NATIVE_DELEGATION_ATTACH_DENIED");
  const authorized = authorizeCapability({
    project, work, actor: actorProvenance,
    capability: "WORKSPACE_EDIT", workspaceRef: project.workspace.canonicalRoot,
    expectedGeneration: generation, liveOperations: mutations,
  });
  if (!authorized.allowed) return fail(authorized.reason ?? "NATIVE_DELEGATION_MUTATION_DENIED");
  return { ok: true, project, work, session };
}

async function sealedBytes(workspace, mutation, binding) {
  if (mutation.changedPaths.length === 0 || mutation.changedPaths.length > MAX_FILES) {
    throw new Error("NATIVE_DELEGATION_MUTATION_INVALID");
  }
  const files = [];
  for (const fact of mutation.facts) {
    if (!["FILE", "DELETED"].includes(fact.kind)) {
      throw new Error("NATIVE_DELEGATION_UNSUPPORTED_MUTATION");
    }
    let encoded = null;
    if (fact.kind === "FILE") {
      const bytes = await readFile(join(workspace.path, fact.path));
      if (bytes.length > MAX_FILE_BYTES || digest(bytes) !== fact.contentHash) {
        throw new Error("NATIVE_DELEGATION_MUTATION_CHANGED");
      }
      encoded = bytes.toString("base64");
    }
    files.push({ ...fact, bytesBase64: encoded });
  }
  const body = {
    schema: "orchestra.v2-delegation-candidate.v1",
    version: 1, ...binding,
    sourceRevision: workspace.sourceRevision,
    sourceFingerprint: workspace.sourceFingerprint,
    mutationDigest: mutation.mutationDigest,
    files,
  };
  const bytes = Buffer.from(JSON.stringify(body), "utf8");
  if (bytes.length > MAX_ARTIFACT_BYTES) throw new Error("NATIVE_DELEGATION_ARTIFACT_TOO_LARGE");
  return bytes;
}

// Trusted V2 control-plane entrypoint. No CLI and no call to the V1 broker,
// Work Lease store or legacy artifact promotion. The caller must supply a
// provider-authenticated principal already observed in Home. A successful
// worker produces only a Home-owned sealed candidate, never a canonical edit.
export async function executeNativeDelegatedWork({
  registry, projectId, workId, generation, actor, request,
  executor = null, managedWorkspaceStore = null,
  now = () => new Date().toISOString(),
} = {}) {
  const state = registry?.state;
  if (!state?.projects?.inspect || !state?.work?.current
    || !state?.operations?.begin || !state?.operations?.inspect
    || !state?.operations?.heartbeat || !state?.operations?.terminalize
    || !state?.sessionObservations?.get || !registry?.blobs?.putBytes
    || typeof registry.paths?.home !== "string") {
    return fail("NATIVE_DELEGATION_HOME_REQUIRED");
  }
  try { assertDelegationRequest(request); }
  catch { return fail("NATIVE_DELEGATION_REQUEST_INVALID"); }

  let facts = nativeFacts(state, projectId, workId, generation, actor, request);
  if (!facts.ok) return facts;
  let source;
  try { source = readDelegationProductFingerprint(facts.project.workspace.canonicalRoot); }
  catch { return fail("NATIVE_DELEGATION_SOURCE_UNAVAILABLE"); }
  const authorization = authorizeDelegationRequest(request, {
    sourceProvider: actor.provider, sourceFingerprint: source.fingerprint,
  });
  if (!authorization.allowed || source.head !== request.workspace.sourceRevision) {
    return fail("NATIVE_DELEGATION_REQUEST_DENIED");
  }
  const stableOperationId = operationIdForDelegation(projectId, workId, generation, request.delegationId);
  // Read before clone preparation/discovery; the SQLite begin below is the
  // authoritative collision fence when two callers race this precheck.
  if (state.operations.inspect(stableOperationId)) {
    return fail("NATIVE_DELEGATION_ALREADY_RECORDED");
  }
  const worker = executor ?? providerExecutor(request.target.provider);
  if (!worker || worker.provider !== request.target.provider
    || typeof worker.discover !== "function" || typeof worker.execute !== "function") {
    return fail("NATIVE_DELEGATION_EXECUTOR_INVALID");
  }
  let discovered;
  try { discovered = await worker.discover(); }
  catch { return fail("NATIVE_DELEGATION_EXECUTOR_UNAVAILABLE"); }
  if (discovered?.available !== true || discovered.provider !== request.target.provider
    || discovered.capabilities?.implementation !== true) {
    return fail("NATIVE_DELEGATION_EXECUTOR_UNAVAILABLE");
  }

  const workspaceStore = managedWorkspaceStore ?? createManagedWorkspaceStore({
    home: registry.paths.home,
  });
  let workspace = null;
  let operation = null;
  let heartbeatTimer = null;
  let lastHeartbeatAt = null;
  let heartbeatFailed = false;
  let result = fail("NATIVE_DELEGATION_EXECUTION_FAILED");
  let succeeded = false;
  try {
    workspace = await prepareMutableDelegationWorkspace({
      repoRoot: facts.project.workspace.canonicalRoot, request,
      baseDir: resolveManagedWorkspacePaths({ home: registry.paths.home }).instancesRoot,
    });
    facts = nativeFacts(state, projectId, workId, generation, actor, request);
    if (!facts.ok) {
      result = facts;
    } else {
      const operationId = stableOperationId;
      const startedAt = now();
      const deadlineAt = new Date(Date.parse(startedAt) + request.limits.timeoutMs + 30_000).toISOString();
      const runtimeOwnerRef = await registerDelegationProcessOwner(
        registry.paths.home, operationId, startedAt,
      );
      const begun = runtimeOwnerRef === null
        ? { ok: false, reason: "NATIVE_DELEGATION_OWNER_UNVERIFIED" }
        : state.operations.begin({
        expectedGeneration: generation,
        operation: {
          schema: "orchestra.operation.v2", operationId, projectId, workId, generation,
          kind: "DELEGATED_MUTATION", actorRef: actor.actorIdHash,
          capabilities: ["WORKSPACE_EDIT"], workflowState: "RUNNING",
          liveness: "LIVE", startedAt, heartbeatAt: startedAt, deadlineAt,
          runtimeOwnerRef, workspaceRef: facts.project.workspace.canonicalRoot,
          resultRef: null,
        },
      });
      if (!begun.ok) {
        result = fail(begun.reason === "OPERATION_ID_CONFLICT"
          ? "NATIVE_DELEGATION_ALREADY_RECORDED"
          : (begun.reason ?? "NATIVE_DELEGATION_OPERATION_DENIED"));
      } else if (begun.replayed) {
        // A replayed begin owns neither the previous worker nor its terminal;
        // never execute or terminalize another caller's Operation.
        result = fail("NATIVE_DELEGATION_ALREADY_RECORDED");
      } else {
        operation = begun.operation;
        lastHeartbeatAt = operation.heartbeatAt;
        heartbeatTimer = setInterval(() => {
          // Heartbeats are authoritative only for this exact registered owner.
          // If the lease is lost, terminal success must fail closed.
          try {
            const touched = state.operations.heartbeat({
              operationId, runtimeOwnerRef, heartbeatAt: new Date().toISOString(),
            });
            if (touched?.ok) lastHeartbeatAt = touched.operation.heartbeatAt;
            else heartbeatFailed = true;
          } catch { heartbeatFailed = true; }
        }, 10_000);
        heartbeatTimer.unref?.();
        // Bind the scratch clone to this exact Operation before any provider
        // worker executes. The immutable Home record survives sandbox cleanup
        // and is auditable after a controller crash. Never reuse an old
        // association or infer safety from the Project root.
        const workspaceRef = "workspace:delegated:" + operationId;
        const association = {
          schema: "orchestra.managed-workspace.v2", workspaceRef,
          operationId, projectId, workId, generation,
          kind: "TRANSIENT_GIT_CLONE",
          root: dirname(workspace.path), registeredAt: startedAt,
        };
        let workspaceBound = false;
        try {
          const registered = await workspaceStore.register(association);
          const observed = registered?.ok && !registered.replayed
            ? await workspaceStore.read(workspaceRef) : null;
          workspaceBound = observed !== null
            && JSON.stringify(observed) === JSON.stringify(association);
        } catch {
          workspaceBound = false;
        }
        const rechecked = nativeFacts(state, projectId, workId, generation, actor, request);
        // The newly opened writer itself is the one expected LIVE mutation.
        const live = state.operations.listLive({ projectId, workId, generation });
        // The only acceptable new denial is our own operation's writer fence.
        // A revoked session, changed Work/epoch or another live writer may not
        // be interpreted as approval to start the external worker.
        if (!workspaceBound) {
          result = fail("NATIVE_DELEGATION_WORKSPACE_UNVERIFIED");
        } else if (rechecked.ok || rechecked.code !== "INCOMPATIBLE_LIVE_OPERATION"
          || live.length !== 1 || live[0].operationId !== operationId
          || live[0].kind !== "DELEGATED_MUTATION"
          || state.work.current(projectId)?.workId !== workId
          || state.projects.inspect(projectId)?.runtime?.pinnedImage !== facts.project.runtime.pinnedImage) {
          result = fail("NATIVE_DELEGATION_OPERATION_STALE");
        } else {
          const selection = state.nativeRsi?.recordDelegatedDecision?.({
            operationId, sourceProvider: actor.provider,
            targetProvider: request.target.provider,
            providerVersion: discovered.version,
          });
          if (!selection?.ok) {
            result = fail("NATIVE_DELEGATION_DECISION_UNVERIFIED");
          } else {
          let execution = null;
          let childOwnerRecorded = false;
          const onProcessSpawn = async ({ pid } = {}) => {
            if (childOwnerRecorded || !(await registerDelegationChildOwner(
              registry.paths.home, operationId, pid,
            ))) {
              throw new Error("NATIVE_DELEGATION_CHILD_UNVERIFIED");
            }
            childOwnerRecorded = true;
          };
          try {
            execution = await worker.execute({
              request, workerEnvelope: buildWorkerEnvelope(request),
              workspace, onProcessSpawn,
            });
          } catch { execution = null; }
          // Controlled test executors may not spawn a real process. The real
          // provider adapters MUST attest a child to count as native success.
          if (executor === null && !childOwnerRecorded) {
            result = fail("NATIVE_DELEGATION_CHILD_UNVERIFIED");
          } else if (!validReport(execution, request.target.provider)) {
            result = fail("NATIVE_DELEGATION_WORKER_FAILED");
          } else {
            const inspection = await inspectMutableDelegationWorkspace(workspace);
            // The legacy changed-path scanner intentionally honors .gitignore.
            // V2 must additionally catch ignored outputs, including concealed
            // .orchestra/state files, before issuing any successful artifact.
            const ignoredPaths = await readDelegationGitStdout(workspace.path, [
              "ls-files", "--others", "--ignored", "--exclude-standard", "-z",
            ]);
            if (ignoredPaths.length > 0 || inspection.canonicalWorkspaceChanged
              || inspection.canonicalGitChanged || inspection.cloneGitChanged
              || inspection.stagedByWorker) {
              result = fail("NATIVE_DELEGATION_BOUNDARY_VIOLATION");
            } else {
              const mutation = await deriveMutationFacts({
                workspacePath: workspace.path,
                baselineSha: workspace.syntheticBaselineSha,
                scope: request.workspace.mutationScope,
              });
              const data = await sealedBytes(workspace, mutation, {
                projectId, workId, generation, operationId,
                runtimeImageId: facts.project.runtime.pinnedImage,
                delegationId: request.delegationId,
                targetProvider: request.target.provider,
              });
              const blob = await registry.blobs.putBytes(data);
              if (!(await registry.blobs.verify(blob.digest)).valid) {
                result = fail("NATIVE_DELEGATION_ARTIFACT_INVALID");
              } else {
                succeeded = true;
                result = { ok: true, route: "DELEGATED", state: "SUCCEEDED",
                  operationId, artifactRef: blob.digest,
                  changedPaths: mutation.changedPaths };
              }
            }
          }
          }
        }
      }
    }
  } catch (error) {
    result = fail(error?.code === "SCOPE_VIOLATION"
      ? "NATIVE_DELEGATION_SCOPE_VIOLATION" : "NATIVE_DELEGATION_EXECUTION_FAILED");
  } finally {
    if (workspace) {
      let cleanup;
      try { cleanup = await cleanupMutableDelegationWorkspace(workspace); }
      catch { cleanup = null; }
      if (cleanup?.cleaned !== true) {
        succeeded = false;
        result = fail("NATIVE_DELEGATION_CLEANUP_UNCERTAIN");
      }
    }
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (heartbeatFailed) {
      succeeded = false;
      result = fail("NATIVE_DELEGATION_OWNER_UNVERIFIED");
    }
    if (operation) {
      const terminal = state.operations.terminalize({
        operationId: operation.operationId,
        workflowState: succeeded ? "SUCCEEDED" : "UNKNOWN",
        resultRef: succeeded
          ? "delegation-artifact:" + result.artifactRef
          : "native-delegation-uncertain:" + digest(Buffer.from(operation.operationId)),
        expectedHeartbeatAt: lastHeartbeatAt ?? operation.heartbeatAt,
      });
      if (!terminal.ok) {
        result = fail("NATIVE_DELEGATION_TERMINAL_UNVERIFIED");
      } else if (succeeded) {
        // Only an already-terminal, blob-verified global Operation can
        // become factual RSI telemetry. A missing journal fails closed.
        let receipt = null;
        try {
          receipt = state.nativeRsi?.recordDelegatedTerminal?.({
            operationId: operation.operationId,
          });
        } catch {
          // A broken evidence journal cannot promote or certify a result.
        }
        if (!receipt?.ok) result = fail("NATIVE_DELEGATION_TERMINAL_RECEIPT_UNVERIFIED");
      }
    }
  }
  return result;
}
