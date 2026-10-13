# Orchestra Cross-Provider Delegation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add provider-neutral cross-provider delegation so Codex CONTROL can hire AGY, and AGY CONTROL can hire Codex, as isolated read/process-exec workers while preserving Work Lease authority, evidence ownership, provider firewalls, and the current turn-economy baseline.

**Architecture:** Add first-class delegation contracts/policy in provider-neutral Core; run external workers through a project-wide neutral broker under `runtime/delegation/**`; isolate every execution in an external ephemeral Git worktree; keep CLI mechanics in provider-local executors; distribute the broker through an independent `delegation` runtime at `.orchestra/runtime/delegation/**`; integrate only conservative cross-provider routing into provider control planes.

**Tech Stack:** Node.js ESM, `node:test`, JSON Schema 2020-12 with standalone AJV validators, Git worktrees, Orchestra runtime manifests/project-runtime manager, Codex CLI, Antigravity `agy` CLI.

**Spec:** `docs/superpowers/specs/2026-10-13-orchestra-cross-provider-delegation-design.md`

**Baseline:** Orchestra 1.0.1 on `main` (`d7df9574ddc895c54ac36d9678a464a7b1b7dc88`).

## Global Constraints

- `core/**` remains provider-neutral: no Codex/Antigravity names, CLI flags, model IDs, hooks/session fields, or executor imports. Generic `provider` identity is allowed; concrete identities enter only at provider/control-plane composition boundaries.
- Codex runtime/provider source never imports Antigravity runtime/provider source, and vice versa. Only `runtime/delegation/**` may compose both provider delegation executors.
- Delegation never transfers CONTROL, Work Lease generation, candidate promotion, evidence promotion, or acceptance authority.
- V1 worker authority is exactly `LOCAL_READ + PROCESS_EXEC`; mutation, worker network authority, remote writes/publication, and recursive delegation are forbidden. Provider-authenticated inference transport is infrastructure, not worker network authority.
- Every execution uses a Git worktree whose physical path resolves outside the canonical checkout. V1 fails closed on a dirty source workspace because detached `sourceRevision` cannot reproduce uncommitted state: return `WORKSPACE_PREP_FAILED` with bounded detail `SOURCE_WORKSPACE_DIRTY`.
- `DelegationResult` is a worker claim, never Evidence/Candidate/Acceptance by implication.
- Same-provider remains default. Automatic cross-provider routing is only for independent `CRITICAL_REVIEWER`; `SECOND_OPINION` requires explicit CONTROL intent. Normal implementation, quick audit, and investigation stay local.
- No automatic provider fallback. `PROVIDER_UNAVAILABLE` returns to CONTROL for a new decision.
- Budget is one cross-provider delegation per logical stage; workers always receive `mayDelegate=false`, `delegationDepth=1`.
- CI never requires real provider accounts/network/inference. Executor tests use fake process runners; live smoke is optional/operator-only.
- Missing second-provider CLI/auth may make delegation unavailable but must not make normal single-provider Orchestra unhealthy.
- Do not bump package/release version in this plan.

## Review Focus

- Provider runtimes remain mutually isolated — `tests/cross-runtime/cross-runtime-firewall.test.mjs`, `tests/cross-runtime/core-provider-firewall.test.mjs`.
- Dirty canonical state is never silently replaced by HEAD in a delegated worktree — `tests/delegation/workspace-lifecycle.test.mjs`.
- Role/provider CLI capability never upgrades delegated authority — `tests/delegation/delegation-policy.test.mjs`, provider executor tests.
- Result/malformed provider output never self-promotes into Evidence/Acceptance — `tests/delegation/delegation-contract.test.mjs`, `tests/delegation/broker.test.mjs`.
- Critical review may cross providers, but unavailable targets never silently fall back — `tests/delegation/delegation-routing.test.mjs`, provider routing tests.
- Both provider installs converge on one independently owned neutral delegation runtime — `tests/installers/delegation-project-runtime.test.mjs`, `tests/installers/self-contained-runtime.test.mjs`.
- Normal implementation/investigation/quick audit keep same-provider behavior and current turn economy — delegation routing + existing turn-economy suites.

---

## Milestone 1 — Foundation + Codex → AGY PoC

### Task 1: Add canonical delegation contracts

**Files:**
- Create: `schemas/delegation-request.v1.schema.json`
- Create: `schemas/delegation-result.v1.schema.json`
- Create: `core/domain/delegation.mjs`
- Modify: `scripts/build-schema-validators.mjs`
- Modify: `core/schema/validator.mjs`
- Modify: `tests/core/schema-validation.test.mjs`
- Modify: `tests/core/schema-standalone-runtime.test.mjs`
- Create: `tests/delegation/delegation-contract.test.mjs`
- Regenerate: `core/schema/generated/delegation-request.v1.mjs`, `core/schema/generated/delegation-result.v1.mjs`

**Interfaces:**
- `DELEGATION_PURPOSES = { INDEPENDENT_REVIEW, SECOND_OPINION, SPECIALIST_EXECUTION, MANUAL }`.
- `DELEGATION_STATUSES = { COMPLETED, FAILED, TIMED_OUT, DENIED }`.
- Failure reasons: `PROVIDER_UNAVAILABLE`, `CAPABILITY_DENIED`, `WORKSPACE_PREP_FAILED`, `EXECUTION_FAILED`, `EXECUTION_TIMED_OUT`, `INVALID_RESULT`, `WORKSPACE_CLEANUP_FAILED`.
- `validate/assertDelegationRequest()`, `validate/assertDelegationResult()` use canonical standalone schema validation.
- Request embeds one canonical `ImplementationPacket`; result bounds summary/findings/evidence refs/execution/workspace facts and excludes raw transcript/prompt/reasoning/stdout/stderr.

- [ ] **Step 1: Write RED contract tests** — valid fixtures pass; unknown/raw narrative fields fail; missing IDs/provider/task fail; bad purpose/status/reason fail; depth > 1, `mayDelegate=true`, mutation/network authority, unsupported isolation/capabilities fail; result is structurally distinct from Evidence/Candidate/AuditResult.
- [ ] **Step 2: Confirm RED** — `node --test tests/delegation/delegation-contract.test.mjs tests/core/schema-validation.test.mjs tests/core/schema-standalone-runtime.test.mjs`.
- [ ] **Step 3: Implement schemas/domain/validator registration** — schemas use generic provider strings only; bound strings/arrays at schema level.
- [ ] **Step 4: Generate and verify GREEN** — `npm run build:schemas && npm run check:schemas`; rerun focused tests.
- [ ] **Step 5: Commit** — `feat(delegation): add canonical delegation contracts`.

---

### Task 2: Add authority, Worker Envelope, budget, and provider-neutral target selection

**Files:**
- Create: `core/delegation/policy.mjs`
- Create: `core/delegation/worker-envelope.mjs`
- Create: `core/routing/delegation-target.mjs`
- Create: `tests/delegation/delegation-policy.test.mjs`
- Create: `tests/delegation/delegation-routing.test.mjs`

**Interfaces:**
- `authorizeDelegationRequest(request, { sourceProvider, sourceFingerprint }) -> { allowed, reason }`.
- `buildWorkerEnvelope(request) -> { objective, logicalRole, purpose, context, scope, validation, capabilities, prohibitions, outputContract, limits }`; omit Work Lease/control internals, transcript/history, canonical state paths.
- Export a bounded provider-neutral worker-report JSON Schema object for executor output only; it is not canonical workflow state.
- `selectDelegationTarget({ sourceProvider, logicalRole, purpose, independenceRequired, providerCapabilities, budget }) -> { mode: 'LOCAL'|'CROSS_PROVIDER'|'NONE', targetProvider, reason }` where `providerCapabilities` is generic data such as `[{ provider, available, independent }]`. Core never encodes `codex`/`antigravity` or assumes exactly two named providers.
- `consumeCrossProviderBudget({ used, limit = 1 }) -> { allowed, remaining, reason }`.

- [ ] **Step 1: Write RED authority/envelope tests** — only local read/process exec; mutation/network/depth/delegation denied regardless of role; provider transport does not appear as worker network capability; full authority metadata is omitted.
- [ ] **Step 2: Write RED routing tests using neutral provider IDs (`provider-a`, `provider-b`)** — normal implementation/quick audit/investigation local; critical review chooses one healthy independent candidate; explicit second opinion may cross; specialist execution has no automatic route; unavailable candidate returns `PROVIDER_UNAVAILABLE`; budget prevents second delegation.
- [ ] **Step 3: Confirm RED** — `node --test tests/delegation/delegation-policy.test.mjs tests/delegation/delegation-routing.test.mjs`.
- [ ] **Step 4: Implement pure policy** — keep provider target selection separate from `classifyTask()`/`escalateTask()`.
- [ ] **Step 5: Verify/commit** — focused tests; `feat(delegation): add authority and target policy`.

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
- Default physical root is bounded OS temp space; tests inject `baseDir`. Use exact `git worktree add --detach <path> <sourceRevision>` and exact-path cleanup only.

- [ ] **Step 1: Write RED Git fixture tests** — clean source creates external worktree at exact revision; path is outside canonical/linked worktree; fingerprint/revision mismatch fails; tracked or untracked dirty source returns `WORKSPACE_PREP_FAILED/SOURCE_WORKSPACE_DIRTY`; generated files stay isolated; cleanup removes only attributable worktree; cleanup failure preserves recoverable path.
- [ ] **Step 2: Confirm RED** — `node --test tests/delegation/workspace-lifecycle.test.mjs`.
- [ ] **Step 3: Implement lifecycle** — reuse `readWorkspaceFingerprint()`, validate IDs before paths, preserve Windows/linked-worktree portability.
- [ ] **Step 4: Verify/commit** — focused test + `tests/leases/workspace-fingerprint.test.mjs`; `feat(delegation): isolate external workers in worktrees`.

---

### Task 4: Add bounded process runner, records, and lifecycle events

**Files:**
- Create: `runtime/delegation/process-runner.mjs`
- Create: `runtime/delegation/store.mjs`
- Create: `runtime/delegation/events.mjs`
- Create: `tests/delegation/process-runner.test.mjs`
- Create: `tests/delegation/delegation-store.test.mjs`
- Reuse: `core/events/runtime-event.mjs`

**Interfaces:**
- `runBoundedProcess({ command, args, cwd, input = null, timeoutMs, maxOutputBytes, env }) -> { exitCode, signal, durationMs, stdout, stderr, stdoutTruncated, stderrTruncated, timedOut }`.
- `write/read/listDelegationRecord()` under `.orchestra/state/delegations/`; reject path traversal. Persist bounded identity/status/timing/fingerprints/evidence refs/cleanup facts only, never raw prompt/transcript/reasoning/full output.
- `createDelegationLifecycleEvent(...)` uses canonical empty-payload `RuntimeEvent` with explicit delegation-correlated event IDs.
- Store exposes whether a delegation is in flight so neutral runtime update can fail closed.

- [ ] **Step 1: RED process tests** — success/nonzero/timeout/kill/output cap/stdin; timed-out child cannot remain healthy.
- [ ] **Step 2: RED store/event tests** — safe IDs, bounded serialization, STARTED/COMPLETED/FAILED/TIMED_OUT/CLEANUP_FAILED correlation, in-flight detection.
- [ ] **Step 3: Implement runner/store/events**.
- [ ] **Step 4: Verify/commit** — focused tests + `tests/core/runtime-event.test.mjs`; `feat(delegation): add bounded execution records`.

---

### Task 5: Add AGY executor and neutral broker for Codex → AGY PoC

**Files:**
- Create: `providers/antigravity/delegation-executor.mjs`
- Create: `runtime/delegation/broker.mjs`
- Create: `runtime/delegation/cli.mjs`
- Create: `tests/delegation/antigravity-executor.test.mjs`
- Create: `tests/delegation/broker.test.mjs`
- Reuse: `providers/antigravity/model-catalog.mjs`

**Interfaces:**
- `createAntigravityDelegationExecutor({ runProcess = runBoundedProcess }) -> { provider: 'antigravity', discover(), execute(context) }`.
- `discover()` checks factual `agy` binary/version/help for non-interactive print, timeout, sandbox, and model selection without auth/inference.
- `execute({ request, workerEnvelope, workspace })` resolves provider-local model profile, runs sandboxed non-interactive AGY in the ephemeral worktree, and strictly parses exactly one bounded worker-report JSON document; no permissive prose scraping.
- `createDelegationBroker({ executors, workspace, store, events })`; `executeDelegation(request, { repoRoot, generation, actor }) -> DelegationResult`.
- Lifecycle: validate/authorize -> discover exact target -> worktree -> STARTED record/event -> execute -> strict normalize/schema validate -> inspect -> cleanup -> terminal record/event. Cleanup failure overrides apparent success with bounded `WORKSPACE_CLEANUP_FAILED` facts.
- Source CLI accepts a canonical request file and emits one canonical result JSON.

- [ ] **Step 1: RED AGY executor tests with fake process runner** — supported/missing/unsupported discovery; required noninteractive/sandbox/timeout/model arguments; Worker Envelope not full request; valid JSON only; malformed/oversized -> INVALID_RESULT; missing/timeout/nonzero map to taxonomy.
- [ ] **Step 2: RED broker tests** — source `codex`, target `antigravity` fake executor + real temp worktree; no fallback; no evidence/candidate/acceptance writes; cleanup on all terminal paths.
- [ ] **Step 3: Confirm RED** — executor + broker tests.
- [ ] **Step 4: Implement executor/broker/source CLI** — provider flags stay provider-local; inference transport remains separate from worker network authority.
- [ ] **Step 5: Verify/commit** — `node --test tests/delegation/*.test.mjs`; core/leases/firewall/contamination; `feat(delegation): broker Codex to Antigravity workers`.

---

### Task 6: Package an independent neutral delegation runtime

**Files:**
- Create: `runtime/manifests/delegation.json`
- Create: `runtime/delegation/project-runtime-manager.mjs`
- Create: `runtime/delegation/project-runtime-adapter.mjs`
- Modify: `runtime/manifest-loader.mjs`
- Modify: `scripts/build-runtimes.mjs`, `scripts/check-runtime-build.mjs`
- Modify: `scripts/orchestra-codex-project.mjs`, `scripts/orchestra-project.mjs`
- Modify: `tests/runtime/runtime-manifest.test.mjs`, `tests/installers/self-contained-runtime.test.mjs`
- Create: `tests/installers/delegation-project-runtime.test.mjs`
- Modify provider manifests only if required for discovery/preservation; never make either provider manifest own `.orchestra/runtime/delegation/**`.

**Packaging contract:**
- Add fourth canonical manifest name `delegation`, independently managed at `.orchestra/state/runtimes/delegation.json` / `.orchestra/state/runtime-management/delegation/**`.
- Preserve source-relative imports by mirroring source layout inside the neutral root: canonical `core/**` -> `.orchestra/runtime/delegation/core/**`; required provider delegation source -> `.orchestra/runtime/delegation/providers/<provider>/**`; `runtime/delegation/**` -> `.orchestra/runtime/delegation/runtime/delegation/**`; raw schemas are placed where the mirrored Core expects them. Stable installed entrypoint for this plan is `.orchestra/runtime/delegation/runtime/delegation/cli.mjs`.
- In Milestone 1, package only the available AGY delegation executor/catalog. Task 9 adds the Codex executor/catalog to the same manifest. Do not create a production stub merely to make symmetry tests pass early.
- Never copy `.codex/**`, `.agents/**`, provider hooks/session/control-plane trees.
- Provider install/update CLIs ensure the independent delegation runtime is current before advertising readiness; report provider-runtime and delegation-runtime operations separately. Neutral runtime replacement is denied while a record is in flight. Provider rollback does not implicitly rollback the shared delegation runtime.

- [ ] **Step 1: RED manifest/install tests** — `delegation` loads/builds/checks; M1 image has neutral broker/Core + AGY executor only and no provider runtime trees; fresh provider installs can ensure neutral runtime; second provider install is idempotent/no ownership collision; updates preserve other runtime and delegation records.
- [ ] **Step 2: Confirm RED** — runtime-manifest + delegation-project-runtime + self-contained tests.
- [ ] **Step 3: Implement manifest/wrapper** — prefer complete Core mirror over fragile partial dependency list; preserve source-relative installed layout.
- [ ] **Step 4: Integrate source installer CLIs** — build provider and delegation independently; explicit JSON status for both.
- [ ] **Step 5: Verify/commit** — `npm run build:runtimes && npm run check:runtimes`; focused installer/runtime tests; `feat(runtime): package neutral delegation broker`.

---

### Task 7: Expose governed Codex control-plane delegation

**Files:**
- Create: `runtimes/codex/.codex/astra-orchestra/cross-provider-delegation.mjs`
- Modify: Codex `routing-policy.mjs`, `INSTRUCTIONS.md`, `routing-policy.test.mjs`
- Modify: `tests/provider-contract/routing-facade.test.mjs`

**Interfaces:**
- Provider-local helper builds canonical request from factual Codex actor/task state + an existing `ImplementationPacket`; no AGY imports/flags/models.
- It supplies real provider identities/capabilities to generic `selectDelegationTarget()` and invokes installed neutral CLI `.orchestra/runtime/delegation/runtime/delegation/cli.mjs`, never the AGY executor directly.
- Explicit `SECOND_OPINION` and bounded Codex → AGY PoC supported; normal implementation remains local.

- [ ] **Step 1: RED Codex integration tests** — factual source actor/task/fingerprint/revision; no foreign imports/model IDs; noncritical work stays local; one explicit second opinion request returns broker result to CONTROL without self-acceptance.
- [ ] **Step 2: Confirm RED** — `npm run test:codex` + provider facade test.
- [ ] **Step 3: Implement thin adapter/instructions** — preserve same-provider profiles except Task 8 critical review change.
- [ ] **Step 4: Verify/commit** — Codex/firewall/contamination/delegation suites; `feat(codex): expose cross-provider delegation`.

---

## Milestone 2 — Governed automatic independent critical review

### Task 8: Integrate conservative critical-review routing in both control planes

**Files:**
- Modify: Codex cross-provider helper/routing/instructions/tests.
- Create: `runtimes/antigravity/.agents/skills/orchestra/cross-provider-delegation.mjs`
- Modify: Antigravity routing policy/tests, `GEMINI.md`, and `pre-tool-enforce.mjs` only as needed to authorize the neutral delegation CLI as bounded CONTROL-plane process execution.
- Modify: `tests/provider-contract/routing-facade.test.mjs`, `tests/delegation/delegation-routing.test.mjs`, relevant turn-economy assertions.

**Behavior:**
- `CRITICAL_REVIEWER` + healthy independent candidate -> one cross-provider delegation.
- Codex-produced candidate -> AGY critical reviewer.
- AGY-produced candidate -> Codex target is selected generically; before Task 9, discovery reports unavailable rather than falling back. Task 9 makes this path executable without changing Core contracts.
- Existing AGY local Two-Key review remains a local capability only after a new explicit CONTROL decision; it is never broker fallback.

- [ ] **Step 1: RED routing tests** — critical independent route, unavailable returns to CONTROL, normal review/quick audit local, implementation/investigation local, budget blocks fan-out, result stays claim-only.
- [ ] **Step 2: RED AGY hook/turn tests** — neutral CLI allowed only for factual CONTROL delegation; no generalized shell/network/write authority; terminal-delegation discipline uses no polling/watchdog.
- [ ] **Step 3: Implement provider-local request adapters/routing instructions** — real provider identities stay outside Core.
- [ ] **Step 4: Verify/commit** — Codex/AGY/hooks/delegation/provider-facade/turn-economy; `feat(routing): cross providers for critical review`.

---

## Milestone 3 — AGY → Codex symmetry

### Task 9: Add Codex executor and prove reverse-path symmetry

**Files:**
- Create: `providers/codex/delegation-executor.mjs`
- Create: `tests/delegation/codex-executor.test.mjs`
- Modify: `tests/delegation/broker.test.mjs`
- Modify: `runtime/manifests/delegation.json`
- Modify: `tests/installers/delegation-project-runtime.test.mjs`
- Reuse: `providers/codex/model-catalog.mjs`

**Interfaces:**
- `createCodexDelegationExecutor({ runProcess = runBoundedProcess }) -> { provider: 'codex', discover(), execute(context) }`.
- `discover()` inspects `codex` version/`exec --help` for noninteractive/sandbox/structured-output support without inference.
- `execute()` uses provider-local catalog and `codex exec` with disposable-worktree sandbox, no interactive approval, Worker Envelope on stdin, executor-created bounded output schema, bounded last-message/result file; strict validate one report. Physical worktree dirtiness is discarded and never equals logical mutation authority.

- [ ] **Step 1: RED executor tests** — discovery; noninteractive/sandbox/no-approval/model/reasoning/output-schema/result-file construction; no lease/full request leakage; timeout/nonzero/malformed mappings.
- [ ] **Step 2: RED symmetry tests** — AGY -> Codex uses unchanged request/result/workspace/broker APIs; if reverse path needs provider-specific Core fields, fix abstraction instead of adding them.
- [ ] **Step 3: Implement/register Codex executor only in neutral composition root; extend neutral manifest to mirror `providers/codex/**` executor/catalog while keeping provider runtimes pure.**
- [ ] **Step 4: Verify/commit** — delegation + provider/firewall/contamination + neutral-runtime self-contained tests; `feat(delegation): add Codex external executor`.

---

### Task 10: Add Doctor, final firewall invariants, docs, and regression gate

**Files:**
- Create: `runtime/delegation/discovery.mjs`
- Modify: `runtime/doctor.mjs`, `tests/runtime/doctor.test.mjs`
- Modify: `scripts/contamination-check.mjs`
- Modify: `tests/cross-runtime/cross-runtime-firewall.test.mjs`, `tests/cross-runtime/core-provider-firewall.test.mjs`
- Modify: `package.json`
- Modify: `docs/architecture.md`, `docs/routing.md`, `docs/efficiency.md`, `docs/project-runtime.md`
- Modify: provider READMEs; root README only if public feature surface belongs there.

**Interfaces:**
- `inspectDelegationCapabilities({ runProcess }) -> { status: 'READY'|'DEGRADED'|'UNAVAILABLE', gitWorktree, providers }`.
- Discovery checks binary/version/help + Git worktree only; never install/login/inference.
- Doctor reports delegation readiness separately from structural repository health. Optional CLI absence does not make `healthy=false`.
- `package.json` adds `test:delegation` and includes it in full `npm test`.

- [ ] **Step 1: RED Doctor/firewall tests** — READY/DEGRADED/UNAVAILABLE with fake capabilities; healthy repo stays healthy when optional provider absent; existing Core/runtime firewalls remain; only `runtime/delegation/**` may compose both delegation executors; `.codex/**`/`.agents/**` stay provider-pure; neutral runtime contains no provider hook/session/control-plane trees.
- [ ] **Step 2: Confirm RED** — `node --test tests/runtime/doctor.test.mjs tests/cross-runtime/*.test.mjs`.
- [ ] **Step 3: Implement Doctor/discovery/firewall/docs** — do not weaken provider-import scanning globally; add a narrow neutral composition-root rule. Document dirty-source fail-closed, prerequisites, routing conservatism, failure taxonomy, optional live smoke.
- [ ] **Step 4: Focused verification** — `npm run build:schemas && npm run check:schemas`; `npm run build:runtimes && npm run check:runtimes`; `npm run test:delegation`; provider/hooks/firewall/installers/turn-economy; contamination.
- [ ] **Step 5: Full gate** — `npm test`; `npm run doctor`; `git diff --check`. Optional provider absence may report DEGRADED/UNAVAILABLE but not structural failure.
- [ ] **Step 6: Optional operator-only live smoke** — clean disposable fixture, both CLIs installed/authenticated, explicit operator intent; one Codex -> AGY and one AGY -> Codex `SECOND_OPINION`; verify canonical checkout unchanged, worktrees cleaned, bounded records/provenance, no auto-promotion. Record tokens/cost only if factually supplied.
- [ ] **Step 7: Commit** — `feat(orchestra): complete cross-provider delegation`.

---

## Completion Gate

Complete only when:

- canonical delegation schemas/standalone validators are green;
- Codex -> AGY and AGY -> Codex use one unchanged request/result/workspace/broker contract;
- all execution is externally isolated and dirty canonical state fails closed;
- authority never exceeds `LOCAL_READ + PROCESS_EXEC`, and inference transport never becomes worker network authority;
- no result self-promotes into Evidence/Candidate/Acceptance/Work Lease authority;
- only independent critical review auto-crosses; explicit second opinion works; normal implementation/investigation/quick audit remain local;
- unavailable provider never silently falls back;
- independent neutral runtime is deterministic/self-contained, grows from AGY executor in M1 to both executors in M3, and coexists without ownership collisions;
- `.codex/**` and `.agents/**` remain provider-pure; only neutral composition root knows both executors;
- Doctor checks capability without install/auth/inference and keeps healthy single-provider use healthy;
- full regression, Doctor, runtime build checks, contamination/firewall, installers, and turn-economy suites pass.
