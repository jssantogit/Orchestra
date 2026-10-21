import { createHash } from 'node:crypto';
import { assertDelegationRequest } from '../../core/domain/delegation.mjs';
import { authorizeDelegationRequest } from '../../core/delegation/policy.mjs';
import { authorizeChangedPaths, normalizeMutationScope } from '../../core/delegation/mutation-scope.mjs';
import { createCodexDelegationExecutor } from '../../providers/codex/delegation-executor.mjs';
import { createAntigravityDelegationExecutor } from '../../providers/antigravity/delegation-executor.mjs';
import { createCodexHookHandler } from '../../v2/providers/codex/hook-handler.mjs';
import { createAntigravityHookHandler } from '../../v2/providers/antigravity/hook-handler.mjs';
import { normalizeCodexActor } from '../../v2/providers/codex/actor.mjs';
import { normalizeAntigravityActor } from '../../v2/providers/antigravity/actor.mjs';
import { selectNativeExecution } from '../../v2/rsi/execution-selection.mjs';
import { createLearnedPolicyStore } from '../../v2/rsi/policy-store.mjs';
import { withResourceAdmission } from '../resources/governor.mjs';
import { readDelegationProductFingerprint } from './source-snapshot.mjs';
import { executeNativeDelegatedWork, operationIdForDelegation } from './v2-native-execution.mjs';

const fail = code => ({ ok: false, code });
const digest = value => 'sha256:' + createHash('sha256').update(JSON.stringify(value)).digest('hex');

// Native Work ingress, not the V1 broker. A direct result is a PreToolUse
// authorization: the provider performs its original tool and PostToolUse
// records the terminal. Delegated results are sealed candidates, never edits
// promoted to the canonical checkout. JSON callers cannot select a route,
// supply a policy, executor or authentication boolean.
export async function executeNativeWork(input, { registry, resourceGovernor,
  executor = null, policyStore = null } = {}) {
  if (!input || Object.keys(input).some(k => !['provider', 'payload', 'request', 'projectId', 'workId', 'generation', 'runtimeImageId', 'instructionEpoch'].includes(k))
    || input.payload?.hook_event_name !== 'PreToolUse') return fail('NATIVE_EXECUTION_REQUEST_INVALID');
  const { payload, request = null, projectId, workId, generation, runtimeImageId, instructionEpoch } = input;
  let actor;
  const provider = input.provider ?? 'codex';
  if (!['codex','antigravity'].includes(provider)) return fail('NATIVE_EXECUTION_ACTOR_INVALID');
  const normalizeActor = provider === 'codex' ? normalizeCodexActor : normalizeAntigravityActor;
  const createHandler = provider === 'codex' ? createCodexHookHandler : createAntigravityHookHandler;
  try { actor = normalizeActor(payload); } catch { return fail('NATIVE_EXECUTION_ACTOR_INVALID'); }
  const state = registry.state, project = state.projects.inspect(projectId);
  if (!project || (await registry.resolveWorkspace(payload.cwd))?.projectId !== projectId) return fail('NATIVE_EXECUTION_PROJECT_MISMATCH');
  const initial = selectNativeExecution({ state, projectId, workId, generation, runtimeImageId, instructionEpoch,
    actor, operationId: 'not-dispatched' });
  if (!initial.ok) return initial;
  // A no-packet native tool remains on the ordinary cheap hook path. No
  // discovery, auth probe, clone, admission or worker is started here.
  if (request === null) return createHandler({ registry }).handle(payload, { cwd: payload.cwd });
  try { assertDelegationRequest(request); } catch { return fail('NATIVE_EXECUTION_PACKET_INVALID'); }
  // Both alternatives must implement the same bounded mutation request. An
  // opaque shell command cannot acquire a two-route learning receipt.
  const patch = typeof payload.tool_input === 'string' ? payload.tool_input : payload.tool_input?.patch;
  const paths = typeof patch === 'string' ? [...patch.matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm)].map(x => x[1]) : [];
  if (payload.tool_name !== 'apply_patch' || paths.length === 0
    || !authorizeChangedPaths(paths, normalizeMutationScope(request.workspace.mutationScope)).allowed) return fail('NATIVE_EXECUTION_TOOL_SCOPE_DENIED');
  const operationId = operationIdForDelegation(projectId, workId, generation, request.delegationId);
  if (state.operations.inspect(operationId) || state.nativeRsi.inspectExecutionSelection(operationId)) return fail('NATIVE_DELEGATION_ALREADY_RECORDED');
  const source = readDelegationProductFingerprint(project.workspace.canonicalRoot);
  if (!authorizeDelegationRequest(request, { sourceProvider: actor.provider, sourceFingerprint: source.fingerprint }).allowed
    || source.head !== request.workspace.sourceRevision || request.source.actorIdHash !== actor.actorIdHash
    || request.taskId !== state.work.current(projectId)?.taskId || request.packet.candidateGeneration !== generation) return fail('NATIVE_EXECUTION_PACKET_DENIED');
  const worker = executor ?? (request.target.provider === 'codex' ? createCodexDelegationExecutor() : createAntigravityDelegationExecutor());
  const admitted = await withResourceAdmission({ governor: resourceGovernor, home: registry.paths.home, projectRef: projectId, operationRef: operationId }, async () => {
    // Discovery/authentication children are bounded by the process runner.
    // A semantic refusal before dispatch is not an uncertain worker outcome.
    // The governor still retains any uncertainty recorded by the runner itself.
    const beforeDispatch = result => ({ ok: true, preDispatchResult: result });
    let readiness = null;
    try {
      const discovered = await worker.discover();
      if (discovered.available && discovered.provider === request.target.provider && discovered.capabilities?.implementation) {
        const auth = await worker.verifyAuthentication?.({ cwd: project.workspace.canonicalRoot });
        if (auth?.authenticated === true && /^sha256:[a-f0-9]{64}$/.test(auth.evidenceRef ?? '')) readiness = { ...discovered, authenticated: true, evidenceRef: auth.evidenceRef };
      }
    } catch { /* Missing authentication is no route authority. */ }
    if (readiness) {
      const auth = await worker.verifyAuthentication?.({ cwd: project.workspace.canonicalRoot });
      if (!auth?.authenticated) return beforeDispatch(fail('NATIVE_EXECUTION_READINESS_CHANGED'));
      if (executor === null) {
        if (auth.evidence?.provider !== readiness.provider || auth.evidence?.authenticated !== true
          || digest(auth.evidence) !== auth.evidenceRef) return beforeDispatch(fail('NATIVE_EXECUTION_AUTH_RECEIPT_UNVERIFIED'));
        const blob = await registry.blobs.putBytes(Buffer.from(JSON.stringify(auth.evidence)));
        if (blob.digest !== auth.evidenceRef || !(await registry.blobs.verify(blob.digest)).valid) return beforeDispatch(fail('NATIVE_EXECUTION_AUTH_RECEIPT_UNVERIFIED'));
        readiness.evidenceRef = blob.digest;
      }
      const current = await worker.discover();
      if (current.available !== true || current.provider !== readiness.provider
        || current.version !== readiness.version || current.capabilities?.implementation !== true) return beforeDispatch(fail('NATIVE_EXECUTION_READINESS_CHANGED'));
    }
    const currentSource = readDelegationProductFingerprint(project.workspace.canonicalRoot);
    if (source.head !== currentSource.head || source.fingerprint !== currentSource.fingerprint) return beforeDispatch(fail('NATIVE_EXECUTION_SOURCE_CHANGED'));
    const selected = selectNativeExecution({ state, projectId, workId, generation, runtimeImageId, instructionEpoch,
      actor, operationId, requestRef: digest(request), readiness,
      evidenceClass: executor === null ? 'NATIVE' : 'CONTROLLED_TEST',
      policyStore: policyStore ?? createLearnedPolicyStore({ persistence: state.learnedPolicies }) });
    if (!selected.ok) return beforeDispatch(selected);
    const recorded = state.nativeRsi.recordExecutionSelection(selected.permit);
    if (!recorded.ok) return beforeDispatch(recorded);
    if (selected.route === 'DIRECT_WORK') {
      // The direct native handler rechecks authority and takes the exact same
      // SQLite writer fence before allowing the original provider tool.
      const result = await createHandler({ registry, executionSelection: selected.permit }).handle(payload, { cwd: payload.cwd });
      return beforeDispatch({ ...result, route: 'DIRECT_WORK', selectionRef: recorded.selectionRef });
    }
    const result = await executeNativeDelegatedWork({ registry, projectId, workId, generation, actor, request,
      executor: worker, resourceGovernor, executionSelection: selected.permit });
    return { ...result, selectionRef: recorded.selectionRef,
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny',
        permissionDecisionReason: 'Original mutation replaced by global delegated execution; do not redispatch.' } };
  });
  return admitted.preDispatchResult ?? admitted;
}
