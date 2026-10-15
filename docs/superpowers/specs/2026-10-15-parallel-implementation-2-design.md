# Parallel Implementation 2 Design

Status: DRAFT — pending operator review
Date: 2026-10-15
Base: Orchestra v1.2.0 (`879db4df6cbf067f2536a82f62a2cf287f3fe19f`)

## 1. Purpose

Add a bounded parallel implementation mode in which one CONTROL actor can split one implementation task into exactly two independent shards and execute both at the same time through isolated workers, while preserving Orchestra's core invariant that execution may be delegated but project authority may not.

The first release intentionally supports only `PARALLEL_IMPLEMENTATION_2`:

- exactly two implementation shards;
- same task, Work Lease generation, source revision, source product fingerprint, and canonical Git boundary;
- disjoint mutation scopes proven before dispatch;
- independent hardened clones for both workers;
- no worker writes to the canonical checkout;
- broker-derived Mutation Artifacts for each worker;
- factual changed-path disjointness checked after execution;
- atomic composition into one Composite Mutation Artifact;
- one CONTROL inspect/promote/discard decision;
- one eventual Candidate/Evidence/Acceptance path.

This workstream also contains one isolated compatibility hotfix discovered during the first real v1.2.0 AGY implementation attempt. AGY 1.3.5 writes `agy --help` to stderr, while the current Antigravity executor reads only stdout during discovery. The hotfix is a prerequisite for exercising the feature with Codex/ChatGPT as CONTROL and AGY as one implementation worker, but it does not alter the parallel architecture.

## 2. Non-goals

The first version does not support:

- more than two implementation workers;
- overlapping mutation scopes;
- intelligent conflict resolution or three-way merge;
- worker-to-worker communication;
- dynamic work stealing or rebalancing;
- partial promotion when only one worker succeeds;
- parallel retries;
- relaxing v1 review semantics;
- relaxing standalone v2 cross-provider implementation semantics;
- transferring Candidate, Evidence, Acceptance, publication, or finish authority to workers.

## 3. Precondition Hotfix: AGY Help Discovery

The Antigravity delegation executor currently requires `agy --version` and `agy --help` to complete with exit code 0 and no stdout truncation, then discovers required flags from `helpResult.stdout` only.

Observed AGY 1.3.5 behavior:

- `agy --version`: exit 0; version on stdout;
- `agy --help`: exit 0; full help on stderr; stdout empty.

The fix is intentionally narrow:

1. preserve timeout and non-zero exit fail-closed behavior;
2. fail closed if either `stdoutTruncated` or `stderrTruncated` is true;
3. discover help flags from the concatenation of stdout and stderr;
4. continue requiring `--print`, `--print-timeout`, `--sandbox`, and `--model`;
5. continue treating `--mode` as the factual implementation capability signal;
6. do not change execution arguments, sandboxing, provider environment, broker policy, schemas, or worker output parsing.

Regression coverage must reproduce AGY 1.3.5 exactly and prove stderr truncation remains unavailable.

## 4. Existing Invariants Preserved

Parallel implementation must preserve all v1.2.0 invariants:

- CONTROL remains the only project authority.
- `WORKSPACE_EDIT` workers never mutate the canonical checkout directly.
- each implementation worker runs in an external hardened `EPHEMERAL_CLONE` with no hardlinks, inherited remotes, alternates, active hooks, or worker Git network protocols;
- model output cannot define changed paths, patch bytes, or mutation digest;
- `.git/**` and `.orchestra/state/**` remain mandatory forbidden regions;
- symlink egress remains denied;
- canonical product and canonical Git boundaries are fingerprinted;
- stale or tampered artifacts fail closed;
- promotion does not restage unrelated canonical state;
- delegation depth remains one and workers may not recursively delegate.

`PARALLEL_IMPLEMENTATION_2` expands execution concurrency, not authority concurrency.

## 5. Why Both Workers Must Be Isolated

A local same-provider implementer may not write directly to the canonical checkout while the external worker runs. If it did, the canonical source fingerprint would move and the other artifact would correctly become stale.

Therefore both implementation shards execute from the exact same immutable source snapshot in isolated clones. Even the worker that uses the same provider as CONTROL is treated as an execution-plane worker for this mode.

Standalone v2 behavior remains unchanged: an ordinary delegation request still requires `target.provider !== source.provider`. Same-provider implementation is permitted only as a member of a validated parallel group created by CONTROL.

## 6. Parallel Group Contract

Introduce a provider-neutral parallel implementation group contract. A group contains exactly two members and facts that are immutable for the lifetime of the group.

Conceptual shape:

```json
{
  "schema": "orchestra.parallel-implementation-group.v1",
  "groupId": "...",
  "taskId": "...",
  "generation": 7,
  "source": {
    "provider": "codex",
    "actorIdHash": "sha256:..."
  },
  "sourceRevision": "...",
  "sourceFingerprint": "sha256:...",
  "canonicalGitFingerprint": "sha256:...",
  "members": [
    {
      "memberId": "a",
      "targetProvider": "codex",
      "packet": { "schema": "orchestra.implementation-packet.v1" },
      "mutationScope": { "allowedPaths": ["..."], "forbiddenPaths": ["..."] }
    },
    {
      "memberId": "b",
      "targetProvider": "antigravity",
      "packet": { "schema": "orchestra.implementation-packet.v1" },
      "mutationScope": { "allowedPaths": ["..."], "forbiddenPaths": ["..."] }
    }
  ]
}
```

Exact schema details may be refined in implementation planning, but the following are mandatory:

- exactly two members;
- unique member IDs;
- both packets use the same `taskId` and `candidateGeneration` as the group generation;
- each member is an `IMPLEMENTER` with `LOCAL_READ + PROCESS_EXEC + WORKSPACE_EDIT`, `WORKSPACE_ONLY`, network forbidden, delegation forbidden, `EPHEMERAL_CLONE`;
- at least one member may be same-provider with CONTROL;
- member target providers must be distinct in v1 of this feature, so the intended lane is one local-provider worker plus one other installed provider;
- no member may be CONTROL itself; they are execution-plane children with separate worker provenance.

## 7. Scope Independence

Parallelism is authorized only when Orchestra can prove the two mutation scopes are disjoint before execution.

The existing mutation-scope grammar is intentionally simple: exact repo-relative paths plus terminal subtree patterns ending in `/**`, with `**` as whole-product wildcard where already permitted by current grammar.

The parallel scope validator must conservatively reject a group when overlap cannot be disproven. Examples that must be denied:

- `app/**` vs `app/src/**`;
- `src/a.kt` vs `src/**`;
- `**` paired with any other non-empty writable scope;
- lexical equivalents after normalization;
- path traversal, absolute paths, or any already-invalid scope.

Examples that may be accepted:

- `app/home/**` vs `app/library/**`;
- `src/a.kt` vs `src/b.kt`;
- `app/detail/**` vs `domain/metadata/**`.

This pre-dispatch check is necessary but not sufficient. After both workers finish, Orchestra must also require:

`changedPaths(A) ∩ changedPaths(B) = ∅`

using broker-derived changed paths from the sealed member artifacts. Worker reports never establish disjointness.

## 8. Member Execution

CONTROL creates the parallel group and dispatches both member executions concurrently.

Each member gets:

- its own hardened mutable clone;
- its own Implementation Packet;
- its own mutation scope;
- its own provider-local model profile;
- its own timeout/output limits;
- the same immutable source baseline and group generation.

The existing provider executors should be reused. The Codex implementation executor already supports `workspace-write` inside the isolated clone and AGY already supports implementation mode. No new model-specific execution plane should be introduced.

The policy exception allowing same-provider execution must require a broker-created parallel member context. It must not be expressible by a normal standalone v2 request from a worker or ordinary CLI caller.

## 9. Member Artifacts

Each successful member is inspected and sealed using the existing broker-owned mutation-fact mechanism.

Member artifacts remain individually tamper-evident and contain their normal facts:

- source revision/fingerprint;
- canonical Git fingerprint;
- delegated path;
- synthetic baseline;
- mutation scope;
- factual changed paths;
- patch hash;
- mutation digest.

They are not independently promotable while bound to an active parallel group. This prevents bypassing atomic group semantics by promoting one member directly.

A group fails if either member:

- is unavailable;
- times out;
- returns invalid output;
- mutates outside scope;
- mutates protected Git/runtime state;
- produces a tampered artifact;
- otherwise fails the existing v2 implementation lifecycle.

A completed sibling may be retained long enough to support deterministic failure handling and diagnostics, but failed groups must not produce canonical product mutation.

## 10. Atomic Composition

If both member artifacts are valid and their factual changed paths are disjoint, the broker creates a third hardened composition clone from the same exact source snapshot.

Composition is broker-owned and deterministic:

1. verify both artifacts again;
2. verify group identity, generation, source revision/fingerprint, canonical Git fingerprint, and scopes;
3. prove member changed paths are disjoint;
4. apply member patches into the composition clone in deterministic member-ID order;
5. if either patch fails to apply, fail the group;
6. derive combined mutation facts from the resulting filesystem/Git state;
7. verify combined facts equal the union of the two member fact sets;
8. stage the combined delta with hooks disabled;
9. create one binary/full-index patch from the synthetic source baseline;
10. seal one Composite Mutation Artifact.

No member patch is applied to the canonical checkout during composition.

## 11. Composite Mutation Artifact

Introduce a distinct artifact type rather than pretending two member artifacts are one ordinary delegation artifact.

Conceptual manifest:

```json
{
  "schema": "orchestra.parallel-composite-artifact.v1",
  "artifactId": "...",
  "groupId": "...",
  "taskId": "...",
  "generation": 7,
  "source": {
    "provider": "codex",
    "actorIdHash": "sha256:..."
  },
  "sourceRevision": "...",
  "sourceFingerprint": "sha256:...",
  "canonicalGitFingerprint": "sha256:...",
  "memberArtifactIds": ["...", "..."],
  "changedPaths": ["..."],
  "patchSha256": "sha256:...",
  "mutationDigest": "sha256:...",
  "state": "READY_FOR_REVIEW"
}
```

The composition clone is retained for CONTROL review using the same review-workspace trust model as v1.2.0 artifacts.

Member artifacts transition to a non-promotable consumed state only after the composite artifact is durably sealed. Cleanup state remains explicit and recoverable.

## 12. Inspect, Promote, and Discard

CONTROL gets explicit operations for the Composite Mutation Artifact.

`inspect` revalidates:

- composite manifest and patch hashes;
- retained composition clone;
- combined mutation digest;
- referenced member identities and sealed facts;
- group/source/generation consistency.

`promote` requires the original root CONTROL provider/actor hash and Work Lease generation, then:

- acquires the existing promotion lock and Work Lease fence;
- rechecks artifact integrity;
- rechecks canonical source product fingerprint and canonical Git boundary against the original baseline;
- runs `git apply --check` for the single composite patch;
- applies the composite delta without `--index`;
- verifies the canonical mutation digest;
- proves the pre-existing canonical index is unchanged;
- transitions the composite artifact to `PROMOTED`;
- cleans the composition clone and remaining retained member workspaces.

`discard` transitions the composite artifact to `DISCARDED` and cleans all retained group workspaces without touching canonical product state.

There is no partial member promotion API for an active/completed parallel group.

## 13. Routing and CONTROL Decision

Serial Direct Work remains the default.

Parallel implementation is selected explicitly by CONTROL only when it has already resolved the task into two bounded implementation shards whose writable scopes are provably independent. The mode must never be selected merely because two providers are available.

A first version may expose this as a routing decision such as:

`PARALLEL_IMPLEMENTATION = SERIAL | PARALLEL_2`

but it must remain separate from Milestone-K exploration `PARALLELISM`; exploration parallelism and implementation parallelism have different authority and mutation semantics.

The cross-provider delegation budget default of one must not be globally relaxed. Parallel groups get their own bounded two-member reservation under the group contract.

## 14. Failure Semantics

The group is atomic from the canonical workspace's perspective.

Any of the following fails the whole group with no canonical product mutation:

- invalid group contract;
- overlapping pre-dispatch scopes;
- worker discovery failure;
- one or both member execution failures;
- member scope violation;
- member artifact tamper;
- overlapping factual changed paths;
- composition patch failure;
- mismatch between combined facts and union of member facts;
- canonical source or Git boundary drift before promotion;
- Work Lease generation/actor mismatch;
- promotion verification failure.

Failure must remain explicit; no silent fallback to serial/manual mutation is allowed. CONTROL may choose a new serial retry only as a new explicit decision after the failed group is closed.

## 15. Provider Symmetry

The feature must work in both directions:

- Codex/ChatGPT CONTROL → Codex worker + AGY worker;
- Antigravity CONTROL → AGY worker + Codex worker.

Provider control-plane adapters may expose convenience builders/wrappers, but the group, composition, and lifecycle authority stay provider-neutral.

## 16. State, Doctor, Packaging, and Runtime Updates

Parallel group records and composite artifacts live under the existing Orchestra volatile state namespace and are preserved by runtime updates.

Doctor should distinguish:

- ordinary cross-provider review readiness;
- ordinary v2 implementation readiness;
- parallel implementation readiness, which requires two implementation-capable providers plus composition capability.

A READY composite is pending CONTROL review, not a cleanup failure.

Packaging must include all neutral group/composition lifecycle code and the necessary provider adapters without broadening provider runtime contamination.

## 17. Testing Strategy

Implementation follows RED → GREEN.

Required focused coverage includes:

### AGY compatibility hotfix

- AGY help entirely on stderr is discovered successfully;
- mixed stdout/stderr help is discovered successfully;
- stderr truncation fails closed;
- stdout truncation still fails closed;
- missing required flag still fails closed;
- non-zero exit and timeout remain unavailable.

### Parallel group contracts

- exactly two members required;
- same task/generation/baseline required;
- distinct target providers required;
- same-provider standalone v2 remains denied;
- same-provider member allowed only with broker-created group context.

### Scope independence

- disjoint files/subtrees accepted;
- parent/child overlap rejected;
- exact/subtree overlap rejected;
- wildcard ambiguity rejected;
- normalized aliases/path traversal rejected.

### Concurrent execution

- both workers start from identical source snapshot;
- each gets independent clone/environment;
- one failure prevents composition/promotion;
- no canonical product mutation occurs during worker execution.

### Composition

- text + text disjoint patches compose;
- text + binary compose;
- create/delete/mode/symlink facts remain deterministic;
- factual changed-path overlap fails even if promised scopes were disjoint;
- patch application conflict fails closed;
- composite mutation digest equals combined filesystem facts;
- tampered member artifacts fail closed.

### Promotion

- composite promotion preserves pre-existing staged/unstaged/untracked canonical state;
- wrong actor/provider/generation denied;
- source/product/Git drift produces stale failure;
- concurrent promotion is locked;
- failed post-apply verification rolls back;
- no Candidate/Evidence/Acceptance is synthesized by promotion.

### Regression

- v1 review semantics unchanged;
- standalone v2 behavior unchanged;
- serial Direct Work unchanged;
- Doctor, installers, runtime-core parity, generated runtimes, firewall/contamination, release readiness, turn-economy, Ubuntu, and Windows remain green.

## 18. Rollout

This implementation is developed only in Orchestra. Tsuzuki remains untouched until an Orchestra release containing both the AGY discovery hotfix and Parallel Implementation 2 has passed the normal release train.

No version number is chosen in this design. Release Train classification remains authoritative; because Parallel Implementation 2 is a feature, a minor bump is expected unless the repository's release classifier determines otherwise.

After release, Tsuzuki receives a normal local runtime synchronization. Only then should F7 be retried with the new runtime.

## 19. Definition of Done

The workstream is done when all of the following are true:

- AGY 1.3.5-style stderr help is discovered without weakening fail-closed checks;
- one CONTROL can execute exactly two independent implementation workers concurrently against one source baseline;
- both workers remain isolated from the canonical checkout;
- same-provider worker execution is impossible outside a valid parallel group;
- scopes are proven disjoint before dispatch and factual changed paths are proven disjoint after execution;
- successful members compose into one broker-owned Composite Mutation Artifact;
- group failures never partially mutate the canonical workspace;
- CONTROL alone can inspect/promote/discard the composite artifact;
- promotion preserves pre-existing canonical staged/unstaged/untracked state;
- Candidate/Evidence/Acceptance authority remains unchanged;
- provider symmetry is covered;
- full regression, packaging, Doctor, installers, firewall/contamination, release readiness, Ubuntu, and Windows CI are green on the exact integration head;
- Tsuzuki has not been modified during Orchestra development.
