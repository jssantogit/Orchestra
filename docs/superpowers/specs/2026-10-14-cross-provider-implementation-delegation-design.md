# Cross-Provider Implementation Delegation

**Date:** 2026-10-14  
**Status:** Written spec pending operator review  
**Baseline:** Orchestra `v1.1.0`, `main` at `927e92305803015f2946ec3314ae414ae4fc8b84`  
**Branch:** `hotfix/cross-provider-implementation-delegation`  
**Scope:** Add bounded cross-provider primary implementation without weakening the existing read-only delegation contract or transferring CONTROL authority.

## 1. Field failure that triggered this design

The first real Tsuzuki attempt to use Codex CONTROL with Antigravity (AGY) as the primary implementer correctly failed closed before implementation.

The installed Orchestra 1.1.0 delegation contract is intentionally read/process-exec only:

- `core/delegation/policy.mjs` requires exactly `LOCAL_READ + PROCESS_EXEC`;
- `authority.mutation` must be `FORBIDDEN`;
- the Antigravity executor explicitly instructs the delegated worker not to modify files;
- the broker treats a dirty delegated workspace as a capability violation and then cleans the workspace.

This behavior is correct for the original cross-provider review milestone, but it means the current protocol cannot legitimately represent a cross-provider implementer.

The required outcome is therefore not to bypass the policy. The required outcome is to add a new, explicit mutation-capable execution contract while preserving the original read-only contract unchanged.

## 2. Intent and success criteria

A root CONTROL actor must be able to delegate a bounded implementation packet to the other provider, allow that worker to modify only an isolated candidate workspace, independently inspect the produced implementation, and explicitly promote or discard the sealed mutation artifact.

Success means all of the following are true:

1. `DelegationRequest.v1` remains semantically and behaviorally read-only.
2. A separate implementation contract can grant exactly `LOCAL_READ + PROCESS_EXEC + WORKSPACE_EDIT`.
3. Mutation is limited to an isolated delegated workspace and an explicit machine-enforced path scope.
4. Worker network tools, recursive delegation, publication, remote-repository mutation, and canonical-repository mutation remain forbidden.
5. The canonical CONTROL workspace and canonical Git state are unchanged during delegated execution.
6. Worker-produced changes are broker-derived and sealed; the model cannot self-report itself into a canonical Candidate.
7. CONTROL can inspect/test the sealed workspace before promotion.
8. Promotion is a separate explicit CONTROL action and fails closed if the canonical baseline or artifact changed.
9. Failure never silently falls back to same-provider/manual implementation.
10. Existing cross-provider review, Doctor, packaging, contamination, turn-economy and release invariants remain green.

## 3. Existing architectural facts

The current repository already provides the useful foundation:

- provider-neutral delegation contracts and policy under `core/delegation/**` and `core/domain/delegation.mjs`;
- a neutral broker/composition root under `runtime/delegation/**`;
- provider-local Codex and Antigravity executors;
- bounded process execution and sanitized provider environments;
- dirty source snapshot materialization;
- symlink-egress checks;
- Git hook disabling for broker Git operations;
- canonical refs/config/hooks fingerprinting;
- process-tree termination;
- recursive-delegation fencing;
- project-owned `.orchestra/state/**` excluded from product fingerprints;
- an existing `ImplementationPacket` carrying goal, scope, validation and failure policy;
- existing Candidate/Evidence/Acceptance state machines owned by CONTROL.

The new design should reuse these pieces rather than create a second control plane.

## 4. Alternatives considered

### 4.1 Relax `DelegationRequest.v1` in place

Change v1 to accept `WORKSPACE_EDIT` and `mutation = ALLOWED`.

**Rejected.** V1 is already shipped and field-proven as a read-only capability boundary. Relaxing it would silently change the meaning of existing requests, tests, persisted records and security assumptions. It would also make privilege review harder because the same schema would describe two materially different trust levels.

### 4.2 Add mutation directly to the current ephemeral Git worktree

Keep the current request/broker lifecycle but allow dirty worktrees for `IMPLEMENTER`.

**Rejected.** A linked Git worktree has its own worktree/index but shares the repository's common Git object/ref/config infrastructure. The current read-only design can detect forbidden canonical Git mutations after execution, but a mutation-capable worker should not be placed in a workspace that can physically reach the canonical Git common directory as part of normal Git operation. Detection after damage is weaker than isolation.

### 4.3 Create a separate implementation-specific control plane

Add a second broker/runtime dedicated to mutable workers.

**Rejected.** This duplicates discovery, process boundaries, lifecycle, store, Doctor and provider composition. It also increases the chance that review and implementation delegation drift into inconsistent security models.

### 4.4 Selected: additive v2 implementation protocol on the existing neutral broker

Keep v1 exactly read-only and add a v2 request/result pair specifically for bounded implementation. The broker dispatches by schema version but shares provider discovery, process execution, state, events and recovery infrastructure.

Implementation workers run in an **independent local ephemeral clone**, not a linked worktree. The broker seals the produced mutation as a local artifact and retains the clone for CONTROL review. Promotion/discard are separate broker operations.

This is the selected design.

## 5. Normative invariants

### 5.1 Delegation still does not transfer authority

Cross-provider implementation delegates execution, not CONTROL.

The delegated worker does not receive:

- Work Lease ownership;
- generation-advance authority;
- Candidate promotion authority;
- Evidence promotion authority;
- Acceptance authority;
- release/publication authority;
- recursive delegation authority.

### 5.2 V1 remains immutable in meaning

`orchestra.delegation-request.v1` remains exactly the read/process-exec contract. Existing v1 policy tests become regression guards against accidental privilege expansion.

### 5.3 V2 represents implementation only

The first v2 milestone is deliberately narrow. It does not attempt to become a generic capability matrix.

A valid implementation request has these semantic constants:

```text
schema                 = orchestra.delegation-request.v2
logicalRole            = IMPLEMENTER
purpose                = IMPLEMENTATION
capabilities            = LOCAL_READ + PROCESS_EXEC + WORKSPACE_EDIT
mutation               = WORKSPACE_ONLY
network                = FORBIDDEN
mayDelegate            = false
delegationDepth         = 1
workspace.isolation    = EPHEMERAL_CLONE
```

Any other combination fails closed.

### 5.4 Canonical repository is never the worker workspace

The worker process must never run with the canonical checkout as `cwd`.

For v2, the delegated workspace is an independent local clone with its own `.git` directory. Worker Git commands therefore cannot mutate canonical refs, config, hooks or object storage through linked-worktree sharing.

### 5.5 Scope is machine-enforced, not prompt-only

`ImplementationPacket.scope.allowedAreas` remains useful human/task context but is not sufficient as a mutation security boundary.

V2 adds an explicit normalized mutation scope containing repository-relative paths/patterns. The broker derives the actual changed path set after execution and rejects any change outside the authorized set or inside mandatory forbidden regions.

Mandatory forbidden regions include at least:

```text
.git/**
.orchestra/state/**
```

Absolute paths, parent traversal and path forms that normalize outside the delegated clone are invalid.

### 5.6 Model output never defines the mutation artifact

The worker report remains a bounded model claim. Changed paths, patch bytes, hashes and candidate workspace identity are derived by Orchestra from the filesystem/Git state after execution.

The worker cannot declare which files it changed in order to bypass inspection.

### 5.7 Delegation result is still not Candidate or Acceptance

The existing invariant remains:

```text
DelegationResult != Evidence
DelegationResult != Candidate
DelegationResult != Acceptance
```

A successful v2 result may reference a sealed **Mutation Artifact**, but promotion of that artifact into the canonical workspace is a separate CONTROL action. Existing Candidate/Evidence/Acceptance flow continues after promotion.

## 6. V2 request contract

Add `schemas/delegation-request.v2.schema.json`.

Illustrative shape:

```ts
DelegationRequestV2 {
  schema: "orchestra.delegation-request.v2"
  delegationId
  taskId

  source: {
    provider
    actorIdHash
  }

  target: {
    provider
    logicalRole: "IMPLEMENTER"
  }

  purpose: "IMPLEMENTATION"
  packet: ImplementationPacket

  authority: {
    capabilities: [
      "LOCAL_READ",
      "PROCESS_EXEC",
      "WORKSPACE_EDIT"
    ]
    mutation: "WORKSPACE_ONLY"
    network: "FORBIDDEN"
    mayDelegate: false
  }

  workspace: {
    sourceFingerprint
    sourceRevision
    isolation: "EPHEMERAL_CLONE"
    mutationScope: {
      allowedPaths: string[]
      forbiddenPaths: string[]
    }
  }

  limits: {
    timeoutMs
    maxOutputBytes
    delegationDepth: 1
  }
}
```

`allowedPaths` must be non-empty. `forbiddenPaths` may be empty in the request, but the broker always unions it with Orchestra mandatory forbidden paths.

The Core validator additionally rejects unsafe path syntax that JSON Schema alone should not attempt to model.

## 7. V2 result and sealed mutation artifact

Add `schemas/delegation-result.v2.schema.json`.

A successful implementation result contains a bounded artifact descriptor derived by the broker:

```ts
DelegationResultV2 {
  schema: "orchestra.delegation-result.v2"
  delegationId
  provider
  logicalRole: "IMPLEMENTER"
  purpose: "IMPLEMENTATION"
  status
  reason?
  summary
  findings[]
  evidenceRefs[]
  execution

  workspace: {
    sourceRevision
    sourceFingerprint
    delegatedPath
    changedPaths[]
    dirty
  }

  artifact?: {
    artifactId
    patchSha256
    mutationDigest
    changedPaths[]
    state: "READY_FOR_REVIEW"
  }
}
```

`delegatedPath` is local execution metadata for the root CONTROL actor. It is never interpreted as authority and is not accepted from model output.

The artifact descriptor exists only for a successful, scope-valid, sealed implementation. Failure results do not expose a promotable artifact.

## 8. Mutable workspace lifecycle

### 8.1 Validate and authorize before external execution

Before provider discovery or filesystem allocation:

- v2 schema validates;
- source provider matches the root actor;
- target differs from source;
- role is `IMPLEMENTER`;
- purpose is `IMPLEMENTATION`;
- exact v2 capabilities are present;
- mutation is `WORKSPACE_ONLY`;
- network is `FORBIDDEN`;
- recursive delegation is forbidden;
- source revision/fingerprint matches the canonical workspace;
- mutation scope is syntactically safe.

### 8.2 Create an independent local clone

The broker creates a clone outside the canonical checkout root using only the local repository as source. No remote network access is required.

The clone must:

- have an independent `.git` directory;
- resolve outside the canonical checkout;
- disable hooks for broker Git operations;
- not inherit unsafe local Git configuration;
- be attributable to one delegation/artifact ID;
- work on supported Ubuntu and Windows CI surfaces.

### 8.3 Materialize the exact source snapshot

The clone starts at `sourceRevision`. The existing dirty/uncommitted snapshot logic is reused/adapted so the delegated implementation sees exactly the same product state as CONTROL.

After materialization, Orchestra creates a **synthetic baseline commit inside the independent clone only**. This commit exists solely to define the exact pre-worker content baseline and never touches canonical Git storage or refs.

The synthetic baseline is created with:

- hooks disabled;
- fixed Orchestra-local author/committer identity;
- no signing;
- no network;
- no canonical ref update.

This solves an important case: when CONTROL's canonical workspace was already dirty, the final worker delta must exclude those pre-existing changes.

### 8.4 Run the provider implementer

Provider executors select their prompt from the request version/capability profile.

For v2 the prompt states that the worker may modify files only within the supplied mutation scope, while network use and delegation remain forbidden.

Provider sandboxing remains enabled. Provider inference transport is infrastructure, not worker network authority.

The worker returns the same bounded report shape. Orchestra does not trust the report for filesystem facts.

### 8.5 Derive and validate actual mutation

After execution Orchestra derives the changed path set from the clone.

It then verifies:

- every changed path is inside `allowedPaths`;
- no changed path is inside request or mandatory forbidden paths;
- no changed symlink resolves outside the delegated clone;
- canonical product fingerprint is unchanged;
- canonical Git refs/config/hooks fingerprint is unchanged;
- the delegated clone still descends from the synthetic baseline.

Any violation returns failure and produces no promotable artifact.

### 8.6 Seal the artifact

Inside the independent clone, the broker stages the validated worker delta with hooks disabled and creates a binary/full-index patch from the synthetic baseline to the staged result.

Because the synthetic baseline already contains the pre-existing canonical dirty snapshot, the patch contains **only the delegated worker delta** while still representing new, deleted and binary files.

Orchestra records under project-owned state:

```text
.orchestra/state/delegation/artifacts/<artifact-id>/manifest.json
.orchestra/state/delegation/artifacts/<artifact-id>/candidate.patch
```

The manifest contains bounded factual metadata including:

- delegation/task IDs;
- source provider/actor hash;
- generation supplied by CONTROL;
- source revision/fingerprint;
- canonical Git boundary fingerprint;
- delegated clone path;
- normalized mutation scope;
- changed paths;
- patch SHA-256;
- mutation content digest;
- lifecycle state.

The patch and manifest are not product files and remain excluded from the product workspace fingerprint.

### 8.7 Retain for independent review

On successful v2 execution the independent clone is **not immediately deleted**. It is retained as a sealed review workspace.

This lets CONTROL independently:

- inspect the actual modified files;
- run local tests in the candidate workspace;
- compare the worker report against filesystem reality;
- decide whether to promote or discard.

Before any later promotion, Orchestra re-computes the sealed patch/hash/digest. Any post-seal mutation causes `ARTIFACT_TAMPERED` and blocks promotion.

### 8.8 Explicit promotion

Add a neutral broker operation conceptually equivalent to:

```ts
promoteDelegationArtifact({
  repoRoot,
  artifactId,
  generation,
  actor,
})
```

Promotion is CONTROL-owned and must verify all of the following atomically enough to fail closed:

1. artifact state is `READY_FOR_REVIEW`;
2. actor matches the original root source actor;
3. supplied generation matches the artifact generation;
4. canonical source fingerprint is still exactly the artifact baseline;
5. canonical Git boundary fingerprint is still unchanged;
6. retained clone still matches the sealed patch hash/digest;
7. changed paths still satisfy the original mutation scope;
8. `git apply --check` succeeds against the canonical workspace;
9. applying the patch produces the sealed changed-file content.

Only after all checks pass may the broker apply the delegated delta to the canonical workspace.

Promotion does **not** self-accept the implementation. It only materializes the already-reviewed worker delta under CONTROL authority. Candidate/Evidence/Acceptance state transitions continue through the existing Orchestra workflow.

### 8.9 Explicit discard

A sibling operation discards a `READY_FOR_REVIEW` artifact and cleans the retained clone. Discard does not alter the canonical workspace.

### 8.10 Cleanup and recovery

Failures before a valid artifact is sealed always attempt immediate clone cleanup.

Successful implementation retains the clone until promote/discard.

If cleanup fails, the artifact/record keeps a recoverable path and Doctor can report it. Cleanup commands remain attribution-bound and must never perform broad deletion.

## 9. Failure taxonomy

V1 taxonomy remains unchanged.

V2 adds only implementation-specific failures needed for factual control:

```text
SCOPE_VIOLATION
ARTIFACT_SEAL_FAILED
ARTIFACT_TAMPERED
PROMOTION_STALE
PROMOTION_FAILED
```

Provider absence, capability denial, workspace preparation, execution timeout/failure, invalid result and cleanup failure reuse existing reason families.

No failure triggers implicit provider fallback or manual implementation.

## 10. Provider executor changes

### Antigravity

The current executor already invokes `agy --sandbox ... --print` from the delegated workspace. V2 changes the worker prompt from read-only to explicitly scoped implementation permission.

The broker, not the prompt, remains responsible for enforcing actual changed paths and sealing the artifact.

### Codex

The current executor already uses `codex exec --sandbox workspace-write` while the v1 prompt forbids source mutation. V1 keeps that behavior and its post-execution dirty-workspace denial.

For v2, the prompt authorizes bounded workspace mutation. The same broker-side scope/seal checks apply, preserving symmetry between providers.

### Shared executor rule

Provider executors do not receive promotion authority and do not write canonical Orchestra state directly. They execute a worker in the supplied isolated workspace and return only a bounded report plus execution facts.

## 11. Broker and CLI surface

The neutral broker remains the single lifecycle owner.

It gains version-aware execution plus explicit artifact actions. Exact CLI syntax is an implementation detail, but the existing v1 invocation must remain backward compatible.

A practical shape is:

```text
cli.mjs <existing v1 execute flags>
cli.mjs execute <v2 request flags>
artifact-cli.mjs inspect --artifact <id> --repo-root <root>
artifact-cli.mjs promote --artifact <id> --repo-root <root> --generation <n>
artifact-cli.mjs discard --artifact <id> --repo-root <root> --generation <n>
```

If preserving the original `cli.mjs` parser makes subcommands awkward, a separate neutral `artifact-cli.mjs` is preferred over destabilizing the shipped v1 CLI contract.

## 12. Routing policy

This hotfix does not make cross-provider implementation automatic merely because another provider is available.

Implementation delegation requires explicit CONTROL intent. Same-provider/local implementation remains the normal routing default unless the orchestration decision specifically selects the cross-provider implementer.

There is no silent fallback:

```text
Codex CONTROL -> AGY implementation requested -> AGY unavailable
= PROVIDER_UNAVAILABLE
```

not:

```text
Codex CONTROL -> AGY unavailable -> Codex silently implements
```

This preserves the behavior expected by the Tsuzuki F7 checkpoint.

## 13. Security properties that must survive

The implementation must preserve the hardening already shipped in 1.1.0:

- dirty/uncommitted source snapshot fidelity;
- symlink egress protection;
- Git hooks disabled for broker Git operations;
- canonical refs/config/hooks protection;
- sanitized delegated process environment;
- process-tree termination on timeout;
- recursive-delegation fencing;
- neutral-only provider packaging;
- duplicate-install safety;
- forbidden worker-envelope paths;
- project-owned state excluded from product fingerprints;
- provider-runtime firewall and contamination rules.

The mutable protocol adds isolation; it must not weaken any of these controls.

## 14. Required TDD/verification matrix

Implementation starts with RED tests proving the missing behavior and preserving old behavior.

Minimum required coverage:

### Contract/policy

- v1 still rejects `WORKSPACE_EDIT` and any mutation permission;
- v2 accepts exactly the implementation capability set;
- v2 rejects read-only/mixed/unknown capability combinations;
- v2 rejects network permission, recursion, wrong role, wrong purpose and non-clone isolation;
- unsafe mutation-scope paths are rejected.

### Workspace isolation

- v2 workspace has an independent `.git` directory;
- worker `git config`, branch/ref creation or local commit inside the clone cannot mutate canonical refs/config/hooks;
- canonical workspace fingerprint remains unchanged during worker execution;
- dirty/staged/untracked canonical source state is reproduced exactly in the clone;
- synthetic baseline causes the sealed patch to contain only worker delta.

### Scope enforcement

- allowed tracked edit passes;
- allowed new file passes;
- allowed deletion passes;
- allowed binary change is captured;
- mutation outside allowed paths fails;
- mandatory forbidden paths fail even if request tries to allow them;
- symlink egress mutation fails;
- scope violation creates no promotable artifact.

### Artifact sealing/review

- broker-derived changed paths match reality;
- patch SHA and mutation digest are deterministic;
- successful implementation returns `READY_FOR_REVIEW` artifact;
- retained clone is available for CONTROL review;
- modifying the clone after sealing makes promotion fail as tampered.

### Promotion/discard

- promotion against unchanged canonical baseline applies exactly the worker delta;
- pre-existing dirty canonical state is preserved rather than duplicated;
- stale canonical fingerprint blocks promotion;
- changed canonical Git boundary blocks promotion;
- patch check failure leaves canonical workspace unchanged;
- successful promotion marks artifact terminal and cleans clone;
- discard leaves canonical workspace unchanged and cleans clone;
- cleanup failure remains recoverable/Doctor-visible.

### Provider execution

- AGY v1 prompt remains read-only;
- AGY v2 prompt authorizes only scoped workspace mutation;
- Codex v1 remains read-only by contract despite physical workspace-write sandbox;
- Codex v2 gets the scoped implementation prompt;
- both providers keep network/delegation prohibitions;
- worker model output cannot forge changed paths/artifact hashes.

### Regression/package surfaces

- generated schemas/validators are synchronized;
- runtime-core manifests are synchronized;
- neutral delegation package contains required v2/artifact surfaces;
- provider runtimes do not gain sibling control-plane code;
- Doctor/contamination/firewall remain green;
- full `npm test` remains green;
- portable Ubuntu/Windows runtime tests remain green;
- release-readiness and turn-economy regression surfaces remain green.

## 15. Rollout boundary

This hotfix is developed and validated in Orchestra first.

It does **not** modify Tsuzuki during implementation or validation of the Orchestra fix.

After the Orchestra branch is complete, independently reviewed, integrated and released through the existing Release Train, Tsuzuki synchronization remains a separate operator-controlled action. F7 can then restart from its preserved baseline using the new canonical mutable delegation mechanism.

## 16. Definition of done

The architectural work is complete only when:

1. v1 read-only behavior is demonstrably unchanged;
2. v2 cross-provider implementation works for Codex -> AGY and AGY -> Codex through the neutral broker;
3. worker mutation is physically isolated from canonical Git via an independent local clone;
4. changed paths are machine-enforced against an explicit mutation scope;
5. a successful worker produces a sealed, reviewable mutation artifact rather than an autoaccepted Candidate;
6. CONTROL can inspect, promote or discard that artifact;
7. stale/tampered promotion fails without canonical mutation;
8. canonical workspace/Git integrity tests pass under adversarial cases;
9. packaging, Doctor, contamination/firewall, full regression and portable CI are green;
10. no Tsuzuki product/runtime files are changed as part of this Orchestra hotfix.
