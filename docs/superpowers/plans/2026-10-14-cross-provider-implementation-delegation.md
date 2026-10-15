# Cross-Provider Implementation Delegation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow Codex CONTROL and Antigravity CONTROL to explicitly delegate bounded primary implementation to the other provider, receive a sealed mutation artifact from an independently isolated clone, review it, and explicitly promote or discard it without transferring Orchestra authority.

**Architecture:** Preserve `DelegationRequest.v1` as the shipped read-only protocol and add implementation-only v2 request/result contracts. V2 executes in a hardened independent local clone, derives mutation facts from Git/filesystem state, seals the worker delta under project-owned state, retains the clone for review, and requires a separate CONTROL-owned promotion/discard action. The existing neutral delegation broker remains lifecycle owner; provider executors only run the worker and return bounded report/execution facts.

**Tech Stack:** Node.js ESM, `node:test`, JSON Schema 2020-12 with standalone AJV validators, local Git clones/patches, SHA-256 content digests, Orchestra Work Lease/project state, Codex CLI, Antigravity `agy` CLI, Orchestra runtime manifests/installers/Doctor.

**Spec:** `docs/superpowers/specs/2026-10-14-cross-provider-implementation-delegation-design.md`

**Baseline:** Orchestra `v1.1.0`, `main` at `927e92305803015f2946ec3314ae414ae4fc8b84`; implementation branch `hotfix/cross-provider-implementation-delegation`.

## Global Constraints

- `orchestra.delegation-request.v1` and `orchestra.delegation-result.v1` remain semantically read-only; v1 still authorizes exactly `LOCAL_READ + PROCESS_EXEC`, `mutation=FORBIDDEN`, `network=FORBIDDEN`, `mayDelegate=false`, `delegationDepth=1`, `EPHEMERAL_WORKTREE`.
- V2 is implementation-only: `logicalRole=IMPLEMENTER`, `purpose=IMPLEMENTATION`, capabilities exactly `LOCAL_READ + PROCESS_EXEC + WORKSPACE_EDIT`, `mutation=WORKSPACE_ONLY`, `network=FORBIDDEN`, `mayDelegate=false`, `delegationDepth=1`, `EPHEMERAL_CLONE`.
- Cross-provider implementation is explicit CONTROL intent only. Same-provider/local implementation remains the default; no provider failure may silently fall back to same-provider/manual work.
- Delegation never transfers Work Lease ownership, generation advancement, Candidate/Evidence promotion, Acceptance, release/publication, or recursive delegation authority.
- Mutable workers never run in the canonical checkout or linked worktree. The v2 clone is outside the checkout, uses `--no-hardlinks` or equivalent copy isolation, has no alternates/remotes, and receives isolated Git config plus remote protocol denial.
- Mutation scope is machine-enforced. Paths are repository-relative; reject absolute paths, `..` traversal, normalized egress, and unsupported pattern syntax. Mandatory forbidden scope includes `.git/**` and `.orchestra/state/**`.
- This plan standardizes mutation-scope grammar to exact repository-relative paths plus subtree patterns ending in `/**`; `**` is the only whole-product wildcard. No dependency is added for general globbing.
- The worker report is a bounded model claim. Changed paths, modes, link targets/content hashes, patch bytes, patch hash, mutation digest, clone identity, and canonical Git/workspace integrity are derived by Orchestra.
- Successful v2 execution produces a `READY_FOR_REVIEW` Mutation Artifact; it does not create or accept a Candidate/Evidence record.
- Promotion must preserve the canonical pre-existing staged/unstaged/untracked baseline. The worker patch is applied to the working tree only; Orchestra does not restage existing canonical changes.
- Promotion/discard require the original root CONTROL actor and generation; promotion also requires exact canonical source fingerprint, canonical Git boundary fingerprint, sealed clone patch hash/digest, scope validity, and `git apply --check`.
- Provider executor inference transport remains infrastructure, not worker network authority. Worker Git/network protocols remain denied independently of prompt text.
- Existing 1.1.0 hardening survives: dirty snapshot fidelity, symlink egress defense, no-hooks Git operations, refs/config/hooks protection, sanitized env, process-tree termination, recursion fence, neutral-only packaging, duplicate-install safety, forbidden worker-envelope paths, provider firewall/contamination rules.
- CI and deterministic tests do not require live provider accounts or inference. Provider executor tests use fake process runners. Optional live smoke remains operator-only.
- Do not change Tsuzuki in this plan. Do not bump package/release version; release/versioning is a later operator gate.

## Review Focus

- **Clone still has an indirect path to canonical Git**: a worker adding a local remote, using `file://`, inheriting global/system hooks/config, hardlinks, or alternates must not mutate canonical Git — pinned by Task 2 clone-isolation tests and Task 4 worker-environment tests.
- **Canonical workspace was already dirty/staged before delegation**: the synthetic baseline must absorb the pre-existing snapshot so the sealed patch and later promotion contain only worker delta and preserve canonical index state — pinned by Tasks 2, 3, and 6.
- **Worker mutates Git metadata instead of product files**: changed HEAD/refs/config/hooks or a staged index before broker sealing must fail closed and produce no artifact — pinned by Tasks 2 and 3.
- **Artifact changes after sealing or CONTROL changes canonical baseline**: promotion must return `ARTIFACT_TAMPERED` or `PROMOTION_STALE` before canonical product mutation — pinned by Task 6.
- **V2 privilege leaks into v1/routing/package surfaces**: v1 mutation stays denied, implementation stays local unless explicit cross-provider intent is set, and neutral packaging must not absorb provider control planes — pinned by Tasks 1, 7, and 8.

---

## File Structure

### New canonical contracts/core helpers
- `schemas/delegation-request.v2.schema.json` — implementation-only request schema.
- `schemas/delegation-result.v2.schema.json` — implementation result/artifact descriptor schema.
- `core/delegation/mutation-scope.mjs` — normalize/validate scope and authorize factual changed paths.

### Shared delegation runtime primitives
- `runtime/delegation/git-boundary.mjs` — reusable refs/config/hooks Git-boundary fingerprinting for canonical and delegated repositories.
- `runtime/delegation/source-snapshot.mjs` — reusable source identity + dirty/staged/unstaged/untracked snapshot materialization shared by v1 worktrees and v2 clones.
- `runtime/delegation/mutable-workspace.mjs` — hardened clone, synthetic baseline, worker Git environment, mutation inspection, exact-path cleanup.
- `runtime/delegation/artifact-store.mjs` — safe persistent Mutation Artifact manifest/patch state.
- `runtime/delegation/artifact-lifecycle.mjs` — sealing, integrity recheck, inspect/promote/discard state transitions.
- `runtime/delegation/artifact-cli.mjs` — neutral `inspect|promote|discard` entrypoint.

### Existing files that gain version-aware behavior
- `core/domain/delegation.mjs`, `core/delegation/policy.mjs`, `core/delegation/worker-envelope.mjs`, `core/routing/delegation-target.mjs`.
- `runtime/delegation/workspace.mjs`, `runtime/delegation/broker.mjs`, `runtime/delegation/store.mjs`, `runtime/delegation/process-environment.mjs`, `runtime/delegation/cli.mjs`.
- `providers/codex/delegation-executor.mjs`, `providers/antigravity/delegation-executor.mjs`.
- Provider control-plane `cross-provider-delegation.mjs` modules for Codex and Antigravity.
- `runtime/doctor.mjs`, `runtime/manifests/delegation.json`, generated runtime/core images and relevant installer/runtime tests.

---

### Task 1: Add v2 contracts, policy boundary, mutation-scope grammar, and explicit routing intent

**Files:**
- Create: `schemas/delegation-request.v2.schema.json`
- Create: `schemas/delegation-result.v2.schema.json`
- Create: `core/delegation/mutation-scope.mjs`
- Modify: `core/domain/delegation.mjs`
- Modify: `core/delegation/policy.mjs`
- Modify: `core/routing/delegation-target.mjs`
- Modify: `scripts/build-schema-validators.mjs`
- Modify: `core/schema/validator.mjs`
- Create: `tests/delegation/delegation-v2-contract.test.mjs`
- Create: `tests/delegation/delegation-v2-policy.test.mjs`
- Create: `tests/delegation/mutation-scope.test.mjs`
- Modify: `tests/delegation/delegation-policy.test.mjs`
- Modify: `tests/delegation/delegation-routing.test.mjs`
- Modify: `tests/core/schema-validation.test.mjs`
- Modify: `tests/core/schema-standalone-runtime.test.mjs`
- Regenerate: `core/schema/generated/delegation-request.v2.mjs`, `core/schema/generated/delegation-result.v2.mjs`

**Interfaces:**
- `DELEGATION_PURPOSES.IMPLEMENTATION = "IMPLEMENTATION"`; v1 schemas still reject it where not allowed, v2 requires it.
- `DELEGATION_FAILURE_REASONS` gains `SCOPE_VIOLATION`, `ARTIFACT_SEAL_FAILED`, `ARTIFACT_TAMPERED`, `PROMOTION_STALE`, `PROMOTION_FAILED`; v1 result schema continues to reject those reasons while v2 permits the implementation-specific subset.
- `validateDelegationRequest()` / `assertDelegationRequest()` dispatch strictly on `request.schema`; same for result v1/v2.
- `authorizeDelegationRequest(request, context)` is version-aware but keeps its public signature; v1 branch is behaviorally unchanged.
- `normalizeMutationScope({ allowedPaths, forbiddenPaths }) -> { allowedPaths, forbiddenPaths }` returns sorted normalized unique patterns and unions mandatory `.git/**`, `.orchestra/state/**`.
- `authorizeChangedPaths(changedPaths, normalizedScope) -> { allowed, violations[] }` uses exact path + terminal `/**` subtree semantics only.
- `selectDelegationTarget({... explicitCrossProvider = false })`: `IMPLEMENTER + IMPLEMENTATION` crosses only when `explicitCrossProvider === true`; otherwise same-provider default.

- [ ] **Step 1: Write RED v1/v2 schema and policy tests** — v1 still rejects `WORKSPACE_EDIT`, `IMPLEMENTATION`, `WORKSPACE_ONLY`, `EPHEMERAL_CLONE`, and v2-only failure reasons; v2 accepts only the exact implementation tuple and rejects extra/missing capabilities, network, recursion, wrong role/purpose/isolation.
- [ ] **Step 2: Write RED mutation-scope tests** — accept `src/file.mjs`, `src/**`, `**`; normalize `./`; reject absolute/drive-absolute paths, `..`, empty/double-star-in-middle/general globs; mandatory forbidden patterns always win; path boundary `src/**` must not match `src2/x`.
- [ ] **Step 3: Write RED routing tests** — normal IMPLEMENTER remains local; explicit `IMPLEMENTATION + explicitCrossProvider` selects one healthy independent provider and consumes budget; unavailable target returns `PROVIDER_UNAVAILABLE`; no fallback.
- [ ] **Step 4: Confirm RED** — `node --test tests/delegation/delegation-v2-contract.test.mjs tests/delegation/delegation-v2-policy.test.mjs tests/delegation/mutation-scope.test.mjs tests/delegation/delegation-policy.test.mjs tests/delegation/delegation-routing.test.mjs tests/core/schema-validation.test.mjs tests/core/schema-standalone-runtime.test.mjs`.
- [ ] **Step 5: Implement minimal contracts/policy/scope/routing and generate validators** — keep concrete provider names out of `core/**`.
- [ ] **Step 6: Verify GREEN** — focused tests + `npm run check:schemas`.
- [ ] **Step 7: Commit** — `feat(delegation): add implementation delegation contracts`.

---

### Task 2: Extract shared Git/snapshot primitives and build the hardened mutable clone

**Files:**
- Create: `runtime/delegation/git-boundary.mjs`
- Create: `runtime/delegation/source-snapshot.mjs`
- Create: `runtime/delegation/mutable-workspace.mjs`
- Modify: `runtime/delegation/workspace.mjs`
- Modify: `runtime/delegation/process-environment.mjs`
- Create: `tests/delegation/mutable-workspace.test.mjs`
- Create: `tests/delegation/mutable-workspace-git-boundary.test.mjs`
- Modify: `tests/delegation/workspace-lifecycle.test.mjs`
- Modify: `tests/delegation/workspace-dirty-snapshot.test.mjs`
- Modify: `tests/delegation/workspace-git-boundary.test.mjs`
- Modify: `tests/delegation/workspace-git-hooks-mutation.test.mjs`
- Modify: `tests/delegation/workspace-isolation-hardening.test.mjs`

**Interfaces:**
- `readDelegationGitBoundary(repoRoot) -> Promise<{ available, fingerprint }>` fingerprints HEAD/refs, local config, hooks; v1 consumes this extracted helper with parity to current behavior.
- `readDelegationSourceIdentity(repoRoot, { sourceRevision, sourceFingerprint })` validates the existing product fingerprint contract.
- `materializeDelegationSourceSnapshot({ sourceRoot, targetRoot, source })` preserves tracked staged, tracked unstaged, and untracked product state while excluding `.orchestra/state/**` and enforcing snapshot symlink safety.
- `prepareMutableDelegationWorkspace({ repoRoot, request, baseDir = null }) -> { repoRoot, path, sourceRevision, sourceFingerprint, syntheticBaselineSha, canonicalGitFingerprint, cloneGitFingerprint, workerGitEnv, cleanupToken }`.
- `inspectMutableDelegationWorkspace(context) -> { changedPaths, dirtyFileCount, canonicalWorkspaceChanged, canonicalGitChanged, cloneGitChanged, stagedByWorker }`.
- `cleanupMutableDelegationWorkspace(context) -> { cleaned, reason }` removes only the attributed clone/config scratch paths.

- [ ] **Step 1: Lock current v1 behavior with regression assertions before extraction** — same fingerprints, dirty snapshot fidelity, symlink egress, no-hooks behavior, canonical Git mutation detection.
- [ ] **Step 2: Write RED mutable-clone tests** — path outside canonical checkout; independent `.git`; clone made with no hardlinks; no `objects/info/alternates`; no remotes before worker; source revision/dirty snapshot exactly reproduced; synthetic baseline commit contains canonical pre-worker state.
- [ ] **Step 3: Write RED Git isolation tests** — worker env contains `GIT_CONFIG_NOSYSTEM=1`, broker-created `GIT_CONFIG_GLOBAL`, `GIT_TERMINAL_PROMPT=0`, and protocol denial; inherited global/system hook/config fixture cannot execute; local/file/http/https/ssh/git/ext remote use is unavailable from worker env.
- [ ] **Step 4: Write RED metadata mutation tests** — worker-created commit/HEAD move, ref/config/hooks mutation, or staged index change is detected; canonical repo remains unchanged; no promotable workspace facts are returned.
- [ ] **Step 5: Confirm RED** — `node --test tests/delegation/mutable-workspace*.test.mjs tests/delegation/workspace-*.test.mjs`.
- [ ] **Step 6: Extract existing helpers and implement hardened clone/synthetic baseline** — broker Git operations use no-hooks; synthetic commit uses fixed local identity, no signing, no remote.
- [ ] **Step 7: Verify GREEN including v1 parity** — focused mutable tests plus all existing workspace tests.
- [ ] **Step 8: Commit** — `feat(delegation): isolate mutable workers in hardened clones`.

---

### Task 3: Derive worker mutation facts and seal persistent Mutation Artifacts

**Files:**
- Create: `runtime/delegation/artifact-store.mjs`
- Create: `runtime/delegation/artifact-lifecycle.mjs`
- Create: `tests/delegation/artifact-store.test.mjs`
- Create: `tests/delegation/artifact-sealing.test.mjs`
- Modify: `runtime/delegation/store.mjs`
- Modify: `tests/delegation/delegation-store.test.mjs`

**Interfaces:**
- Artifact state root: `.orchestra/state/delegation/artifacts/<artifactId>/` with `manifest.json` and `candidate.patch`.
- `deriveMutationFacts({ workspacePath, baselineSha, scope }) -> Promise<{ changedPaths, facts, mutationDigest }>` derives sorted path/kind/mode/content-or-link-hash facts from filesystem/Git, never worker report fields; deleted paths are represented as `kind: "DELETED"` facts.
- `sealDelegationArtifact({ repoRoot, request, generation, actor, workspace, report }) -> Promise<{ artifactId, patchSha256, mutationDigest, changedPaths, state: "READY_FOR_REVIEW" }>` validates scope/symlinks/Git boundaries, stages only after validation, emits `git diff --cached --binary --full-index <syntheticBaselineSha>`, and writes state atomically.
- `readDelegationArtifact(repoRoot, artifactId)` / `listDelegationArtifacts(repoRoot)` reject unsafe IDs and malformed/incomplete state.
- Delegation record v1 storage accepts optional v2 facts without invalidating existing records: top-level `artifactId` and `workspace.retained`. V1 terminal records remain unchanged; successful v2 records may be `COMPLETED` with `retained=true`, `cleaned=false`, no cleanup failure, and an artifact ID.

- [ ] **Step 1: Write RED artifact-store tests** — safe ID/path traversal, atomic manifest+patch presence, parse/shape failure, bounded strings/arrays, no raw prompt/transcript/stdout/stderr/reasoning.
- [ ] **Step 2: Write RED sealing tests** — tracked edit/new/delete/binary/mode/symlink changes produce deterministic `changedPaths`, binary/full-index patch hash and mutation digest; dirty canonical baseline is excluded from worker delta.
- [ ] **Step 3: Add Review Focus cases** — out-of-scope path, forbidden `.orchestra/state/**`, escaping symlink, worker-staged index, changed clone HEAD/config/hooks produce `SCOPE_VIOLATION` and no artifact directory.
- [ ] **Step 4: Confirm RED** — `node --test tests/delegation/artifact-store.test.mjs tests/delegation/artifact-sealing.test.mjs tests/delegation/delegation-store.test.mjs`.
- [ ] **Step 5: Implement store + factual mutation digest + sealing** — patch/model report never supplies changed-path facts.
- [ ] **Step 6: Verify GREEN** — focused tests plus `tests/leases/workspace-fingerprint.test.mjs`.
- [ ] **Step 7: Commit** — `feat(delegation): seal mutable worker artifacts`.

---

### Task 4: Make Worker Envelope and provider executors version-aware without weakening v1

**Files:**
- Modify: `core/delegation/worker-envelope.mjs`
- Modify: `providers/antigravity/delegation-executor.mjs`
- Modify: `providers/codex/delegation-executor.mjs`
- Modify: `runtime/delegation/process-environment.mjs`
- Modify: `tests/delegation/worker-envelope-boundary.test.mjs`
- Modify: `tests/delegation/antigravity-executor.test.mjs`
- Modify: `tests/delegation/codex-executor.test.mjs`
- Modify: `tests/delegation/process-environment.test.mjs`

**Interfaces:**
- `buildWorkerEnvelope(request)` preserves the exact v1 read-only envelope; for v2 it includes normalized mutation scope and `prohibitions: { mutation: "WORKSPACE_ONLY", network: "FORBIDDEN", delegation: "FORBIDDEN" }` while omitting lease/control internals.
- Provider executor `execute({ request, workerEnvelope, workspace })` selects prompt semantics by request schema; it never decides scope validity or promotion.
- `buildDelegationProcessEnvironment({... extra })` remains sanitized and accepts broker-supplied Git-isolation variables from v2 workspace context.

- [ ] **Step 1: Write RED v1 prompt regression tests** — AGY still receives `Do not modify files`; Codex v1 remains logically read-only; v1 worker envelope has no `WORKSPACE_EDIT`/mutation scope.
- [ ] **Step 2: Write RED v2 executor tests** — AGY/Codex prompt explicitly allows only scoped workspace edits, still forbids network/delegation/Git-history mutation, uses the supplied independent clone cwd, retains sandboxing, and receives isolated Git env.
- [ ] **Step 3: Write RED malformed-output/failure tests for v2** — timeout/nonzero/oversized/malformed report map to existing taxonomy and cannot fabricate artifact fields.
- [ ] **Step 4: Confirm RED** — `node --test tests/delegation/worker-envelope-boundary.test.mjs tests/delegation/antigravity-executor.test.mjs tests/delegation/codex-executor.test.mjs tests/delegation/process-environment.test.mjs`.
- [ ] **Step 5: Implement version-aware envelope/prompt/env wiring**.
- [ ] **Step 6: Verify GREEN and contamination/firewall** — focused tests + `npm run test:firewall && npm run check:contamination`.
- [ ] **Step 7: Commit** — `feat(delegation): enable scoped provider implementation prompts`.

---

### Task 5: Add v2 execution lifecycle to the neutral broker and CLI

**Files:**
- Modify: `runtime/delegation/broker.mjs`
- Modify: `runtime/delegation/cli.mjs`
- Modify: `runtime/delegation/store.mjs`
- Create: `tests/delegation/broker-v2.test.mjs`
- Modify: `tests/delegation/broker.test.mjs`
- Modify: `tests/delegation/delegation-cli.test.mjs`
- Modify: `tests/delegation/delegation-events.test.mjs`

**Interfaces:**
- `createDelegationBroker({ executors, workspace, mutableWorkspace, artifacts, store, events })` keeps current v1 services/defaults and adds injectable v2 services.
- `executeDelegation(request, { repoRoot, generation, actor })` dispatches by schema after common root-actor validation.
- V2 lifecycle: authorize -> discover exact provider -> prepare hardened clone -> STARTED record/event -> execute -> inspect -> scope/Git integrity -> seal artifact -> terminal COMPLETED record/event with `artifactId` and retained clone -> return `DelegationResult.v2`.
- V2 failure before sealing cleans the clone/config scratch; cleanup failure uses existing `WORKSPACE_CLEANUP_FAILED`. Successful v2 deliberately retains the clone and is not misclassified as cleanup failure.
- Existing `cli.mjs --request ... --repo-root ... --generation ...` syntax accepts either canonical request version; request schema selects lifecycle.

- [ ] **Step 1: Write RED broker-v2 happy path** — fake provider edits an allowed file in real mutable clone; result is v2 COMPLETED with broker-derived artifact; canonical product/Git unchanged; record is terminal with retained artifact; result is not Candidate/Evidence/Acceptance.
- [ ] **Step 2: Write RED failure matrix** — provider unavailable, scope violation, canonical mutation detector, invalid report, execution timeout/failure, seal failure, cleanup failure; no fallback and no artifact on failure.
- [ ] **Step 3: Write RED v1 compatibility assertions** — existing broker/CLI fixtures and cleanup semantics remain byte/shape compatible where contract fixes them.
- [ ] **Step 4: Confirm RED** — `node --test tests/delegation/broker.test.mjs tests/delegation/broker-v2.test.mjs tests/delegation/delegation-cli.test.mjs tests/delegation/delegation-events.test.mjs`.
- [ ] **Step 5: Implement version-aware broker/CLI with separate v1/v2 internal paths** — do not turn v1 dirty-workspace denial into a generic mutable rule.
- [ ] **Step 6: Verify GREEN** — `npm run test:delegation`.
- [ ] **Step 7: Commit** — `feat(delegation): broker cross-provider implementation artifacts`.

---

### Task 6: Add artifact inspection, tamper checks, explicit CONTROL promotion/discard, and atomic promotion lock

**Files:**
- Modify: `runtime/delegation/artifact-lifecycle.mjs`
- Create: `runtime/delegation/artifact-cli.mjs`
- Create: `tests/delegation/artifact-promotion.test.mjs`
- Create: `tests/delegation/artifact-cli.test.mjs`
- Modify: `tests/leases/atomic-lock.test.mjs` only if reusable-lock behavior needs an additional contract assertion

**Interfaces:**
- `inspectDelegationArtifact({ repoRoot, artifactId }) -> { manifest, integrity: { valid, reason }, reviewPath }` recomputes patch SHA/mutation digest/scope and never mutates canonical product state.
- `promoteDelegationArtifact({ repoRoot, artifactId, generation, actor }) -> { promoted, reason, changedPaths }` accepts only `READY_FOR_REVIEW`; acquires `.orchestra/state/delegation/promotion.lock` with `actor.actorIdHash`; validates actor/generation/baseline/Git boundary/sealed clone/scope; runs `git apply --check`, rechecks baseline while lock is held, applies patch to working tree without `--index`, verifies changed-file mutation digest, marks artifact `PROMOTED`, then exact-path cleans retained clone.
- `discardDelegationArtifact({ repoRoot, artifactId, generation, actor }) -> { discarded, reason }` accepts only `READY_FOR_REVIEW`, validates actor/generation, exact-path cleans clone, marks `DISCARDED`.
- CLI syntax is fixed here: `artifact-cli.mjs inspect --artifact <id> --repo-root <root>`; `artifact-cli.mjs promote|discard --artifact <id> --repo-root <root> --generation <n> --source-provider <provider> --actor-id-hash <hash>`. Mutating actions construct a root actor only from these explicit caller facts and then compare them to the sealed manifest; stored artifact identity alone never authenticates the action.

- [ ] **Step 1: Write RED inspect/tamper tests** — unchanged artifact validates; edited retained file/index/patch/manifest yields `ARTIFACT_TAMPERED`; inspect never applies patch.
- [ ] **Step 2: Write RED stale/authority tests** — wrong source provider/actor/generation, canonical tracked/untracked/index change, canonical refs/config/hooks change, non-READY state all fail before canonical product mutation; stale baseline maps to `PROMOTION_STALE`.
- [ ] **Step 3: Write RED promotion fidelity tests** — canonical fixture starts with staged + unstaged + untracked baseline; promotion applies only worker delta, preserves prior index entries exactly, and final changed file facts equal sealed mutation digest.
- [ ] **Step 4: Write RED concurrency/CLI tests** — active promotion lock denies concurrent promotion; CLI rejects malformed flags/unsafe IDs; successful promote/discard transitions artifact state and cleans only attributed clone.
- [ ] **Step 5: Confirm RED** — `node --test tests/delegation/artifact-promotion.test.mjs tests/delegation/artifact-cli.test.mjs tests/leases/atomic-lock.test.mjs`.
- [ ] **Step 6: Implement inspect/promote/discard + CLI** — no auto-Candidate/Evidence/Acceptance transition.
- [ ] **Step 7: Verify GREEN** — focused tests + `npm run test:leases`.
- [ ] **Step 8: Commit** — `feat(delegation): add explicit artifact promotion`.

---

### Task 7: Expose explicit implementation and artifact actions in both provider control planes

**Files:**
- Modify: `runtimes/codex/.codex/astra-orchestra/cross-provider-delegation.mjs`
- Modify: `runtimes/antigravity/.agents/skills/orchestra/cross-provider-delegation.mjs`
- Modify: `tests/delegation/codex-control-plane-delegation.test.mjs`
- Modify: `tests/delegation/antigravity-control-plane-delegation.test.mjs`
- Modify provider routing/docs tests if the runtime instruction surfaces assert delegation purposes.

**Interfaces:**
- Keep existing `buildCodexDelegationRequest()` and `buildAntigravityDelegationRequest()` as v1 read-only builders.
- Add `buildCodexImplementationDelegationRequest({... mutationScope })` and `buildAntigravityImplementationDelegationRequest({... mutationScope })`; both emit canonical v2 with exact implementation authority and no Work Lease payload.
- `decideCodexCrossProviderRoute()` / `decideAntigravityCrossProviderRoute()` forward `explicitCrossProvider`; implementation crosses only with explicit intent.
- Existing execute helpers accept either request version, require matching result schema/identity, and always return `{ controlReturned: true, accepted: false, claimOnly: true, result }`.
- Add provider wrappers over the installed neutral artifact CLI: `inspectCodexDelegationArtifact`, `promoteCodexDelegationArtifact`, `discardCodexDelegationArtifact` and symmetric Antigravity functions. Mutating wrappers pass the provider constant plus current `actorIdHash`/generation explicitly; they return artifact action facts only and never auto-create Candidate/Evidence/Acceptance.

- [ ] **Step 1: Write RED Codex -> AGY primary implementer contract test** — explicit route selects AGY; builder emits v2 exact capabilities/scope; normal implementation without explicit flag remains local; unavailable AGY returns failure without Codex/manual fallback.
- [ ] **Step 2: Write RED AGY -> Codex symmetric test**.
- [ ] **Step 3: Write RED provider artifact-action tests** — inspect is read-only; promote/discard invoke installed neutral CLI with exact source provider/actor/generation; mismatched result/version is rejected; promotion still does not imply acceptance.
- [ ] **Step 4: Confirm RED** — `node --test tests/delegation/codex-control-plane-delegation.test.mjs tests/delegation/antigravity-control-plane-delegation.test.mjs`.
- [ ] **Step 5: Implement provider-control builders/routing/artifact wrappers** — keep source-relative installed runtime imports intact.
- [ ] **Step 6: Sync runtime core/provider generated copies and verify parity** — `npm run sync:runtime-core && npm run check:runtime-core` plus focused tests.
- [ ] **Step 7: Commit** — `feat(delegation): expose explicit cross-provider implementers`.

---

### Task 8: Package the new neutral surfaces, preserve artifact state, and extend Doctor recovery

**Files:**
- Modify: `runtime/manifests/delegation.json`
- Modify: `runtime/doctor.mjs`
- Modify: `tests/runtime/delegation-recovery-doctor.test.mjs`
- Modify: `tests/runtime/runtime-manifest.test.mjs`
- Modify: `tests/installers/delegation-project-runtime.test.mjs`
- Modify: `tests/installers/self-contained-runtime.test.mjs`
- Modify installer/runtime-manager tests that assert preserved project paths or delegation entrypoints.
- Regenerate: `dist/**` / runtime images through canonical build scripts only; do not hand-edit generated runtime payloads.

**Packaging contract:**
- `runtime/delegation/**` tree automatically carries mutable workspace, artifact store/lifecycle and `artifact-cli.mjs` into `.orchestra/runtime/delegation/runtime/delegation/**`.
- Add installed entrypoint `.orchestra/runtime/delegation/runtime/delegation/artifact-cli.mjs`.
- Preserve both existing `.orchestra/state/delegations` records and new `.orchestra/state/delegation/artifacts` state across install/update.
- Neutral runtime still packages only bounded provider executor/catalog files; never `.codex/**`, `.agents/**`, provider hooks/session/control-plane trees.
- Doctor adds artifact recovery facts: malformed artifact state => recovery required; `READY_FOR_REVIEW` is reported as pending review (not cleanup failure); failed discard/promote cleanup exposes exact recoverable path; no broad cleanup is performed.

- [ ] **Step 1: Write RED manifest/install tests** — artifact CLI is self-contained, new state path preserved, duplicate provider install/update remains idempotent, no provider control-plane contamination.
- [ ] **Step 2: Write RED Doctor tests** — ready artifact/pending review, tampered/unreadable state, cleanup-failed retained clone; existing v1 delegation recovery output remains valid.
- [ ] **Step 3: Confirm RED** — `node --test tests/runtime/runtime-manifest.test.mjs tests/runtime/delegation-recovery-doctor.test.mjs tests/installers/delegation-project-runtime.test.mjs tests/installers/self-contained-runtime.test.mjs`.
- [ ] **Step 4: Implement manifest/Doctor integration**.
- [ ] **Step 5: Rebuild/check generated runtimes** — `npm run build:runtimes && npm run check:runtimes && npm run check:runtime-core`.
- [ ] **Step 6: Verify installers/firewall/contamination** — `npm run test:installers && npm run test:firewall && npm run check:contamination`.
- [ ] **Step 7: Commit** — `feat(delegation): package mutable delegation lifecycle`.

---

### Task 9: Close documentation, regression, portability, and canonical CI gates

**Files:**
- Modify: `docs/architecture.md`
- Modify: delegation/runtime README or provider runtime guidance that currently documents cross-provider delegation as read-only.
- Modify: `docs/superpowers/specs/2026-10-14-cross-provider-implementation-delegation-design.md` status to implemented only after evidence is green.
- Add/modify tests only for gaps discovered by the final regression; do not weaken assertions to obtain green.

**Interfaces/evidence:**
- Documentation states two protocols: v1 read/review and v2 explicit implementation; delegation remains execution, not authority transfer.
- Tsuzuki remains untouched until a later downstream synchronization gate.
- No package version/tag/release action occurs in this task.

- [ ] **Step 1: Run generated/focused preflight** — `npm run check:schemas && npm run check:runtimes && npm run check:runtime-core && npm run test:delegation && npm run test:leases && npm run test:firewall && npm run check:contamination`.
- [ ] **Step 2: Run installer/Doctor/release-readiness surfaces** — `npm run test:installers && npm run test:runtime && npm run test:release`.
- [ ] **Step 3: Run full regression** — `npm test`.
- [ ] **Step 4: Exercise portable CI surfaces** — canonical repository CI must pass Ubuntu and Windows runtime/install/delegation jobs on the exact hotfix HEAD; no live provider credentials required.
- [ ] **Step 5: Run an adversarial implementation-specific review** — verify no canonical Git write path through clone remotes/protocol/config, no v1 privilege expansion, no scope bypass/symlink egress, no artifact self-acceptance, and promotion stale/tamper fences.
- [ ] **Step 6: Update architecture/status docs only with factual green evidence and exact HEAD/run identifiers**.
- [ ] **Step 7: Commit** — `docs(delegation): document implementation delegation evidence`.
- [ ] **Step 8: Open integration PR against `main` and require exact-head CI green before requesting merge authorization** — merging/releasing remains a separate operator decision.

---

## Definition of Done

The hotfix is implementation-complete only when all of these are factual on one exact branch HEAD:

- v1 read-only delegation regression is green and still denies mutation;
- Codex CONTROL can explicitly build/execute a v2 AGY implementation request and AGY CONTROL can symmetrically target Codex;
- v2 worker mutation is confined to a hardened independent clone and machine-enforced path scope;
- canonical product and Git state remain unchanged during delegated execution;
- worker delta is sealed into a factual `READY_FOR_REVIEW` artifact independent of model self-report;
- CONTROL can inspect, promote, or discard; wrong actor/generation, stale baseline, tamper, scope violation, and Git-boundary mutation fail closed;
- promotion preserves pre-existing canonical staged/unstaged/untracked state and applies only the sealed worker delta;
- no Candidate/Evidence/Acceptance authority is implicitly transferred;
- neutral runtime packaging, Doctor, installers, firewall, contamination, Ubuntu/Windows portability, release-readiness and full `npm test` are green;
- Tsuzuki has not been modified;
- exact-head CI evidence is available for operator review before merge/release decisions.
