# Orchestra Cross-Provider Delegation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add provider-neutral cross-provider delegation so a Codex CONTROL actor can use AGY, and an AGY CONTROL actor can use Codex, as isolated read/process-exec workers while preserving Work Lease authority, evidence ownership, runtime firewalls, and current turn-economy defaults.

**Architecture:** Introduce first-class delegation contracts and routing policy in provider-neutral Core; run external workers through a project-wide neutral broker under `runtime/delegation/**`; isolate every execution in an external ephemeral Git worktree; keep Codex/Antigravity CLI mechanics in their own provider executors; distribute the broker through an independent `delegation` runtime manifest at `.orchestra/runtime/delegation/**`; integrate only conservative cross-provider routing into provider control planes.

**Tech Stack:** Node.js ESM, `node:test`, JSON Schema 2020-12 with standalone AJV validators, Git worktrees, existing Orchestra runtime manifests/project-runtime manager, Codex CLI, Antigravity `agy` CLI.

**Spec:** `docs/superpowers/specs/2026-10-13-orchestra-cross-provider-delegation-design.md`

**Baseline:** Orchestra 1.0.1 on `main` (`d7df9574ddc895c54ac36d9678a464a7b1b7dc88`).

## Global Constraints

- Core remains provider-neutral. `core/**` never imports provider executors, provider CLIs, concrete provider models, provider hooks, or session fields.
- Codex runtime/provider source never imports Antigravity runtime/provider source, and vice versa. The only composition root allowed to know both executors is `runtime/delegation/**` and its installed mirror under `.orchestra/runtime/delegation/**`.
- Delegation does not transfer CONTROL authority, Work Lease generation, candidate promotion, evidence promotion, or acceptance ownership.
- V1 worker authority is exactly bounded to `LOCAL_READ` and `PROCESS_EXEC`; mutation, worker network authority, remote repository writes, publication, and recursive delegation are forbidden.
- Provider-authenticated model transport is infrastructure and is distinct from worker tool network authority.
- Every delegated execution uses a Git worktree whose physical path resolves outside the canonical checkout root. The canonical workspace is never the provider execution cwd.
- V1 fails closed when the source workspace is dirty because a detached worktree at `sourceRevision` cannot faithfully reproduce uncommitted state. Report `WORKSPACE_PREP_FAILED` with bounded detail `SOURCE_WORKSPACE_DIRTY`; do not silently omit local changes.
- `DelegationResult` remains a model/worker claim. It is never canonical Evidence, Candidate, or Acceptance without a separate CONTROL-owned transition.
- Same-provider remains the default. Automatic cross-provider routing is limited to independent `CRITICAL_REVIEWER`; `SECOND_OPINION` requires explicit CONTROL intent. Normal implementation, quick audit, and investigation remain local in v1.
- There is no automatic provider fallback. `PROVIDER_UNAVAILABLE` returns to CONTROL for a new explicit decision.
- Cross-provider budget is one delegation per logical stage; delegated workers always have `mayDelegate=false` and `delegationDepth=1`.
- Real provider accounts, credentials, network calls, and paid inference are never required in CI. Provider executor tests use fake process runners; live smoke tests are optional/operator-run only.
- Missing second-provider CLI or missing authentication may make cross-provider delegation unavailable, but must not make normal single-provider Orchestra unhealthy.
- Do not bump the package/release version in this plan. Release/versioning is a separate decision after the feature is complete and green.

## Review Focus

- A provider runtime must never gain an import/path dependency on the other provider merely because cross-provider delegation exists — pinned by `tests/cross-runtime/cross-runtime-firewall.test.mjs` and `tests/cross-runtime/core-provider-firewall.test.mjs`.
- A dirty canonical workspace must not be delegated as if `HEAD` represented its contents — pinned by `tests/delegation/workspace-lifecycle.test.mjs`.
- A delegated worker must not gain mutation/network authority from its logical role or from provider CLI capabilities — pinned by `tests/delegation/delegation-policy.test.mjs` and provider executor tests.
- `DelegationResult` or malformed provider output must never become Evidence/Acceptance by implication — pinned by `tests/delegation/delegation-contract.test.mjs` and `tests/delegation/broker.test.mjs`.
- Critical-review routing may cross providers, but unavailable target providers must return `PROVIDER_UNAVAILABLE`; local reviewer fallback requires a new CONTROL decision and is never broker fallback — pinned by `tests/delegation/delegation-routing.test.mjs` and provider routing tests.
- Installing both provider runtimes must converge on one independently managed neutral delegation runtime without overlapping provider ownership or drift — pinned by `tests/installers/delegation-project-runtime.test.mjs` and `tests/installers/self-contained-runtime.test.mjs`.
- Normal implementation/investigation/quick audit must retain same-provider behavior and turn economy — pinned by `tests/delegation/delegation-routing.test.mjs` plus existing turn-economy/provider routing suites.

---

## Milestone 1 — Foundation + Codex → AGY PoC

### Task 1: Add first-class delegation schemas and domain contracts

**Files:**
- Create: `schemas/delegation-request.v1.schema.json`
- Create: `schemas/delegation-result.v1.schema.json`
- Create: `core/domain/delegation.mjs`
- Modify: `scripts/build-schema-validators.mjs`
- Modify: `core/schema/validator.mjs`
- Modify: `tests/core/schema-validation.test.mjs`
- Modify: `tests/core/schema-standalone-runtime.test.mjs`
- Create: `tests/delegation/delegation-contract.test.mjs`
- Regenerate: `core/schema/generated/delegation-request.v1.mjs`
- Regenerate: `core/schema/generated/delegation-result.v1.mjs`

**Interfaces:**
- Export `DELEGATION_PURPOSES = { INDEPENDENT_REVIEW, SECOND_OPINION, SPECIALIST_EXECUTION, MANUAL }`.
- Export `DELEGATION_STATUSES = { COMPLETED, FAILED, TIMED_OUT, DENIED }`.
- Export bounded failure reasons: `PROVIDER_UNAVAILABLE`, `CAPABILITY_DENIED`, `WORKSPACE_PREP_FAILED`, `EXECUTION_FAILED`, `EXECUTION_TIMED_OUT`, `INVALID_RESULT`, `WORKSPACE_CLEANUP_FAILED`.
- Export `validateDelegationRequest(request)`, `assertDelegationRequest(request)`, `validateDelegationResult(result)`, `assertDelegationResult(result)` using canonical standalone schema validation.
- `DelegationRequest.v1` embeds one canonical `ImplementationPacket`, requires explicit source/target provider, logical role, purpose, authority, workspace identity, and limits.
- `DelegationResult.v1` bounds summary/findings/evidence refs, execution facts, workspace fingerprints/dirty state, status, and reason; no raw transcript/prompt/reasoning/stdout/stderr fields.

- [ ] **Step 1: Write RED schema/domain tests**
  - Valid request/result fixtures pass.
  - Unknown top-level fields and transcript/reasoning/raw-output fields fail closed.
  - Missing provider/task/delegation identity fails.
  - Invalid purpose/status/failure reason fails.
  - `delegationDepth > 1`, `mayDelegate=true`, unsupported isolation, mutation/network authority, and capability values outside the schema vocabulary fail.
  - Result remains structurally distinct from Evidence/Candidate/AuditResult.

- [ ] **Step 2: Confirm RED**
  - Run: `node --test tests/delegation/delegation-contract.test.mjs tests/core/schema-validation.test.mjs tests/core/schema-standalone-runtime.test.mjs`
  - Expected: FAIL because delegation schemas/validators do not exist.

- [ ] **Step 3: Implement schemas/domain wrappers and register validators**
  - Add the two schema filenames to `SCHEMA_FILES` and `core/schema/validator.mjs`.
  - Keep all provider names generic string identifiers in Core; do not encode CLI/model specifics.
  - Bound strings/arrays/output sizes in schema rather than relying only on executor discipline.

- [ ] **Step 4: Generate validators and verify GREEN**
  - Run: `npm run build:schemas`
  - Run: `node --test tests/delegation/delegation-contract.test.mjs tests/core/schema-validation.test.mjs tests/core/schema-standalone-runtime.test.mjs`
  - Run: `npm run check:schemas`
  - Expected: PASS.

- [ ] **Step 5: Commit**
  - Commit message: `feat(delegation): add canonical delegation contracts`

---

### Task 2: Add delegation authority, Worker Envelope, budget, and target selection

**Files:**
- Create: `core/delegation/policy.mjs`
- Create: `core/delegation/worker-envelope.mjs`
- Create: `core/routing/delegation-target.mjs`
- Create: `tests/delegation/delegation-policy.test.mjs`
- Create: `tests/delegation/delegation-routing.test.mjs`

**Interfaces:**
- `authorizeDelegationRequest(request, { sourceProvider, sourceFingerprint }) -> { allowed, reason }`.
- `buildWorkerEnvelope(request) -> { objective, logicalRole, purpose, context, scope, validation, capabilities, prohibitions, outputContract, limits }`.
- Worker Envelope MUST omit Work Lease internals, actor authority not needed by the worker, canonical state paths, raw transcript/history, and provider-control metadata.
- Export a bounded provider-neutral worker-report JSON Schema object used only as executor output contract; it is not canonical workflow state.
- `selectDelegationTarget({ sourceProvider, logicalRole, purpose, independenceRequired, providerCapabilities, budget }) -> { mode: 'LOCAL'|'CROSS_PROVIDER'|'NONE', targetProvider, reason }`.
- `consumeCrossProviderBudget({ used, limit = 1 }) -> { allowed, remaining, reason }`.

- [ ] **Step 1: Write RED authority/envelope tests**
  - Only `LOCAL_READ` + `PROCESS_EXEC` are allowed in v1.
  - `mutation !== FORBIDDEN`, `network !== FORBIDDEN`, `mayDelegate=true`, or depth > 1 is denied even for `CRITICAL_REVIEWER`.
  - Logical role never upgrades capability.
  - Full request/lease metadata is not copied into the Worker Envelope.
  - Provider transport is not represented as worker `NETWORK_READ/WRITE` capability.

- [ ] **Step 2: Write RED routing tests**
  - Normal implementation, quick audit, and investigation choose local/no cross-provider delegation.
  - Critical review chooses the opposite healthy provider when independence is required.
  - Explicit `SECOND_OPINION` may choose the opposite healthy provider.
  - `SPECIALIST_EXECUTION` is contract-valid but has no automatic v1 route.
  - Missing target capability returns `NONE/PROVIDER_UNAVAILABLE`; it never chooses the source provider as fallback.
  - Consuming the one-per-stage budget prevents a second delegation.

- [ ] **Step 3: Confirm RED**
  - Run: `node --test tests/delegation/delegation-policy.test.mjs tests/delegation/delegation-routing.test.mjs`

- [ ] **Step 4: Implement minimal pure policy**
  - Keep target-selection separate from `classifyTask()` and `escalateTask()`; do not add provider names/models to existing task classification.

- [ ] **Step 5: Verify GREEN and commit**
  - Run: `node --test tests/delegation/delegation-policy.test.mjs tests/delegation/delegation-routing.test.mjs`
  - Commit message: `feat(delegation): add authority and target policy`

---

### Task 3: Implement external ephemeral Git worktree lifecycle

**Files:**
- Create: `runtime/delegation/workspace.mjs`
- Create: `tests/delegation/workspace-lifecycle.test.mjs`
- Reuse: `core/leases/workspace-fingerprint.mjs`

**Interfaces:**
- `prepareDelegationWorkspace({ repoRoot, request, baseDir = null }) -> { repoRoot, path, sourceRevision, initialFingerprint, cleanupToken }`.
- `inspectDelegationWorkspace(context) -> { finalFingerprint, dirty, dirtyFileCount }`.
- `cleanupDelegationWorkspace(context) -> { cleaned, reason }`.
- Default physical root: bounded OS temp location such as `<tmp>/orchestra-delegations/<workspace-hash>/<delegationId>/`; caller-injected `baseDir` exists for deterministic tests.
- Creation uses exact `git worktree add --detach <path> <sourceRevision>` semantics; cleanup targets only the exact attributable worktree path.

- [ ] **Step 1: Write RED lifecycle tests with temporary Git repos**
  - Clean source at factual HEAD produces an external detached worktree at the requested revision.
  - Resolved worktree path is outside canonical checkout root, including linked-worktree fixtures.
  - Source fingerprint/revision mismatch fails `WORKSPACE_PREP_FAILED`.
  - Dirty tracked or untracked canonical source fails `WORKSPACE_PREP_FAILED` with bounded detail `SOURCE_WORKSPACE_DIRTY` rather than silently delegating HEAD.
  - A delegated test may create files in the isolated worktree; final inspection reports dirty while canonical checkout remains unchanged.
  - Cleanup removes only that worktree and leaves repository/canonical files untouched.
  - Cleanup failure returns a bounded failure and leaves an attributable recovery path; no broad `git clean`/`rm` over project roots.

- [ ] **Step 2: Confirm RED**
  - Run: `node --test tests/delegation/workspace-lifecycle.test.mjs`

- [ ] **Step 3: Implement exact-path worktree lifecycle**
  - Reuse canonical `readWorkspaceFingerprint()` for source/final identity.
  - Validate delegation IDs before using them in filesystem paths.
  - Normalize platform paths and preserve Windows/linked-worktree compatibility.

- [ ] **Step 4: Verify GREEN and commit**
  - Run: `node --test tests/delegation/workspace-lifecycle.test.mjs tests/leases/workspace-fingerprint.test.mjs`
  - Commit message: `feat(delegation): isolate external workers in worktrees`

---

### Task 4: Add bounded process execution, delegation records, and lifecycle events

**Files:**
- Create: `runtime/delegation/process-runner.mjs`
- Create: `runtime/delegation/store.mjs`
- Create: `runtime/delegation/events.mjs`
- Create: `tests/delegation/process-runner.test.mjs`
- Create: `tests/delegation/delegation-store.test.mjs`
- Reuse: `core/events/runtime-event.mjs`

**Interfaces:**
- `runBoundedProcess({ command, args, cwd, input = null, timeoutMs, maxOutputBytes, env }) -> { exitCode, signal, durationMs, stdout, stderr, stdoutTruncated, stderrTruncated, timedOut }`.
- `writeDelegationRecord(projectRoot, record)`, `readDelegationRecord(projectRoot, delegationId)`, `listDelegationRecords(projectRoot)` under `.orchestra/state/delegations/`.
- Records contain bounded request identity, source/target provider, role, purpose, status/reason, timestamps, execution facts, fingerprints, evidence refs, cleanup status/path when cleanup failed; never raw prompt/transcript/reasoning/full stdout/stderr.
- `createDelegationLifecycleEvent({ type, delegationId, taskId, generation, actor })` reuses canonical empty-payload `RuntimeEvent` with explicit deterministic event IDs for correlation.

- [ ] **Step 1: Write RED process tests**
  - Success, non-zero exit, timeout/kill, output truncation, stdin delivery, and bounded stderr behavior are deterministic.
  - Timeout cannot leave a healthy child process running.

- [ ] **Step 2: Write RED state/event tests**
  - Path traversal/invalid delegation IDs are rejected.
  - Record serialization excludes raw context/output fields.
  - STARTED/COMPLETED/FAILED/TIMED_OUT/CLEANUP_FAILED events correlate by delegation ID while keeping canonical runtime-event payload empty.
  - In-flight record discovery can tell project-runtime management whether delegation code is safe to update.

- [ ] **Step 3: Implement minimal runner/store/events**

- [ ] **Step 4: Verify GREEN and commit**
  - Run: `node --test tests/delegation/process-runner.test.mjs tests/delegation/delegation-store.test.mjs tests/core/runtime-event.test.mjs`
  - Commit message: `feat(delegation): add bounded execution records`

---

### Task 5: Add AGY CLI executor and neutral broker for Codex → AGY PoC

**Files:**
- Create: `providers/antigravity/delegation-executor.mjs`
- Create: `runtime/delegation/broker.mjs`
- Create: `runtime/delegation/cli.mjs`
- Create: `tests/delegation/antigravity-executor.test.mjs`
- Create: `tests/delegation/broker.test.mjs`
- Reuse: `providers/antigravity/model-catalog.mjs`

**Interfaces:**
- `createAntigravityDelegationExecutor({ runProcess = runBoundedProcess }) -> { provider: 'antigravity', discover(), execute(context) }`.
- `discover()` checks the factual `agy` binary/version/help surface and requires non-interactive print, timeout, sandbox, and model-selection support; it does not authenticate or run model inference.
- `execute({ request, workerEnvelope, workspace })` resolves the provider-local model profile from logical role, runs `agy` in non-interactive sandboxed mode inside the ephemeral worktree, requests only the bounded worker-report JSON shape, and strictly parses one JSON document. No regex/free-form recovery of malformed output.
- `createDelegationBroker({ executors, workspace, store, events })` and `executeDelegation(request, { repoRoot, generation, actor }) -> DelegationResult`.
- Broker order: validate/authorize -> discover exact target -> prepare worktree -> persist STARTED/event -> execute target -> strict normalize/schema-validate -> inspect worktree -> cleanup -> persist terminal record/event -> return result.
- Any cleanup failure overrides success with bounded `WORKSPACE_CLEANUP_FAILED` data while preserving the attributable recovery path.
- CLI: `node runtime/delegation/cli.mjs delegate --request <file> --repo <path> --json`; it reads one canonical request file and emits one canonical result JSON.

- [ ] **Step 1: Write RED AGY executor tests using a fake process runner**
  - Discovery sees supported/unsupported/missing CLI surfaces without inference.
  - Command construction includes non-interactive execution, provider-native sandbox, timeout, and model selection.
  - Worker Envelope, not full DelegationRequest/lease metadata, is delivered to the model.
  - Valid bounded JSON normalizes; prose-wrapped/malformed/oversized output becomes `INVALID_RESULT`.
  - Missing binary becomes `PROVIDER_UNAVAILABLE`; timeout becomes `EXECUTION_TIMED_OUT`; non-zero execution becomes `EXECUTION_FAILED`.

- [ ] **Step 2: Write RED broker lifecycle tests**
  - Source `codex`, target `antigravity` completes end-to-end with fake executor and real temporary Git worktree.
  - Broker never invokes a source-provider fallback when target discovery/execution fails.
  - Result is persisted as a claim and is not written into evidence/candidate/acceptance state.
  - Worktree is cleaned on success, invalid result, timeout, and execution failure.

- [ ] **Step 3: Confirm RED**
  - Run: `node --test tests/delegation/antigravity-executor.test.mjs tests/delegation/broker.test.mjs`

- [ ] **Step 4: Implement AGY executor, broker, and source-level CLI**
  - Provider-specific CLI flags stay in the Antigravity executor; Core/broker only sees normalized executor methods.
  - Keep model transport distinct from worker network capability.

- [ ] **Step 5: Verify Milestone 1 source-level GREEN and commit**
  - Run: `node --test tests/delegation/*.test.mjs`
  - Run: `npm run test:core && npm run test:leases && npm run test:firewall && npm run check:contamination`
  - Commit message: `feat(delegation): broker Codex to Antigravity workers`

---

### Task 6: Package delegation as an independent project-wide runtime

**Files:**
- Create: `runtime/manifests/delegation.json`
- Create: `runtime/delegation/project-runtime-manager.mjs`
- Create: `runtime/delegation/project-runtime-adapter.mjs`
- Modify: `runtime/manifest-loader.mjs`
- Modify: `scripts/build-runtimes.mjs`
- Modify: `scripts/check-runtime-build.mjs`
- Modify: `runtime/manifests/codex.json` only if needed to preserve/discover `.orchestra/runtime/delegation` without claiming ownership; do not add the neutral tree as a Codex-managed output.
- Modify: `runtime/manifests/antigravity.json` only if needed for the same non-ownership reason.
- Modify: `scripts/orchestra-codex-project.mjs`
- Modify: `scripts/orchestra-project.mjs`
- Modify: `tests/runtime/runtime-manifest.test.mjs`
- Modify: `tests/installers/self-contained-runtime.test.mjs`
- Create: `tests/installers/delegation-project-runtime.test.mjs`

**Packaging contract:**
- Add fourth canonical manifest name: `delegation`.
- Installed destination is `.orchestra/runtime/delegation/**` with independent metadata/backups at `.orchestra/state/runtimes/delegation.json` and `.orchestra/state/runtime-management/delegation/**` through the existing generic project-runtime manager.
- The neutral runtime is self-contained and may contain canonical `core/**` required by the broker plus only the provider-local delegation executors/catalogs needed to compose Codex and Antigravity. It must not copy either provider runtime's hooks/session/control-plane tree.
- Codex and Antigravity manifests remain owners only of their provider-specific runtime images. They do not both claim `.orchestra/runtime/delegation/**`.
- Provider install/update CLIs ensure the independent delegation runtime is installed/current before advertising cross-provider readiness. A delegation-runtime failure is surfaced factually; it is not hidden as a successful cross-provider setup.
- Delegation runtime update quiescence denies replacement while a persisted delegation record is in-flight.
- Provider rollback does not implicitly rollback the shared delegation runtime; it has independent rollback metadata/lifecycle.

- [ ] **Step 1: Write RED manifest/install tests**
  - `loadRuntimeManifest('delegation')` succeeds and deterministic build/check scripts include it.
  - Built delegation image contains neutral broker/Core + both delegation executors but no `.codex/**`, `.agents/**`, provider hooks, provider session state, or unrelated model/runtime source.
  - Fresh Codex install and fresh AGY install each can ensure delegation runtime.
  - Installing the second provider after the first is idempotent for the existing delegation runtime and does not create ownership collision.
  - Updating one provider does not delete/corrupt the neutral runtime or the other provider runtime.
  - Delegation records under `.orchestra/state/delegations/**` survive update/rollback.

- [ ] **Step 2: Confirm RED**
  - Run: `node --test tests/runtime/runtime-manifest.test.mjs tests/installers/delegation-project-runtime.test.mjs tests/installers/self-contained-runtime.test.mjs`

- [ ] **Step 3: Implement fourth manifest and project-runtime wrapper**
  - Prefer copying the canonical Core tree into the neutral runtime rather than creating a fragile hand-maintained partial Core dependency list.
  - Add only provider delegation executor/catalog files needed by the composition root.

- [ ] **Step 4: Integrate source installer CLIs**
  - Build provider and delegation images separately.
  - Report provider-runtime and delegation-runtime operations separately in JSON output so partial/degraded setup cannot be mistaken for full readiness.

- [ ] **Step 5: Verify deterministic/self-contained packaging and commit**
  - Run: `npm run build:runtimes`
  - Run: `npm run check:runtimes`
  - Run: `node --test tests/runtime/runtime-manifest.test.mjs tests/installers/delegation-project-runtime.test.mjs tests/installers/self-contained-runtime.test.mjs`
  - Commit message: `feat(runtime): package neutral delegation broker`

---

### Task 7: Expose governed Codex control-plane delegation entrypoint

**Files:**
- Create: `runtimes/codex/.codex/astra-orchestra/cross-provider-delegation.mjs`
- Modify: `runtimes/codex/.codex/astra-orchestra/routing-policy.mjs`
- Modify: `runtimes/codex/.codex/astra-orchestra/INSTRUCTIONS.md`
- Modify: `runtimes/codex/.codex/astra-orchestra/routing-policy.test.mjs`
- Modify: `tests/provider-contract/routing-facade.test.mjs`

**Interfaces:**
- Provider-local helper builds a canonical request from factual Codex actor/task state plus an already-built `ImplementationPacket`, but contains no Antigravity imports or CLI flags.
- It resolves target selection through canonical `selectDelegationTarget()` and invokes the neutral `.orchestra/runtime/delegation/cli.mjs` boundary rather than importing the AGY executor.
- Explicit CONTROL `SECOND_OPINION` and bounded manual Codex → AGY PoC are supported; normal implementation remains local.

- [ ] **Step 1: Write RED Codex integration tests**
  - Request source provider/actor/task/fingerprint/revision are factual and match canonical state.
  - Target provider appears only as normalized target identity; no foreign provider imports/model IDs enter `.codex/**`.
  - Normal implementation/investigation/quick audit do not trigger cross-provider delegation.
  - Explicit `SECOND_OPINION` creates one request with budget=1 and returns the broker result to CONTROL without self-accepting it.

- [ ] **Step 2: Confirm RED**
  - Run: `npm run test:codex && node --test tests/provider-contract/routing-facade.test.mjs`

- [ ] **Step 3: Implement thin Codex control-plane adapter/instructions**
  - Keep existing same-provider routing/profile behavior unchanged except where later Task 8 explicitly adds automatic critical review.

- [ ] **Step 4: Verify Milestone 1 end-to-end deterministic PoC and commit**
  - Run: `npm run test:codex && npm run test:firewall && npm run check:contamination && node --test tests/delegation/*.test.mjs`
  - Commit message: `feat(codex): expose cross-provider delegation`

---

## Milestone 2 — Governed automatic independent critical review

### Task 8: Integrate conservative critical-review routing in both control planes

**Files:**
- Modify: `runtimes/codex/.codex/astra-orchestra/cross-provider-delegation.mjs`
- Modify: `runtimes/codex/.codex/astra-orchestra/routing-policy.mjs`
- Modify: `runtimes/codex/.codex/astra-orchestra/INSTRUCTIONS.md`
- Modify: `runtimes/codex/.codex/astra-orchestra/routing-policy.test.mjs`
- Create: `runtimes/antigravity/.agents/skills/orchestra/cross-provider-delegation.mjs`
- Modify: `runtimes/antigravity/.agents/skills/orchestra/routing-policy.mjs`
- Modify: `runtimes/antigravity/.agents/hooks/pre-tool-enforce.mjs` only as needed to authorize the neutral delegation CLI as CONTROL-plane process execution without granting product mutation/network capability.
- Modify: `runtimes/antigravity/GEMINI.md`
- Modify: `runtimes/antigravity/.agents/skills/orchestra/routing-policy.test.mjs`
- Modify: `tests/provider-contract/routing-facade.test.mjs`
- Modify: `tests/delegation/delegation-routing.test.mjs`
- Modify: existing turn-economy tests only to pin no new fan-out for non-critical work.

**Behavior:**
- `CRITICAL_REVIEWER` + healthy independent opposite provider automatically selects one cross-provider delegation.
- Codex-produced candidate -> AGY critical reviewer.
- AGY-produced candidate -> Codex critical reviewer once the Codex executor exists in Task 9; until then the route is structurally selected but capability reports unavailable rather than falling back.
- AGY's existing local Two-Key review remains a local capability available only after a new explicit CONTROL decision. It is not silent broker fallback when the independent provider is unavailable.
- Any `PROVIDER_UNAVAILABLE` returns to CONTROL. No Reviewer C, no hidden local substitute, no provider switch inside the broker.

- [ ] **Step 1: Write RED provider routing tests**
  - Critical review requests an independent opposite provider when capability is healthy.
  - Missing opposite provider returns unavailable to CONTROL.
  - Normal review/quick audit remains local.
  - Implementation and investigation remain same-provider.
  - Cross-provider budget blocks repeated critical-review fan-out in the same logical stage.
  - Delegated review result remains a claim that existing CONTROL acceptance logic must explicitly inspect/promote.

- [ ] **Step 2: Write RED AGY policy/hook tests**
  - Neutral delegation CLI invocation is allowed only for factual CONTROL delegation flow.
  - The permission does not generalize to arbitrary shell/network/product-write authority.
  - Existing terminal-delegation/turn-diet invariants are reconciled explicitly for cross-provider CLI execution; no polling/watchdog is introduced.

- [ ] **Step 3: Implement provider-local request adapters and routing integration**
  - Provider facades consume neutral routing policy; they do not embed opposite-provider model catalogs.
  - Update provider instructions to state that independent critical review crosses provider when available.

- [ ] **Step 4: Verify routing/turn-economy GREEN and commit**
  - Run: `npm run test:codex && npm run test:antigravity && npm run test:hooks`
  - Run: `node --test tests/delegation/delegation-routing.test.mjs tests/provider-contract/routing-facade.test.mjs`
  - Run: `npm run test:turn-economy`
  - Commit message: `feat(routing): cross providers for critical review`

---

## Milestone 3 — AGY → Codex symmetry

### Task 9: Add Codex CLI executor and prove reverse-path symmetry

**Files:**
- Create: `providers/codex/delegation-executor.mjs`
- Create: `tests/delegation/codex-executor.test.mjs`
- Modify: `tests/delegation/broker.test.mjs`
- Modify: `tests/installers/delegation-project-runtime.test.mjs` if the neutral manifest initially packaged only the AGY executor.
- Reuse: `providers/codex/model-catalog.mjs`

**Interfaces:**
- `createCodexDelegationExecutor({ runProcess = runBoundedProcess }) -> { provider: 'codex', discover(), execute(context) }`.
- `discover()` checks `codex` version/`exec --help` for required non-interactive/sandbox/structured-output support without inference.
- `execute()` uses provider-local model catalog resolution and non-interactive `codex exec` with a disposable-worktree sandbox, no interactive approval, Worker Envelope on stdin, an executor-created bounded output-schema file, and a bounded last-message/result file.
- The physical worktree may become dirty inside the sandbox; logical mutation authority remains forbidden because no output is promoted and the worktree is discarded.
- Strictly parse/validate one bounded worker report; malformed/missing result is `INVALID_RESULT`.

- [ ] **Step 1: Write RED Codex executor tests with fake runner/filesystem fixtures**
  - Discovery detects supported/missing/unsupported CLI surfaces without inference.
  - Command construction contains non-interactive exec, provider-native sandbox, no interactive approval, model/reasoning profile, output schema, and bounded result file.
  - Full DelegationRequest/lease metadata is not sent to the worker.
  - Timeout/non-zero/malformed output map to canonical failure taxonomy.

- [ ] **Step 2: Write RED broker symmetry tests**
  - AGY source -> Codex target uses exactly the same request/result/workspace/broker contracts as Codex -> AGY.
  - No change to `DelegationRequest`, authority semantics, workspace lifecycle, or broker API is required to add Codex executor.
  - If reverse path requires a provider-specific Core field, fail the task and correct the abstraction rather than adding it.

- [ ] **Step 3: Implement Codex executor and register it only in neutral composition root**

- [ ] **Step 4: Verify Milestone 3 GREEN and commit**
  - Run: `node --test tests/delegation/*.test.mjs`
  - Run: `npm run test:codex && npm run test:antigravity && npm run test:firewall && npm run check:contamination`
  - Commit message: `feat(delegation): add Codex external executor`

---

### Task 10: Add cross-provider Doctor, firewall invariants, docs, and final regression gate

**Files:**
- Create: `runtime/delegation/discovery.mjs`
- Modify: `runtime/doctor.mjs`
- Modify: `tests/runtime/doctor.test.mjs`
- Modify: `scripts/contamination-check.mjs`
- Modify: `tests/cross-runtime/cross-runtime-firewall.test.mjs`
- Modify: `tests/cross-runtime/core-provider-firewall.test.mjs`
- Modify: `package.json`
- Modify: `docs/architecture.md`
- Modify: `docs/routing.md`
- Modify: `docs/efficiency.md`
- Modify: `docs/project-runtime.md`
- Modify: `runtimes/codex/README.md`
- Modify: `runtimes/antigravity/README.md`
- Modify: `README.md` if the public feature surface is documented there.

**Interfaces/Doctor behavior:**
- `inspectDelegationCapabilities({ runProcess }) -> { status: 'READY'|'DEGRADED'|'UNAVAILABLE', gitWorktree, providers: { codex, antigravity } }`.
- Capability discovery checks binary presence/version/help flags and Git worktree support only. It never logs in, installs a provider, or invokes a model.
- Repository Doctor reports cross-provider readiness separately from core repository health. Missing one/both external CLIs does not fail ordinary Orchestra health.
- `package.json` adds `test:delegation` and wires it into full `npm test` before firewall/installers so delegation failures are visible as a named suite.

- [ ] **Step 1: Write RED Doctor/firewall tests**
  - Doctor reports READY when both fake provider capabilities + Git worktree are present, DEGRADED/UNAVAILABLE otherwise, while `healthy` remains true for a structurally healthy repo with optional provider absence.
  - Existing Core/provider import firewalls remain unchanged.
  - Add a narrow invariant that `runtime/delegation/**` is the only source composition root permitted to import both provider delegation executors.
  - Assert `.codex/**` does not contain AGY executor/catalog/runtime source and `.agents/**` does not contain Codex executor/catalog/runtime source.
  - Assert neutral installed runtime contains no provider hook/session/control-plane trees.

- [ ] **Step 2: Confirm RED**
  - Run: `node --test tests/runtime/doctor.test.mjs tests/cross-runtime/*.test.mjs`

- [ ] **Step 3: Implement Doctor/discovery/firewall/documentation**
  - Do not weaken `scanProviderRuntimeImports()` globally; add only the neutral composition-root allowance/tests needed by the new architecture.
  - Document failure semantics, dirty-source fail-closed behavior, provider prerequisites, routing conservatism, and optional live-smoke workflow.

- [ ] **Step 4: Run focused feature verification**
  - Run: `npm run build:schemas && npm run check:schemas`
  - Run: `npm run build:runtimes && npm run check:runtimes`
  - Run: `npm run test:delegation`
  - Run: `npm run test:codex && npm run test:antigravity && npm run test:hooks`
  - Run: `npm run test:firewall && npm run test:installers && npm run test:turn-economy`
  - Run: `npm run check:contamination`
  - Expected: PASS.

- [ ] **Step 5: Run full regression/health gate**
  - Run: `npm test`
  - Run: `npm run doctor`
  - Run: `git diff --check`
  - Expected: PASS. Doctor may report external provider availability as READY/DEGRADED/UNAVAILABLE, but optional CLI absence must not make repository health fail.

- [ ] **Step 6: Optional operator-only live smoke (never CI gate)**
  - Preconditions: both CLIs installed/authenticated, clean disposable fixture repository, explicit operator intent.
  - Exercise one Codex -> AGY `SECOND_OPINION` request and one AGY -> Codex `SECOND_OPINION` request.
  - Verify canonical checkout unchanged, external worktrees cleaned, records bounded, factual provider provenance retained, and no result auto-promoted into Evidence/Acceptance.
  - Record real token/cost metrics only if provider output factually supplies them; otherwise leave them absent.

- [ ] **Step 7: Commit final integration/docs**
  - Commit message: `feat(orchestra): complete cross-provider delegation`

---

## Completion Gate

The feature is complete only when all of the following are true:

- Both delegation schemas and standalone validators are canonical and green.
- Codex -> AGY and AGY -> Codex pass through one unchanged broker/request/result/workspace contract.
- Every delegated execution is externally isolated and canonical source dirtiness fails closed.
- V1 authority never exceeds `LOCAL_READ + PROCESS_EXEC`; provider transport does not become worker network authority.
- No delegated result self-promotes into Evidence, Candidate, Acceptance, or Work Lease authority.
- Automatic cross-provider routing occurs only for independent critical review; explicit second opinion works; normal implementation/investigation/quick audit remain local.
- Provider unavailable never triggers silent fallback.
- The neutral delegation runtime is independently packaged, self-contained, deterministic, and coexists with both provider runtimes without ownership collisions.
- `.codex/**` and `.agents/**` remain provider-pure; only the neutral composition root knows both delegation executors.
- Doctor reports cross-provider capability without provider install/auth/inference and without failing healthy single-provider usage.
- Full regression, Doctor, runtime build checks, contamination/firewall, installers, and turn-economy suites are green.
