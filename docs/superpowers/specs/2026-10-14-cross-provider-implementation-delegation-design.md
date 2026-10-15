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

That is correct for the original cross-provider review milestone, but it cannot represent a legitimate cross-provider implementer. The fix must therefore add a new explicit mutation-capable execution contract rather than bypass or weaken the shipped policy.

## 2. Intent and success criteria

A root CONTROL actor must be able to delegate a bounded implementation packet to the other provider, allow that worker to modify only an isolated candidate workspace, independently inspect the produced implementation, and explicitly promote or discard a sealed mutation artifact.

Success requires all of the following:

1. `DelegationRequest.v1` remains semantically and behaviorally read-only.
2. A separate implementation contract grants exactly `LOCAL_READ + PROCESS_EXEC + WORKSPACE_EDIT`.
3. Mutation is limited to an isolated delegated workspace and an explicit machine-enforced path scope.
4. Worker network tools, recursive delegation, publication, remote-repository mutation, and canonical-repository mutation remain forbidden.
5. Canonical CONTROL workspace and canonical Git state remain unchanged during delegated execution.
6. Worker-produced changes are broker-derived and sealed; model output cannot self-report itself into a Candidate.
7. CONTROL can inspect/test the sealed workspace before promotion.
8. Promotion is a separate explicit CONTROL action and fails closed if the canonical baseline or artifact changed.
9. Failure never silently falls back to same-provider/manual implementation.
10. Existing review, Doctor, packaging, contamination, turn-economy and release invariants remain green.

## 3. Existing foundation

The current repository already provides the needed base:

- provider-neutral delegation policy/contracts;
- neutral broker/composition root under `runtime/delegation/**`;
- provider-local Codex and Antigravity executors;
- bounded process execution and sanitized provider environments;
- dirty source snapshot materialization;
- symlink-egress checks;
- Git-hook disabling for broker Git operations;
- canonical refs/config/hooks fingerprinting;
- process-tree termination;
- recursive-delegation fencing;
- project-owned `.orchestra/state/**` excluded from product fingerprints;
- `ImplementationPacket` goal/scope/validation/failure policy;
- Candidate/Evidence/Acceptance state machines owned by CONTROL.

The mutable path must extend this neutral plane, not create a second control plane.

## 4. Alternatives considered

### 4.1 Relax v1 in place

Allow `WORKSPACE_EDIT` and mutation in `DelegationRequest.v1`.

**Rejected.** V1 is shipped and field-proven as a read-only capability boundary. Relaxing it would silently change the meaning of existing requests, tests, persisted records and security assumptions.

### 4.2 Mutate the current linked Git worktree

Keep the current lifecycle and allow a dirty worktree for `IMPLEMENTER`.

**Rejected.** A linked worktree shares the repository's common Git infrastructure. Detection after a forbidden Git mutation is weaker than physically isolating a write-capable worker.

### 4.3 Separate implementation control plane

Create a second broker/runtime for mutable workers.

**Rejected.** It duplicates discovery, process boundaries, lifecycle, state, Doctor and provider composition and invites security drift.

### 4.4 Selected design: additive v2 implementation protocol

Keep v1 exactly read-only. Add a v2 request/result pair specifically for bounded implementation while retaining the existing neutral broker and provider executors.

V2 workers run in an **independent local ephemeral clone**, not a linked worktree. Orchestra seals the produced delta as a local Mutation Artifact and retains the isolated clone for CONTROL review. Promotion/discard are explicit later CONTROL operations.

## 5. Normative invariants

### 5.1 Execution delegation is not authority transfer

The worker does not receive Work Lease ownership, generation-advance authority, Candidate/Evidence promotion authority, Acceptance authority, release/publication authority, or recursive delegation authority.

### 5.2 V1 remains immutable in meaning

`orchestra.delegation-request.v1` remains exactly the read/process-exec contract. Existing v1 policy tests become regression guards against accidental privilege expansion.

### 5.3 V2 represents implementation only

The first v2 milestone is deliberately narrow:

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

The worker never runs with the canonical checkout as `cwd`. V2 uses an independent clone with its own `.git` storage so ordinary worker Git operations do not share canonical refs/config/hooks/object storage.

### 5.5 Scope is machine-enforced

`ImplementationPacket.scope.allowedAreas` remains human/task context and is not treated as a sufficient security boundary.

V2 adds an explicit normalized mutation scope containing repository-relative allowed/forbidden path patterns. Orchestra derives the actual changed path set after execution and rejects any change outside the authorized set or inside mandatory forbidden regions.

Mandatory forbidden regions include at least:

```text
.git/**
.orchestra/state/**
```

Absolute paths, parent traversal and normalized egress are invalid.

### 5.6 Model output never defines mutation facts

Changed paths, patch bytes, hashes and workspace identity are derived by Orchestra from Git/filesystem state. The worker report remains only a bounded model claim.

### 5.7 Delegation result is not Candidate or Acceptance

```text
DelegationResult != Evidence
DelegationResult != Candidate
DelegationResult != Acceptance
```

A successful v2 result may reference a sealed **Mutation Artifact**. Promotion only materializes an already-reviewed delta under CONTROL authority; normal Candidate/Evidence/Acceptance workflow follows afterward.

## 6. V2 request contract

Add `schemas/delegation-request.v2.schema.json` with an implementation-only shape:

```ts
DelegationRequestV2 {
  schema: "orchestra.delegation-request.v2"
  delegationId
  taskId
  source: { provider, actorIdHash }
  target: { provider, logicalRole: "IMPLEMENTER" }
  purpose: "IMPLEMENTATION"
  packet: ImplementationPacket

  authority: {
    capabilities: ["LOCAL_READ", "PROCESS_EXEC", "WORKSPACE_EDIT"]
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

`allowedPaths` is non-empty. Core validation rejects unsafe path syntax beyond what JSON Schema should express.

## 7. V2 result and Mutation Artifact

Add `schemas/delegation-result.v2.schema.json`.

A successful result may contain a broker-derived artifact descriptor:

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

`delegatedPath` is local broker metadata for CONTROL review and never authority. Failure results do not expose a promotable artifact.

## 8. Mutable workspace lifecycle

### 8.1 Authorize before allocation or external execution

Before provider discovery or workspace creation:

- schema validates;
- source provider matches root actor;
- target differs from source;
- role/purpose are exactly `IMPLEMENTER`/`IMPLEMENTATION`;
- exact v2 capability set is present;
- mutation is `WORKSPACE_ONLY`;
- network and recursive delegation are forbidden;
- source revision/fingerprint matches canonical workspace;
- mutation scope is safe.

### 8.2 Create a hardened independent local clone

The broker creates the clone outside the canonical checkout using only the local repository as source. No remote network is required.

The clone boundary is stronger than merely having a separate `.git` directory. The implementation MUST ensure:

- clone storage resolves outside the canonical checkout;
- `git clone --no-hardlinks` or an equivalent copy-isolating mechanism is used;
- no object alternates reference canonical Git storage;
- all inherited remotes are removed before the worker starts;
- the worker cannot use a local `origin`/file transport to push into the canonical repository;
- broker Git commands disable hooks;
- the worker receives an isolated Git configuration: system config disabled, a broker-created empty global config, and a clone-local empty hooks path;
- remote Git protocols are disabled for the worker execution environment/config, independently of the model prompt;
- unsafe canonical Git config is not inherited;
- the clone is attributable to one delegation/artifact ID;
- the boundary works on supported Ubuntu and Windows CI surfaces.

Provider sandboxing remains mandatory. Canonical workspace/Git fingerprint checks remain a defense-in-depth detector even though the clone is independently isolated.

### 8.3 Materialize the exact source snapshot

The clone starts at `sourceRevision`. Existing dirty/staged/unstaged/untracked snapshot logic is reused/adapted so the delegated implementation sees the same product state as CONTROL.

After materialization, Orchestra creates a **synthetic baseline commit inside the independent clone only**. It exists solely to define the exact pre-worker content baseline and never touches canonical Git storage or refs.

The synthetic baseline uses hooks disabled, fixed Orchestra-local identity, no signing and no network.

This is required because a canonical workspace may already be dirty: the final worker delta must exclude those pre-existing changes.

### 8.4 Run the provider implementer

Executors select their prompt from request version/capability profile. V2 authorizes modification only inside the supplied mutation scope while network use and delegation remain forbidden.

Provider inference transport is infrastructure, not worker network authority.

The worker returns the existing bounded report shape. Orchestra does not trust the report for filesystem facts.

### 8.5 Derive and validate actual mutation

After execution Orchestra derives the changed path set from the clone and verifies:

- every changed path is allowed;
- no changed path is request-forbidden or Orchestra-mandatory-forbidden;
- changed symlinks cannot escape the clone;
- canonical product fingerprint is unchanged;
- canonical refs/config/hooks fingerprint is unchanged;
- the clone still has the expected synthetic baseline lineage.

Violation produces no promotable artifact.

### 8.6 Seal the artifact

Inside the independent clone, Orchestra stages the validated worker delta with hooks disabled and creates a binary/full-index patch from synthetic baseline to staged result.

Because the baseline already contains the canonical pre-existing dirty snapshot, the patch represents **only worker delta** while covering new/deleted/binary files.

Project-owned state stores:

```text
.orchestra/state/delegation/artifacts/<artifact-id>/manifest.json
.orchestra/state/delegation/artifacts/<artifact-id>/candidate.patch
```

The manifest contains delegation/task identity, source actor/provider, CONTROL generation, source revision/fingerprint, canonical Git boundary fingerprint, retained clone path, normalized mutation scope, changed paths, patch SHA-256, mutation content digest and lifecycle state.

`mutationDigest` is independent of synthetic commit SHA and is computed from normalized changed-path facts (path, kind, mode and content/link hash) so it can be rechecked after promotion.

### 8.7 Retain for independent review

A successful v2 clone is retained as a sealed review workspace until explicit promote/discard.

CONTROL can inspect actual modified files, run local tests, compare report vs reality and decide whether to promote.

Before promotion, Orchestra regenerates/rechecks patch hash and mutation digest. Any post-seal change yields `ARTIFACT_TAMPERED`.

### 8.8 Explicit promotion

Add a neutral broker operation conceptually equivalent to:

```ts
promoteDelegationArtifact({ repoRoot, artifactId, generation, actor })
```

Promotion verifies:

1. artifact state is `READY_FOR_REVIEW`;
2. actor matches original root source actor;
3. CONTROL generation matches artifact generation;
4. canonical source fingerprint still exactly matches artifact baseline;
5. canonical Git boundary fingerprint is unchanged;
6. retained clone still matches sealed patch hash/digest;
7. paths still satisfy original scope;
8. `git apply --check` succeeds against canonical workspace;
9. patch application produces the sealed changed-file content/mutation digest.

Only then may Orchestra apply the worker delta to the canonical workspace.

The apply step must preserve the canonical workspace's pre-existing staged/unstaged baseline rather than restaging or duplicating it. Promotion does not create Acceptance or auto-promote Evidence/Candidate state.

### 8.9 Explicit discard

A sibling operation discards a `READY_FOR_REVIEW` artifact and cleans its retained clone without changing canonical product state.

### 8.10 Cleanup and recovery

Failures before sealing attempt immediate cleanup. Successful implementation retains the clone until promote/discard.

Cleanup is attribution-bound. If cleanup fails, the state record retains a recoverable path and Doctor reports it; broad destructive cleanup is forbidden.

## 9. Failure taxonomy

V1 taxonomy remains unchanged.

V2 adds only the factual families needed for mutable execution:

```text
SCOPE_VIOLATION
ARTIFACT_SEAL_FAILED
ARTIFACT_TAMPERED
PROMOTION_STALE
PROMOTION_FAILED
```

Existing provider/capability/workspace/execution/timeout/result/cleanup reason families are reused. No failure implies provider fallback or manual implementation.

## 10. Provider executor behavior

### Antigravity

V1 continues to say `Do not modify files`. V2 explicitly authorizes only scoped workspace mutation while keeping network and delegation forbidden. `agy --sandbox` remains enabled.

### Codex

V1 remains logically read-only despite the executor's physical `workspace-write` sandbox. V2 changes the prompt to allow scoped mutation. The broker, not the prompt, enforces actual changes.

### Shared rule

Executors do not receive promotion authority and do not write canonical Orchestra state. They execute in the supplied isolated workspace and return only bounded report/execution facts.

## 11. Broker and CLI surface

The neutral broker remains lifecycle owner and gains version-aware execution plus explicit artifact actions.

Existing v1 CLI invocation stays backward compatible. Prefer a separate neutral artifact CLI over destabilizing the shipped parser, for example:

```text
cli.mjs <existing v1 flags>
cli.mjs execute <v2 request flags>        # exact syntax may remain compatible without subcommand
artifact-cli.mjs inspect --artifact <id> --repo-root <root>
artifact-cli.mjs promote --artifact <id> --repo-root <root> --generation <n>
artifact-cli.mjs discard --artifact <id> --repo-root <root> --generation <n>
```

Exact CLI spelling is an implementation decision; authority semantics are not.

## 12. Routing policy

This hotfix does not make cross-provider implementation automatic merely because another provider exists.

Cross-provider implementation requires explicit CONTROL intent. Same-provider/local implementation remains the normal default.

No silent fallback is allowed:

```text
Codex CONTROL -> AGY implementation requested -> AGY unavailable
= PROVIDER_UNAVAILABLE
```

not silent Codex/manual implementation.

## 13. Security properties that must survive

The implementation preserves all 1.1.0 hardening, including:

- dirty/uncommitted snapshot fidelity;
- symlink egress protection;
- broker Git hooks disabled;
- canonical refs/config/hooks protection;
- sanitized delegated environment;
- process-tree termination;
- recursive-delegation fencing;
- neutral-only provider packaging;
- duplicate-install safety;
- forbidden worker-envelope paths;
- project state excluded from product fingerprints;
- provider-runtime firewall and contamination rules.

V2 adds clone/remotes/config/protocol isolation; it does not replace existing defenses.

## 14. Required TDD and verification matrix

Implementation begins with RED tests.

### Contract/policy

- v1 still rejects `WORKSPACE_EDIT`/mutation;
- v2 accepts exactly the implementation capability set;
- v2 rejects mixed/unknown capability combinations;
- v2 rejects network, recursion, wrong role/purpose and non-clone isolation;
- unsafe mutation-scope syntax fails.

### Clone/Git isolation

- clone has independent `.git` and no object alternates/hardlink dependency;
- clone has no worker-visible remotes before execution;
- worker Git config cannot inherit global/system hooks or remote protocol allowance;
- worker `git config`, branch/ref creation, local commit or attempted push cannot mutate canonical refs/config/hooks;
- canonical workspace fingerprint remains unchanged during execution;
- dirty/staged/untracked source state is reproduced exactly;
- synthetic baseline makes sealed patch contain only worker delta.

### Scope enforcement

- allowed tracked edit/new file/deletion/binary change passes;
- out-of-scope mutation fails;
- mandatory forbidden paths fail even if request tries to allow them;
- symlink egress fails;
- scope failure creates no promotable artifact.

### Artifact sealing/review

- broker-derived changed paths match reality;
- patch hash and mutation digest are deterministic;
- success returns `READY_FOR_REVIEW`;
- retained clone is available for independent review;
- post-seal modification blocks promotion as tampering.

### Promotion/discard

- unchanged baseline promotes exactly worker delta;
- pre-existing dirty/staged canonical state is preserved and not duplicated/restaged;
- stale canonical fingerprint blocks promotion;
- canonical Git boundary drift blocks promotion;
- patch-check failure leaves canonical state unchanged;
- post-apply content matches mutation digest;
- successful promotion/discard cleans clone and transitions artifact terminally;
- cleanup failure remains recoverable/Doctor-visible.

### Provider behavior

- AGY v1 prompt stays read-only;
- AGY v2 prompt allows only scoped workspace mutation;
- Codex v1 stays read-only by contract;
- Codex v2 gets scoped implementation prompt;
- both keep network/delegation prohibitions;
- model output cannot forge changed paths or artifact hashes.

### Regression/package surfaces

- generated validators synchronized;
- runtime-core manifests synchronized;
- neutral delegation package includes required v2/artifact surfaces;
- provider runtimes do not gain sibling control-plane code;
- Doctor/contamination/firewall green;
- full `npm test` green;
- portable Ubuntu/Windows runtime tests green;
- release-readiness and turn-economy surfaces green.

## 15. Rollout boundary

The fix is implemented and validated in Orchestra first. Tsuzuki is not modified during this work.

After the Orchestra change is complete, independently reviewed, integrated and released through the existing Release Train, Tsuzuki synchronization remains a separate operator-controlled action. F7 then restarts from its preserved baseline using the new canonical mutable delegation path.

## 16. Definition of done

The work is complete only when:

1. v1 read-only behavior is demonstrably unchanged;
2. v2 works for Codex -> AGY and AGY -> Codex;
3. write-capable worker Git/filesystem activity is physically isolated from canonical Git;
4. actual changed paths are machine-enforced;
5. successful worker output becomes a sealed reviewable Mutation Artifact, not an autoaccepted Candidate;
6. CONTROL can inspect, promote or discard it;
7. stale/tampered promotion fails without canonical mutation;
8. adversarial canonical workspace/Git integrity tests pass;
9. packaging, Doctor, contamination/firewall, full regression and portable CI are green;
10. Tsuzuki remains untouched until a separate downstream rollout gate.
