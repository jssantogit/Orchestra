# Parallel Implementation 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix Antigravity 1.3.5 capability discovery and add a bounded `PARALLEL_IMPLEMENTATION_2` lane where CONTROL can run exactly two isolated implementation workers against one immutable source baseline, atomically compose their disjoint deltas, and promote one Composite Mutation Artifact without transferring project authority.

**Architecture:** Preserve all v1.2.0 standalone delegation semantics and build parallel implementation as a separate provider-neutral group lifecycle. Two members run concurrently in hardened `EPHEMERAL_CLONE` workspaces, each seals a normal broker-derived mutation artifact, then Orchestra revalidates both and composes them in a third hardened clone into one composite artifact that CONTROL alone may inspect, promote, or discard. Same-provider implementation is never enabled for ordinary v2 requests; it is authorized only by the parallel-group contract and lifecycle.

**Tech Stack:** Node.js ESM, `node:test`, JSON Schema 2020-12 + generated AJV standalone validators, Git hardened local clones and binary/full-index patches, SHA-256 mutation digests, Orchestra Work Lease generation fencing, Codex CLI, Antigravity `agy` CLI, runtime manifests/installers/Doctor, GitHub Actions CI.

**Spec:** `docs/superpowers/specs/2026-10-15-parallel-implementation-2-design.md`

**Baseline:** Orchestra `v1.2.0`, `main` at `879db4df6cbf067f2536a82f62a2cf287f3fe19f`; implementation branch `feat/parallel-implementation-2`.

## Global Constraints

- `PARALLEL_IMPLEMENTATION_2` means exactly two implementation members; no N-worker generalization in this release.
- Both members share exact `taskId`, Work Lease generation, source revision, product fingerprint, and canonical Git boundary.
- Both workers run in independent hardened `EPHEMERAL_CLONE` workspaces; no worker writes the canonical checkout.
- Mutation scopes must be provably disjoint before dispatch and factual changed paths must be disjoint after sealing.
- Member target providers are distinct for v1 of this feature; the intended lane is one same-provider worker plus one other installed provider.
- Standalone v2 remains cross-provider-only and unchanged: a normal `authorizeDelegationRequest()` still denies `target.provider === source.provider`.
- Same-provider implementation may be authorized only by a validated parallel-group lifecycle; it must not be representable by ordinary v2 request fields or CLI flags.
- Existing v1 review semantics are unchanged.
- Existing mutation-scope grammar remains exact paths plus terminal `/**`, with `**` as whole-product wildcard; mandatory forbidden `.git/**` and `.orchestra/state/**` remain authoritative.
- Worker reports never define changed paths, patch bytes, mutation digest, overlap, or composition success; those are broker-derived facts.
- Group execution is atomic from the canonical workspace perspective. One member failure, scope overlap, factual overlap, tamper, composition failure, stale baseline, or authority mismatch means no canonical product mutation.
- Member artifacts bound to a live/completed group are not individually promotable.
- Composite promotion preserves pre-existing canonical staged, unstaged, and untracked state and does not synthesize Candidate, Evidence, Acceptance, publication, or finish authority.
- Cross-provider budget `limit=1` is not globally increased; parallel groups have a separate exact two-member reservation.
- No silent fallback from failed parallel execution to serial/manual implementation.
- CI and deterministic tests must not require live provider accounts; provider calls are exercised through fake process runners. Optional live smoke is operator-only.
- Tsuzuki is not modified by this plan. Runtime synchronization into Tsuzuki happens only after a released Orchestra version passes the normal release train.
- Do not manually choose or bump a release version during feature implementation.

## Review Focus

- **One member succeeds while the other fails late:** completed member state must never become individually promotable and canonical workspace must remain byte-for-byte at the source baseline — pinned by Tasks 4 and 6.
- **Scopes appear different but overlap after normalization:** parent/subtree, exact/subtree, `**`, repeated `./`, or lexical aliases must fail before any worker process starts — pinned by Task 2.
- **Promised scopes are disjoint but factual changed paths overlap:** composition must fail closed using broker-derived member facts, not the pre-dispatch promise — pinned by Task 5.
- **Canonical repository is dirty before the group begins:** both workers and the composition clone must share the same synthetic baseline containing the exact staged/unstaged/untracked source snapshot, while final promotion preserves the pre-existing index — pinned by Tasks 4, 5, and 6.
- **Same-provider privilege leaks outside the parallel lane:** standalone v2 and ordinary CLI calls must continue returning capability denial, while only a validated parallel group can execute the same-provider member — pinned by Tasks 2, 4, and 7.

---

## File Structure

### Compatibility hotfix
- `providers/antigravity/delegation-executor.mjs` — treat bounded help output from stdout and stderr symmetrically while preserving fail-closed discovery.
- `tests/delegation/antigravity-executor.test.mjs` — AGY 1.3.5 stderr-help regression and truncation cases.

### Parallel contracts and core policy
- Create `schemas/parallel-implementation-group.v1.schema.json` — exact two-member group contract.
- Create `core/domain/parallel-implementation.mjs` — schema validation/assertion and immutable group normalization.
- Create `core/delegation/parallel-scope.mjs` — conservative scope intersection proof and factual changed-path disjointness.
- Modify `scripts/build-schema-validators.mjs`, `core/schema/validator.mjs`, generated validator output, and core schema tests.

### Parallel state and execution lifecycle
- Create `runtime/delegation/parallel-group-store.mjs` — safe durable group state under `.orchestra/state/delegation/parallel-groups/<groupId>/`.
- Create `runtime/delegation/parallel-broker.mjs` — validates authority/group, discovers both providers, prepares both clones, dispatches concurrently, seals both members, and coordinates failure cleanup/composition.
- Reuse `runtime/delegation/mutable-workspace.mjs`, `artifact-lifecycle.mjs`, provider executors, source snapshot, Git boundary, and process environment.
- Modify `runtime/delegation/artifact-store.mjs` / `artifact-lifecycle.mjs` only to bind member artifacts to a group and make bound members non-promotable.

### Composition and composite lifecycle
- Create `runtime/delegation/composition-workspace.mjs` — third hardened clone at the same synthetic baseline and deterministic member patch application.
- Create `runtime/delegation/composite-artifact-store.mjs` — distinct composite manifest/patch storage.
- Create `runtime/delegation/composite-artifact-lifecycle.mjs` — seal/revalidate/inspect/promote/discard composite artifact.
- Create `runtime/delegation/parallel-cli.mjs` — neutral group execution and composite inspect/promote/discard entrypoint; delegated worker recursion remains denied.

### Provider control planes and Direct Work routing
- Modify `runtimes/codex/.codex/astra-orchestra/cross-provider-delegation.mjs` and Antigravity counterpart to build/execute parallel groups through the neutral runtime.
- Modify provider Direct Work routing/instructions only enough to expose an explicit `SERIAL | PARALLEL_2` implementation decision after CONTROL has already decomposed two bounded shards.
- Keep exploration `PARALLELISM` completely separate.

### Doctor, packaging, docs
- Modify `runtime/delegation/discovery.mjs` and `runtime/doctor.mjs` to report `parallelImplementation` readiness separately from review/ordinary implementation readiness.
- Modify `runtime/manifests/delegation.json` preserved paths/entrypoints as required; neutral runtime continues to own all parallel lifecycle files.
- Update architecture/provider/efficiency docs and generated runtimes; extend installer, firewall, contamination, runtime-core, and release-readiness tests.

---

### Task 0: Fix AGY 1.3.5 stderr help discovery

**Files:**
- Modify: `providers/antigravity/delegation-executor.mjs`
- Modify: `tests/delegation/antigravity-executor.test.mjs`

**Interfaces:**
- Existing public interface `createAntigravityDelegationExecutor({ runProcess }).discover()` remains unchanged.
- Discovery help text is the bounded concatenation of `helpResult.stdout` and `helpResult.stderr` after timeout/exit/truncation validation.
- Required flags stay `--print`, `--print-timeout`, `--sandbox`, `--model`; `--mode` remains the sole factual signal for `capabilities.implementation`.

- [ ] **Step 1: Add RED regression `AGY discovery accepts required help flags emitted entirely on stderr`** — fake `--version` returns `agy 1.3.5` on stdout; fake `--help` returns stdout empty and all required flags plus `--mode` on stderr; expect `available=true` and `implementation=true`.
- [ ] **Step 2: Add RED mixed-stream and stderr-truncation cases** — split flags across stdout/stderr and expect success; `stderrTruncated=true` must return exact `PROVIDER_UNAVAILABLE`; retain existing stdout truncation/nonzero/timeout failures.
- [ ] **Step 3: Run RED** — `node --test tests/delegation/antigravity-executor.test.mjs`; expected new stderr-help test FAIL on v1.2.0 behavior.
- [ ] **Step 4: Implement the minimal discovery change** — reject `helpResult.stdoutTruncated || helpResult.stderrTruncated`, then compute `const help = `${helpResult.stdout ?? ""}\n${helpResult.stderr ?? ""}`; do not change execution arguments or environment.
- [ ] **Step 5: Run GREEN** — focused test plus `node --test tests/delegation/provider-executors-v2.test.mjs tests/delegation/provider-environment.test.mjs`.
- [ ] **Step 6: Commit** — `fix(delegation): discover AGY help from stderr`.

---

### Task 1: Add exact Parallel Implementation Group schema and validation

**Files:**
- Create: `schemas/parallel-implementation-group.v1.schema.json`
- Create: `core/domain/parallel-implementation.mjs`
- Modify: `scripts/build-schema-validators.mjs`
- Modify: `core/schema/validator.mjs`
- Create: `tests/delegation/parallel-group-contract.test.mjs`
- Modify: `tests/core/schema-validation.test.mjs`
- Modify: `tests/core/schema-standalone-runtime.test.mjs`
- Regenerate: `core/schema/generated/parallel-implementation-group.v1.mjs`

**Interfaces:**
- `validateParallelImplementationGroup(value) -> { valid, errors }`.
- `assertParallelImplementationGroup(value) -> value` throws `PARALLEL_IMPLEMENTATION_GROUP_INVALID` on any invalid contract.
- Group schema requires: `schema`, `groupId`, `taskId`, `generation`, `source`, `sourceRevision`, `sourceFingerprint`, `canonicalGitFingerprint`, `members`.
- `members` has exactly 2 entries; member IDs and target providers are unique; each member contains `memberId`, `targetProvider`, `packet`, and `mutationScope`.
- Each packet has group `taskId` and `candidateGeneration === generation`.

- [ ] **Step 1: Write RED contract tests** — valid Codex+Antigravity group; reject one/three members, duplicate IDs/providers, mismatched task/generation, missing baseline facts, invalid packet/scope, extra properties.
- [ ] **Step 2: Add Review Focus authority facts** — source provider/actor required; member target may equal source provider but members must be distinct from each other; group itself does not carry mutable CONTROL capabilities.
- [ ] **Step 3: Run RED** — `node --test tests/delegation/parallel-group-contract.test.mjs tests/core/schema-validation.test.mjs tests/core/schema-standalone-runtime.test.mjs`.
- [ ] **Step 4: Implement schema/domain dispatch and regenerate validators** — no provider-specific names in `core/**`.
- [ ] **Step 5: Run GREEN** — focused tests + `npm run check:schemas`.
- [ ] **Step 6: Commit** — `feat(delegation): add parallel implementation group contract`.

---

### Task 2: Prove mutation-scope independence and keep standalone v2 closed

**Files:**
- Create: `core/delegation/parallel-scope.mjs`
- Modify: `core/delegation/mutation-scope.mjs` only if a small exported normalized-pattern helper is needed; do not change existing matching semantics.
- Create: `tests/delegation/parallel-scope.test.mjs`
- Modify: `tests/delegation/delegation-v2-policy.test.mjs`

**Interfaces:**
- `assessParallelScopeIndependence(leftScope, rightScope) -> { independent, overlaps[] }` normalizes both scopes and conservatively proves writable allowed-path disjointness.
- `assessChangedPathIndependence(leftPaths, rightPaths) -> { independent, overlaps[] }` accepts factual repo-relative paths only and returns sorted exact intersections.
- Standalone `authorizeDelegationRequest()` signature/behavior does not gain a same-provider escape hatch.

- [ ] **Step 1: Write RED scope tests** — accept `app/home/**` vs `app/library/**`, exact file vs different exact file, cross-tree paths; reject `app/**` vs `app/src/**`, exact inside subtree, `**` vs anything, equal normalized paths, invalid traversal/absolute patterns.
- [ ] **Step 2: Write RED factual overlap tests** — exact intersection rejected even when original scopes were disjoint; duplicate input facts normalize deterministically; invalid changed path fails closed.
- [ ] **Step 3: Add regression that standalone same-provider v2 is still denied** — both Codex→Codex and Antigravity→Antigravity ordinary requests remain `CAPABILITY_DENIED`.
- [ ] **Step 4: Run RED** — `node --test tests/delegation/parallel-scope.test.mjs tests/delegation/delegation-v2-policy.test.mjs`.
- [ ] **Step 5: Implement conservative prefix/exact overlap proof using existing mutation-scope grammar**.
- [ ] **Step 6: Run GREEN** — focused tests + `npm run test:delegation`.
- [ ] **Step 7: Commit** — `feat(delegation): prove parallel mutation scopes are independent`.

---

### Task 3: Persist group lifecycle and bind member artifacts

**Files:**
- Create: `runtime/delegation/parallel-group-store.mjs`
- Modify: `runtime/delegation/artifact-store.mjs`
- Modify: `runtime/delegation/artifact-lifecycle.mjs`
- Create: `tests/delegation/parallel-group-store.test.mjs`
- Create: `tests/delegation/parallel-member-artifact.test.mjs`

**Interfaces:**
- Group state root: `.orchestra/state/delegation/parallel-groups/<groupId>/group.json`.
- States: `CREATED | RUNNING | MEMBERS_READY | COMPOSING | READY_FOR_REVIEW | FAILED | PROMOTED | DISCARDED` with allowed forward transitions only.
- `createParallelGroup(repoRoot, group)`, `readParallelGroup(repoRoot, groupId)`, `transitionParallelGroupState(repoRoot, groupId, transition)` use safe IDs and atomic replace semantics.
- Ordinary mutation artifact manifest gains optional `parallelGroupId` and `parallelMemberId` together; bound member state gains `CONSUMED` as a terminal non-promotable state.
- `promoteDelegationArtifact()` returns `CAPABILITY_DENIED` for any artifact bound to a parallel group; only the composite lifecycle may consume it.

- [ ] **Step 1: Write RED store tests** — safe IDs/path traversal, atomic creation, exact state transitions, malformed state rejection, duplicate group creation, no transcript/prompt/reasoning persistence.
- [ ] **Step 2: Write RED member binding tests** — bound artifact validates only with both group/member IDs; direct ordinary promotion denied; ordinary unbound v2 promotion remains unchanged.
- [ ] **Step 3: Add cleanup/recovery state tests** — failed groups retain only explicitly recoverable workspace paths and never report READY member artifact as independently promotable.
- [ ] **Step 4: Run RED** — focused group/member artifact tests plus existing artifact store/lifecycle tests.
- [ ] **Step 5: Implement minimal group store and optional artifact binding without changing unbound artifact schema semantics**.
- [ ] **Step 6: Run GREEN** — focused tests + existing `artifact-*.test.mjs`.
- [ ] **Step 7: Commit** — `feat(delegation): bind implementation artifacts to parallel groups`.

---

### Task 4: Execute two implementation members concurrently from one exact baseline

**Files:**
- Create: `runtime/delegation/parallel-broker.mjs`
- Modify: `runtime/delegation/broker.mjs` only to extract/reuse an implementation-member primitive if required; ordinary `executeDelegation()` public behavior remains unchanged.
- Modify: `runtime/delegation/source-snapshot.mjs` / `mutable-workspace.mjs` only if necessary to accept a prevalidated shared source identity without rereading a changed canonical baseline.
- Create: `tests/delegation/parallel-broker.test.mjs`
- Create: `tests/delegation/parallel-broker-baseline.test.mjs`

**Interfaces:**
- `executeParallelImplementationGroup({ repoRoot, group, actor, executors }) -> Promise<{ status, reason?, groupId, members, compositeArtifact? }>`.
- The function requires root CONTROL actor matching group source and current Work Lease generation before any worker starts.
- It proves pre-dispatch scope independence, discovers both exact target providers, prepares two independent mutable clones from the same validated source snapshot, and starts both executor promises before awaiting completion.
- Internal `authorizeParallelMember({ group, member, actor, sourceFingerprint })` permits a member whose target equals source provider only after the full group contract/authority/baseline/scope checks; it is not exported through ordinary delegation CLI.

- [ ] **Step 1: Write RED concurrency test** — two fake executors block on barriers; assert both `execute()` calls started before either is released; each receives a different clone path but identical source revision/fingerprint/synthetic snapshot facts.
- [ ] **Step 2: Write RED same-provider group test** — Codex CONTROL may run Codex member + Antigravity member; Antigravity CONTROL may run Antigravity member + Codex member; standalone same-provider remains denied from Task 2.
- [ ] **Step 3: Write RED atomic failure tests** — unavailable/timeout/invalid result/scope violation of either member closes group `FAILED`, cleans both attributable clones when possible, returns no composite, and leaves canonical product/Git unchanged.
- [ ] **Step 4: Add dirty baseline test** — pre-existing staged/unstaged/untracked canonical state appears identically in both synthetic baselines and neither member artifact contains it as worker delta.
- [ ] **Step 5: Run RED** — focused parallel broker tests.
- [ ] **Step 6: Implement concurrent preparation/execution/sealing by reusing v1.2.0 hardened mutable workspace and factual artifact sealing** — do not add a second provider executor implementation.
- [ ] **Step 7: Run GREEN** — focused tests + existing broker/provider-v2/mutable-workspace suites.
- [ ] **Step 8: Commit** — `feat(delegation): execute two isolated implementation members`.

---

### Task 5: Compose two sealed member deltas into one Composite Mutation Artifact

**Files:**
- Create: `runtime/delegation/composition-workspace.mjs`
- Create: `runtime/delegation/composite-artifact-store.mjs`
- Create: `runtime/delegation/composite-artifact-lifecycle.mjs`
- Modify: `runtime/delegation/parallel-broker.mjs`
- Create: `tests/delegation/parallel-composition.test.mjs`
- Create: `tests/delegation/composite-artifact-store.test.mjs`

**Interfaces:**
- Composite state root: `.orchestra/state/delegation/composite-artifacts/<artifactId>/{manifest.json,candidate.patch}`.
- `composeParallelArtifacts({ repoRoot, group, memberArtifactIds }) -> Promise<{ artifactId, changedPaths, patchSha256, mutationDigest, state: "READY_FOR_REVIEW" }>`.
- `prepareCompositionWorkspace(...)` creates a fresh hardened clone from the same exact source snapshot, never from member workspaces.
- Composite manifest schema string: `orchestra.parallel-composite-artifact.v1`; it records `groupId`, source/generation/Git facts, exactly two member artifact IDs, combined factual changed paths, patch hash/digest, retained review path, state.

- [ ] **Step 1: Write RED store integrity tests** — safe IDs, exact two members, malformed/tampered patch hash rejection, immutable source/group facts, READY artifact retains review path.
- [ ] **Step 2: Write RED successful composition tests** — disjoint text+text, text+binary, create+delete, executable mode, contained symlink; apply members in deterministic member-ID order and derive one binary/full-index patch from original synthetic baseline.
- [ ] **Step 3: Write RED overlap/conflict tests** — factual changed-path intersection fails before patch application; patch apply conflict fails closed even when paths differ; combined facts must equal sorted union of member facts.
- [ ] **Step 4: Add tamper tests** — changed member patch/manifest/review workspace after sealing returns artifact-tampered failure and no composite.
- [ ] **Step 5: Run RED** — composite store/composition tests.
- [ ] **Step 6: Implement composition using existing Git boundary, artifact integrity, mutation-fact, hook/protocol isolation primitives**.
- [ ] **Step 7: After durable composite seal, transition member artifacts to `CONSUMED` and group to `READY_FOR_REVIEW`; cleanup member clones with recoverable cleanup facts**.
- [ ] **Step 8: Run GREEN** — focused composition tests + artifact/mutable-workspace regression.
- [ ] **Step 9: Commit** — `feat(delegation): compose parallel worker artifacts atomically`.

---

### Task 6: Add CONTROL-owned composite inspect, promote, discard, locking, and rollback

**Files:**
- Modify: `runtime/delegation/composite-artifact-lifecycle.mjs`
- Create: `runtime/delegation/parallel-cli.mjs`
- Modify: `runtime/delegation/parallel-group-store.mjs`
- Create: `tests/delegation/composite-artifact-lifecycle.test.mjs`
- Create: `tests/delegation/parallel-cli.test.mjs`
- Modify: `tests/runtime/delegation-recovery-doctor.test.mjs` later only for lifecycle recovery expectations shared with Task 8.

**Interfaces:**
- `inspectCompositeArtifact({ repoRoot, artifactId })` revalidates patch hash, retained review workspace, combined mutation digest, group/member identities and states.
- `promoteCompositeArtifact({ repoRoot, artifactId, generation, actor }) -> { promoted, reason, changedPaths }` uses the existing global promotion lock + Work Lease claim fence, exact source/product/Git baseline, `git apply --check`, working-tree-only apply, post-apply factual digest verification, canonical index preservation, rollback on verification/state-transition failure.
- `discardCompositeArtifact(...)` is authority-fenced and cleans composition/member retained workspaces without product mutation.
- `parallel-cli.mjs` supports `execute`, `inspect`, `promote`, `discard`; any delegated context (`ORCHESTRA_DELEGATION_ACTIVE=1` or depth >=1) is rejected.

- [ ] **Step 1: Write RED authority/stale tests** — wrong actor/provider/generation denied; changed Work Lease generation, canonical product drift, Git refs/config/hooks drift return stale/capability failure before mutation.
- [ ] **Step 2: Write RED dirty canonical promotion test** — pre-existing staged patch remains byte-identical; unrelated unstaged/untracked state survives; only composite delta is added to working tree.
- [ ] **Step 3: Write RED rollback/locking tests** — concurrent promotion loses lock; forced post-apply digest/state-transition failure restores exact source fingerprint/index; no partial promoted state.
- [ ] **Step 4: Write RED CLI recursion and argument tests** — strict bounded flags, safe IDs, delegated worker cannot invoke lifecycle, execute cannot be forged with arbitrary same-provider standalone request.
- [ ] **Step 5: Run RED** — focused lifecycle/CLI tests.
- [ ] **Step 6: Implement by factoring shared promotion helpers from `artifact-lifecycle.mjs` only where it removes duplication without changing ordinary v2 behavior**.
- [ ] **Step 7: Run GREEN** — focused tests + existing artifact CLI/promotion tests.
- [ ] **Step 8: Commit** — `feat(delegation): promote composite artifacts under control authority`.

---

### Task 7: Expose provider-symmetric parallel control-plane builders and explicit routing

**Files:**
- Modify: `runtimes/codex/.codex/astra-orchestra/cross-provider-delegation.mjs`
- Modify: `runtimes/antigravity/.agents/skills/orchestra/cross-provider-delegation.mjs`
- Modify: `runtimes/codex/.codex/astra-orchestra/direct-work-routing.mjs`
- Modify: `runtimes/antigravity/.agents/skills/orchestra/direct-work-routing.mjs`
- Modify provider instructions/docs only as required to document the new explicit decision.
- Modify: `tests/delegation/codex-control-plane-delegation.test.mjs`
- Modify: `tests/delegation/antigravity-control-plane-delegation.test.mjs`
- Create: `tests/direct-work/parallel-implementation-routing.test.mjs`
- Modify provider routing parity tests.

**Interfaces:**
- Provider builders construct the same neutral `orchestra.parallel-implementation-group.v1` contract from two already-resolved Implementation Packets/scopes and invoke installed neutral `parallel-cli.mjs`.
- Provider helpers expose `execute*ParallelImplementation`, `inspect*CompositeArtifact`, `promote*CompositeArtifact`, `discard*CompositeArtifact` with provider-local source identity only.
- Direct Work metadata gains explicit implementation parallel decision `SERIAL | PARALLEL_2`; default remains `SERIAL` and existing `primaryWorkerCount` remains 1 unless CONTROL explicitly supplies two independent resolved workstreams.
- The new decision is separate from Dream/Milestone-K exploration `PARALLELISM`.

- [ ] **Step 1: Write RED provider symmetry tests** — Codex CONTROL builds Codex+AGY group; AGY CONTROL builds AGY+Codex group; exact neutral contract parity; no concrete sibling-provider source code imported into provider runtime.
- [ ] **Step 2: Write RED routing tests** — serial remains default; two providers alone never trigger parallelism; `PARALLEL_2` requires two resolved bounded shards with explicit mutation scopes; unresolved diagnosis/overlap returns CONTROL/serial, never speculative fanout.
- [ ] **Step 3: Add no-fallback tests** — provider unavailable or parallel group failure returns explicit failure to CONTROL; no automatic serial/manual mutation.
- [ ] **Step 4: Run RED** — provider control-plane + new routing tests.
- [ ] **Step 5: Implement thin provider wrappers and routing metadata; all lifecycle logic stays neutral**.
- [ ] **Step 6: Run GREEN** — focused tests + `npm run test:direct-work` + provider routing tests.
- [ ] **Step 7: Commit** — `feat(routing): expose bounded parallel implementation lane`.

---

### Task 8: Doctor, packaging, docs, generated runtimes, and full regression

**Files:**
- Modify: `runtime/delegation/discovery.mjs`
- Modify: `runtime/doctor.mjs`
- Modify: `runtime/manifests/delegation.json`
- Modify: `tests/delegation/implementation-readiness.test.mjs`
- Modify: `tests/runtime/delegation-recovery-doctor.test.mjs`
- Modify: `tests/installers/delegation-project-runtime.test.mjs`
- Modify: `tests/installers/self-contained-runtime.test.mjs`
- Modify: `tests/cross-runtime/cross-runtime-firewall.test.mjs`
- Modify: `tests/cross-runtime/core-provider-firewall.test.mjs` if needed.
- Modify: `docs/architecture.md`, `docs/efficiency.md`, `docs/codex.md`, `docs/antigravity.md`, relevant runtime READMEs/instructions.
- Regenerate/sync runtime outputs through canonical scripts; do not hand-edit generated copies.

**Interfaces:**
- `inspectDelegationCapabilities()` gains `modes.parallelImplementation` with `status`, `isolation: "EPHEMERAL_CLONE"`, `memberCount: 2`, `artifactLifecycle: "CONTROL_OWNED_COMPOSITE"`.
- Parallel readiness is `READY` only when Git hardened clone support is available and exactly the two installed executors are implementation-capable; otherwise `DEGRADED/UNAVAILABLE` consistently with current readiness semantics.
- Doctor recovery reports READY composite artifacts as retained review state, not cleanup failures; failed cleanup paths remain explicit/recoverable.
- Delegation manifest preserves `.orchestra/state/delegation/parallel-groups` and `.orchestra/state/delegation/composite-artifacts` and exposes `parallel-cli.mjs` as a neutral entrypoint.

- [ ] **Step 1: Write RED readiness/Doctor tests** — AGY stderr-help now makes implementation/parallel readiness factual; one implementation-capable provider means ordinary implementation may be degraded but parallel is unavailable; both capable + hardened clone yields parallel READY.
- [ ] **Step 2: Write RED packaging/state-preservation tests** — new neutral files present in installed runtime; new state roots survive update; provider runtimes do not own/duplicate neutral lifecycle files; generated runtime check catches drift.
- [ ] **Step 3: Write RED firewall/contamination tests** — no Antigravity names in neutral core contracts/policy; provider helpers remain thin; parallel CLI/runtime not mirrored into sibling provider-specific trees except canonical shared runtime installation.
- [ ] **Step 4: Implement readiness, Doctor, manifest, docs; run `npm run build:schemas`, `npm run sync:runtime-core`, `npm run build:runtimes` as required by canonical generators**.
- [ ] **Step 5: Focused GREEN** — `npm run test:delegation && npm run test:direct-work && npm run test:runtime && npm run test:installers && npm run test:firewall`.
- [ ] **Step 6: Generated/architecture checks** — `npm run check:schemas && npm run check:runtime-core && npm run check:runtimes && npm run check:contamination && npm run doctor`.
- [ ] **Step 7: Full regression** — `npm test`; expected exit 0 with no skipped authority/security regressions introduced by this feature.
- [ ] **Step 8: Release readiness** — `npm run release:readiness`; no version bump or publication in this task.
- [ ] **Step 9: Review final diff specifically for standalone v1/v2 semantic drift, hidden same-provider escape hatches, partial-promotion paths, and generated-runtime contamination; fix any finding with focused regression coverage before final verification**.
- [ ] **Step 10: Commit** — `docs(runtime): ship parallel implementation readiness and guidance` (split generated/docs commit if repository conventions require it).

---

## Final Verification Gate

After all tasks are individually green:

- [ ] `npm run check:schemas`
- [ ] `npm run check:runtime-core`
- [ ] `npm run check:runtimes`
- [ ] `npm run check:contamination`
- [ ] `npm run test:delegation`
- [ ] `npm run test:direct-work`
- [ ] `npm run test:firewall`
- [ ] `npm run test:installers`
- [ ] `npm run doctor`
- [ ] `npm test`
- [ ] `npm run release:readiness`
- [ ] Push exact branch HEAD and require GitHub CI green on that exact SHA before asking for merge authorization.
- [ ] Do not merge, prepare a release, publish, or synchronize Tsuzuki without the operator's explicit next gate.
