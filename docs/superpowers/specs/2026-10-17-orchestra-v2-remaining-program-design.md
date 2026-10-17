# Orchestra v2 Remaining Program — V2-5 through V2-11

Date: 2026-10-17
Status: awaiting written-spec review
Base implementation: V2-4 / `feat/v2-reconciler-recovery` at `a3002edb1493cc86e8e9f713477db3add31d1799`
Existing detailed V2-5 design: `docs/superpowers/specs/2026-10-17-v2-codex-global-adapter-design.md`
Execution target: Codex
Execution doctrine: Sol orchestrates, Luna implements

## 1. Purpose

This document closes the remaining architectural program for Orchestra v2 after V2-4 and defines the handoff boundary to Codex for implementation-only execution.

V2-0 through V2-4 established the difficult neutral core:

- provider-neutral domain contracts;
- global Project Registry and durable persistence;
- sessionless Work authority and Active Work Head;
- factual Operation liveness;
- deterministic Reconciler, recovery journal and dirty-workspace recovery.

The remaining work is not a new architecture exercise. It is the completion and productization of the already approved global-control-plane thesis:

```text
V2-5  Codex Global Adapter
V2-6  Antigravity Global Adapter
V2-7  Runtime Images + project pinning/upgrades
V2-8  Global Experience Store
V2-9  Cross-project Dream / RSI
V2-10 Migration + removal of project-local 1.x architecture
V2-11 Cutover, self-hosting and release
```

The program is complete only when Orchestra operates as a user-global control plane, registered projects no longer require independent local Orchestra brains, both supported providers consume the same neutral authority/liveness/recovery contracts, runtime upgrades cannot deadlock behind stale local state, sanitized experience can generalize across projects, and the v1 deployment topology is no longer required for normal operation.

## 2. Fixed architectural thesis

The following decisions are closed and must not be reopened during implementation:

1. Orchestra v2 is a **user-global control plane**.
2. Projects are **registered**, not populated with a full Orchestra runtime.
3. Project state is globally stored but strictly **project-namespaced**.
4. Session/conversation IDs are **ActorProvenance**, never project ownership.
5. Work authority belongs to `Project + Active Work + generation`, not to chat lifetime.
6. Persisted `RUNNING` is never proof of factual liveness.
7. Mutation exclusivity belongs to bounded Operations, never permanent session leases.
8. Recovery is first-class, deterministic, auditable and idempotent.
9. Provider adapters translate provider facts but do not own neutral governance.
10. Cross-project learning consumes sanitized Experience records, not source code, raw prompts or transcript memory.
11. Learned policy cannot redefine immutable governance ceilings.
12. Runtime image installation/recovery logic must live above a broken project runtime so runtime N cannot prevent recovery by N+1.
13. A project may retain only minimal provider-required shims or identity markers; no independently evolving `.codex`, `.agents` or `.orchestra/runtime` brain is recreated for convenience.
14. V1 compatibility remains protected until the explicit migration/cutover milestones remove it.

## 3. Codex execution doctrine — implementation only

This program is transferred to Codex under a strict implementation-only workflow.

### 3.1 Roles

**Sol = orchestrator.** Sol owns:

- reading this spec and the implementation plan;
- maintaining milestone/task order and dependency integrity;
- selecting the next bounded implementation task;
- assigning implementation to Luna;
- checking RED/GREEN evidence, diffs and CI;
- deciding retry, rollback or escalation;
- ensuring no milestone silently expands scope;
- preparing review checkpoints and final acceptance evidence.

Sol should not perform substantial implementation itself merely because it can. It may make tiny orchestration-only edits when explicitly necessary to unblock the workflow, but ordinary code/test/doc changes belong to Luna.

**Luna = implementer.** Luna owns:

- bounded code changes already specified by the plan;
- tests and fixtures;
- conventional refactors required by those changes;
- documentation explicitly named by the plan;
- local verification assigned by Sol;
- returning exact evidence, changed paths and blockers.

### 3.2 No investigation workstream

There is no exploratory or research phase in Codex.

Allowed reading is **implementation-local inspection** only: Luna may inspect the exact files/modules/tests named by the implementation task to perform the specified change correctly.

The following are prohibited unless a later approved plan explicitly adds them:

- broad repository archaeology;
- open-ended “investigate how X works” tasks;
- redesigning subsystem boundaries;
- provider capability research not required by a concrete failing implementation test;
- speculative refactors;
- creating alternative architectures because implementation is inconvenient;
- asking a worker to rediscover requirements already stated here or in the plan.

If implementation encounters a fact that contradicts the spec or makes a task impossible, the result is:

```text
BLOCKED_BY_SPEC_GAP
```

The blocker report must contain:

- milestone/task ID;
- exact spec section in conflict;
- exact code/test fact proving the conflict;
- smallest decision required.

Luna must not solve a spec gap by inventing new architecture. Sol may resolve only choices already delegated by the plan; otherwise execution stops at that boundary for operator review.

### 3.3 TDD and evidence

All behavior changes follow RED → GREEN → refactor.

A milestone is not complete because code exists. It is complete only when:

- required tests prove the new contract;
- prior v2 invariant suites remain green;
- v1 compatibility guards required by the milestone remain green;
- portability coverage passes where the milestone touches Windows/Linux behavior;
- canonical CI succeeds on the exact reviewed head;
- the PR description records the exact head and canonical run.

No merge is implicit. Merge/release remains an operator gate unless the later implementation plan explicitly delegates a specific merge.

## 4. Program dependency graph

```text
V2-4 Reconciler / Recovery
          |
          v
V2-5 Codex Global Adapter
          |
          v
V2-6 Antigravity Global Adapter
          |
          v
V2-7 Runtime Images / Upgrades
          |
          v
V2-8 Global Experience Store
          |
          v
V2-9 Cross-project Dream / RSI
          |
          v
V2-10 Migration / De-localization
          |
          v
V2-11 Cutover / Self-host / Release
```

This order is intentional.

- V2-5 establishes the first real provider-to-global-core execution path and any neutral provider-managed Operation/liveness primitives required by host-driven tool calls.
- V2-6 must reuse those primitives rather than independently inventing an AGY authority model.
- V2-7 depends on both provider adapters because runtime activation/epoch changes must be consumable by both hosts.
- V2-8 begins only after provider and runtime facts have stable neutral shapes worth recording as Experience.
- V2-9 depends on V2-8 because Dream/RSI must train/evaluate over sanitized durable episodes rather than ad-hoc logs.
- V2-10 migrates consumers only after the new provider/runtime/experience surfaces are production-capable.
- V2-11 is a cutover gate, not a feature-development bucket.

## 5. Cross-program invariants

Every remaining milestone must preserve these executable laws:

### Authority

- no chat owns a Project;
- no session ID is a durable capability token;
- authority is always project/work/generation scoped;
- task switch and chat switch remain distinct;
- historical Work cannot resurrect execution;
- instruction epoch is checked on every relevant protected provider action.

### Liveness and recovery

- `RUNNING != LIVE`;
- missing factual owner proof never becomes `LIVE` by assumption;
- uncertainty remains `UNKNOWN` until a contract proves otherwise;
- stale/dead execution cannot create an eternal lock when deterministic recovery is factually possible;
- recovery cannot fabricate Candidate/Evidence success;
- dirty or ambiguous workspaces are never destructively deleted by guesswork;
- repeated recovery actions converge idempotently.

### Isolation

- Project A facts cannot authorize Project B;
- provider correlation IDs are always provider/project scoped;
- global storage does not mean un-namespaced state;
- raw source, secrets, private requirements and transcripts do not enter Experience by default;
- one provider adapter never imports another provider adapter to implement authority.

### Compatibility

Until V2-10 explicitly migrates a project:

- v1 project-local runtimes remain valid compatibility paths;
- v2 code does not silently mutate or reinterpret v1 state;
- generated/runtime mirror guards remain green;
- v2 remains outside the v1 `core/**` materialization boundary.

## 6. V2-5 — Codex Global Adapter

The detailed design is defined in:

`docs/superpowers/specs/2026-10-17-v2-codex-global-adapter-design.md`

This section fixes its program-level deliverables and acceptance boundary.

### 6.1 Deliverables

1. Thin project-local Codex hook shim that invokes the stable user-global Orchestra launcher.
2. Global `provider codex hook` surface.
3. Factual Codex `ActorProvenance` normalization.
4. Global project resolution from cwd/workspace through Project Registry.
5. Provider-scoped Session Observation storage under Orchestra Home.
6. `SessionStart` attach semantics with INTAKE behavior when there is no active Work.
7. Tool-event normalization into neutral READ/WRITE/COMMAND and side-effect classes.
8. `PreToolUse` authorization through neutral WorkAuthority.
9. Provider-managed tool Operation correlation using factual `tool_call_id`; no synthetic execution IDs.
10. Neutral provider-managed liveness contract for host-owned tool executions; no hook PID masquerading as the tool owner.
11. `PostToolUse` terminalization of exactly the matching Operation.
12. Structured Codex hook response translation and actionable recovery diagnostics.
13. Additive v2 shim installation/configuration that does not delete v1 runtime state.

### 6.2 Required acceptance scenarios

- fresh Codex chat attaches without predecessor handoff;
- two fresh chats can observe the same Work without stealing ownership;
- stale instruction epoch denies protected action with `SESSION_RUNTIME_STALE`;
- no active Work yields usable INTAKE, not a dead chat;
- stale Work ID is rejected even when numeric generation matches a new Work;
- mutation without factual tool correlation fails closed;
- duplicate/reordered PostToolUse events cannot terminalize another Operation;
- provider-managed in-flight mutation can become recoverable only under the neutral liveness contract;
- global launcher failure never silently falls back to v1 authority for a v2-managed project;
- Windows Codex Desktop hook execution is covered explicitly;
- full v1 Codex behavior remains green for unmigrated projects.

### 6.3 Exit condition

A deliberately registered v2 project can run the Codex lifecycle against global authority/state while the repository contains only a thin integration shim and no v2 governance brain.

## 7. V2-6 — Antigravity Global Adapter

V2-6 gives Antigravity the same global-domain semantics without cloning Codex-specific behavior.

### 7.1 Deliverables

1. Thin AGY project integration shim/configuration that delegates to global Orchestra.
2. Global `provider antigravity ...` entry surface appropriate to AGY host protocol.
3. Factual AGY ActorProvenance normalization from provider-supplied identity only.
4. Session/conversation observation equivalent to Codex Session Observation, with provider-specific shape behind a neutral freshness boundary.
5. Tool/delegation event normalization into existing neutral operation classes.
6. Sessionless attach and INTAKE behavior through WorkAuthority.
7. Mutation authorization through WorkAuthority and Operation Registry.
8. Reuse of V2-5 provider-managed Operation/liveness primitives for host-owned execution where applicable.
9. Provider-owned process invocation remains provider-specific but registers factual Operations and terminal facts globally.
10. Global diagnostics/recovery references rather than project-local state edits.
11. Additive compatibility with v1 AGY projects until migration.

### 7.2 Provider symmetry rule

Codex and AGY must converge on the same neutral semantics for:

- ActorProvenance;
- Work attach;
- generation/work identity fencing;
- instruction epoch freshness;
- mutation capability;
- Operation lifecycle;
- liveness classes;
- recovery classifications;
- evidence provenance boundaries.

They do not need identical hook/event mechanics.

### 7.3 Required acceptance scenarios

- fresh AGY conversation attaches to current Work without handoff;
- stale AGY conversation cannot mutate after epoch/work/generation changes;
- no active Work remains INTAKE-capable;
- AGY implementation execution registers factual global Operations;
- crash/timeout cannot leave a forever-live local delegation marker;
- ambiguous provider termination becomes `UNKNOWN` or recoverable only under proven facts;
- Codex and AGY may operate on the same registered Project without either becoming the other's authority source;
- cross-provider Direct Work still uses neutral Candidate/Evidence boundaries;
- v1 AGY compatibility remains green.

### 7.4 Exit condition

Both supported providers consume one global authority/liveness/recovery model and neither project requires a full local Orchestra runtime for v2 operation.

## 8. V2-7 — Runtime Images, Project Pinning and Upgrades

V2-7 separates the global engine from immutable project runtime images and eliminates the v1 bootstrap deadlock class.

### 8.1 Runtime image model

A runtime image is immutable and globally installed under Orchestra Home.

Conceptual record:

```yaml
schema: orchestra.runtime-image.v2
imageId: sha256:...
version: 2.x.y
manifestRef: blob:...
engineCompatibility: ...
providerAdapterCompatibility:
  codex: ...
  antigravity: ...
createdAt: ...
```

A Project stores a pin to one runtime image plus an instruction epoch.

### 8.2 Required capabilities

1. Install/verify immutable runtime images globally.
2. Content/integrity verification before activation.
3. Project pin update under explicit lifecycle/reconciliation gates.
4. Instruction epoch increment whenever provider-visible runtime semantics change.
5. Project upgrade command.
6. Project rollback to an already-installed compatible image.
7. Global engine update distinct from project runtime activation.
8. Compatibility checks between engine, runtime image and provider adapters.
9. Recovery path implemented above the currently pinned project image.
10. Read-only status showing installed images, project pin and compatibility.
11. Safe retention policy; automatic destructive garbage collection is not required for initial completion.

### 8.3 Bootstrap recovery law

A stale/corrupt Operation produced under runtime image N may block project mutation, but it must not block installation of engine/runtime N+1 or execution of N+1 recovery logic.

Project activation may be denied until state is reconciled. Global recovery tooling itself may not be denied merely because the pinned project runtime is broken.

### 8.4 Required acceptance scenarios

- install two runtime images once globally and pin different projects to different versions;
- upgrade one project without changing another;
- epoch advance fences sessions that observed the previous runtime semantics;
- rollback changes the project pin without modifying source repository contents;
- broken/stale state produced by runtime N is diagnosable/recoverable by newer global engine logic;
- upgrade cannot steal a LIVE mutation Operation;
- dirty recovery state blocks activation as appropriate but remains actionable;
- Windows/Linux runtime image paths and integrity checks pass.

### 8.5 Exit condition

No normal project update requires copying a new Orchestra runtime into the repository, and runtime versioning/recovery is controlled globally.

## 9. V2-8 — Global Experience Store

V2-8 turns reusable factual outcomes into a privacy-preserving, globally queryable experience substrate. It does not yet auto-promote learned policy.

### 9.1 Experience classes

The store supports at least:

1. **Diagnostic Experience** — failure signature, factual conditions, root cause class, recovery and outcome.
2. **Execution Experience** — abstract route/operation/providers, bounded metrics and terminal outcome.
3. **Provider/Tool Fact** — versioned provider capability/behavior observations.
4. **Performance Experience** — turn economy, latency buckets, retry counts and route outcome.
5. **Counterexample** — a prior pattern/policy that failed under a distinct project/lineage/context class.

### 9.2 Sanitization boundary

Experience creation is an explicit projection from project-private facts into an allowlisted schema.

Disallowed by default:

- source file contents;
- diffs containing product code;
- private requirements/user prompts;
- secrets/tokens/paths containing private user data beyond normalized classes;
- full transcripts;
- hidden reasoning;
- arbitrary artifact bytes.

Eligible normalized dimensions may include:

- provider family/version;
- OS/runtime family;
- Operation kind;
- failure/recovery class;
- timeout class;
- abstract domain profile;
- changed-path overlap counts/classes without source bytes;
- turn/latency/retry metrics;
- terminal outcome;
- project lineage diversity metadata.

### 9.3 Data model requirements

Every Experience record carries:

- stable schema/version;
- source project ID internally for provenance but not as model-visible cross-project context by default;
- lineage ID;
- sanitized domain cohort;
- originating Work/Operation references for audit;
- sanitization policy/version;
- factual evidence references/digests where appropriate;
- confidence/confirmation class;
- timestamps;
- dedupe/content identity;
- eligibility scope: PROJECT / DOMAIN / GLOBAL-CANDIDATE.

### 9.4 Promotion eligibility is not policy promotion

V2-8 may determine whether an Experience record is eligible to participate in domain/global evaluation. It must not itself modify routing/governance policy.

Single-lineage anecdotes cannot become global facts solely because they exist.

### 9.5 Required acceptance scenarios

- raw private fields are rejected or projected away;
- identical sanitized episodes dedupe deterministically;
- one project cannot read another project's private source facts through Experience APIs;
- provenance remains auditable to the originating project under authorized local inspection;
- diagnostic episodes from different projects can be grouped by sanitized signature;
- counterexamples are retained rather than overwritten by a successful majority pattern;
- corrupt Experience records fail closed.

### 9.6 Exit condition

The global control plane has a durable, sanitized substrate suitable for cross-project evaluation without sharing raw project context.

## 10. V2-9 — Cross-project Dream / RSI

V2-9 enables bounded recursive policy improvement using V2-8 Experience records while preserving immutable governance.

### 10.1 Policy hierarchy

```text
Immutable Governance
        |
        v
Global Learned Policy
        |
        v
Domain Learned Policy
        |
        v
Project Policy / Overrides
        |
        v
Work Decision
```

No learned layer may weaken an invariant owned by Immutable Governance.

### 10.2 Candidate policy scope

Initial RSI scope is limited to choices such as:

- routing/provider/model selection inside allowed sets;
- serial vs bounded parallel implementation when scope independence is proven;
- timeout/watchdog values inside approved bounds;
- retry strategy;
- diagnostic/recovery recommendation ranking;
- turn-economy strategy;
- optional domain-specific execution preferences.

Out of scope for learned policy:

- authority ownership rules;
- evidence acceptance requirements;
- project isolation;
- secret/privacy boundaries;
- fail-closed semantics;
- generation fencing;
- permission expansion;
- arbitrary new tool access.

### 10.3 Evaluation protocol

A candidate learned policy must be evaluated across independent lineages.

Canonical shape:

```text
Train cohort      = projects/lineages A, B, C
Evaluation cohort = D
Holdout cohort    = E, F
```

Exact minimum counts are plan-level constants, but global promotion requires more than one independent lineage and at least one true holdout not used for candidate fitting.

Metrics must include both utility and safety/regression signals.

No candidate promotes solely because aggregate performance improves if a governance/safety invariant regresses.

### 10.4 Promotion lifecycle

1. Generate candidate from eligible Experience.
2. Seal candidate configuration and training cohort identity.
3. Replay/evaluate against evaluation cohort.
4. Run independent holdout.
5. Compare against current policy using predeclared metrics/gates.
6. Produce immutable evaluation artifact.
7. Promote only through explicit policy transaction.
8. Preserve prior policy for rollback.

Initial implementation may require operator approval for global promotion. Automatic global self-promotion is not required to declare V2-9 complete.

### 10.5 Required acceptance scenarios

- single-project success cannot produce global promotion;
- candidate trained on one lineage and tested only on the same lineage is rejected;
- candidate with utility gain but safety invariant regression is rejected;
- domain policy cannot leak into incompatible domain cohort;
- promoted policy can be rolled back deterministically;
- evaluation artifacts are reproducible from sealed candidate/cohort references;
- raw project-private context never appears in learned policy artifacts.

### 10.6 Exit condition

Orchestra can improve bounded execution policy from sanitized cross-project evidence and demonstrate generalization without permitting RSI to redefine governance.

## 11. V2-10 — Migration and removal of project-local 1.x architecture

V2-10 moves real projects from the compatibility topology to the global topology.

### 11.1 Migration philosophy

Migration is factual translation, not blind conversion.

A v1 record is imported only when its identity/meaning can be proven. Ambiguous state is preserved as migration evidence and becomes a structured human/recovery gate rather than being guessed into a healthy v2 state.

### 11.2 Required migration capabilities

1. Discover v1 Orchestra footprint without mutating it.
2. Build a migration report describing:
   - runtime/version;
   - current authority/work state;
   - delegation/parallel groups;
   - candidate/evidence references;
   - recoverable/ambiguous transient state;
   - local provider integrations.
3. Register the project globally.
4. Translate valid durable work facts into v2 Project/Work/Operation/Continuation records where semantics are proven.
5. Map known stale/orphan operations into factual v2 recovery inputs without calling them successful or live.
6. Preserve artifacts/evidence by digest/reference where safe.
7. Install provider thin shims.
8. Switch project runtime selection to v2 only through explicit cutover transaction.
9. Retain rollback/read-only access to migration backup until cutover is accepted.
10. Remove/deactivate full local runtime only after successful migration acceptance.

### 11.3 Tsuzuki F7 permanent fixture

The real Tsuzuki orphan state is a mandatory migration/recovery fixture.

The migrator must be able to represent the known shape:

```text
persisted parallel group = RUNNING
member artifacts = none
composite artifact = none
owner process proof = absent
transient baseline clones may still exist
ETIMEDOUT linkage = not conclusively persisted
```

Expected v2 behavior:

- never classify as LIVE solely from persisted RUNNING;
- never fabricate member/composite success;
- preserve ambiguity where causal linkage is not proven;
- expose official recovery/abandon path;
- allow newer global runtime logic to resolve the project without manual JSON deletion.

### 11.4 De-localization target

After accepted migration, normal project footprint is limited to host-required shims/marker/config.

A migrated project must not require:

- `.codex/astra-orchestra/**` full runtime;
- `.agents/**` full Orchestra brain;
- `.orchestra/runtime/**` provider-neutral runtime copy;
- session handoff files as normal authority;
- project-local Work Lease as normal authority;
- project-local delegation state as the authoritative operation registry.

### 11.5 Required acceptance scenarios

- clean v1 project migrates deterministically;
- active healthy v1 state is not migrated destructively while factually live;
- corrupt/ambiguous v1 state fails closed with actionable report;
- Tsuzuki F7 orphan imports into recoverable v2 facts without manual deletion;
- migrated project works in both providers using global control plane;
- rollback before final acceptance restores the prior compatibility mode without losing preserved data;
- project-local runtime removal does not remove source/project artifacts.

### 11.6 Exit condition

At least the Orchestra self-host project and Tsuzuki can operate normally under v2 without the v1 local-runtime topology.

## 12. V2-11 — Cutover, self-hosting and release

V2-11 contains no major new subsystem. It proves that the completed architecture is fit to become the normal Orchestra product.

### 12.1 Self-hosting gate

The Orchestra repository itself must be registered and operated through v2 for its own development workflow.

Required scenarios:

- fresh Codex chat continuation;
- fresh AGY conversation continuation;
- bounded mutation Operation lifecycle;
- provider crash/stale recovery;
- runtime image upgrade and rollback;
- Work abandon/task switch;
- evidence/acceptance path used by real work;
- no need for manual authority-state editing.

### 12.2 Tsuzuki field gate

Tsuzuki becomes the primary external field validation because it supplied the real failure fixtures that motivated v2.

Required scenarios include:

- migration of existing state;
- recovery of the historical orphan class;
- Codex and AGY usage on Windows;
- chat switching without handoff hostage behavior;
- runtime upgrade without project-local copy update;
- Direct Work and bounded PARALLEL_2 under global Operation tracking;
- no regression to local permanent Work Lease ownership.

### 12.3 Release-readiness gate

Before declaring v2 generally ready:

- all V2-5 through V2-10 milestone acceptance suites pass on exact release candidate head;
- full v1 regression remains green until deprecation boundary is explicitly changed;
- Windows and Linux portable/global runtime tests pass;
- migration dry-run and actual migration fixtures pass;
- upgrade/rollback/recovery scenarios pass;
- cross-project isolation tests pass;
- Experience privacy/sanitization tests pass;
- RSI governance-ceiling tests pass;
- generated artifacts and release packaging are deterministic;
- docs describe global install, register, status, recover, upgrade, migrate and rollback flows;
- release notes clearly separate compatibility mode from v2-managed projects.

### 12.4 Deprecation rule

V1 is not deleted merely because V2 CI is green.

The v1 topology may be marked deprecated only after:

- self-hosting passes;
- Tsuzuki passes the field gate;
- both providers have working v2 adapters;
- runtime image upgrade/rollback is proven;
- migration/recovery of known-bad v1 states is proven.

Physical removal of v1 implementation may be a later cleanup release if doing it in the same release would unnecessarily increase blast radius.

### 12.5 Exit condition

Orchestra v2 is the normal operating path for registered projects, self-hosted in real development, recoverable under known crash classes, and releasable without relying on project-local brains.

## 13. Program PR / branch strategy

The remaining work should continue as stacked, independently reviewable milestones unless the implementation plan identifies a smaller safe subdivision.

Recommended stack:

```text
feat/v2-reconciler-recovery          # V2-4, current base
  -> feat/v2-codex-global-adapter    # V2-5
  -> feat/v2-antigravity-global-adapter
  -> feat/v2-runtime-images
  -> feat/v2-experience-store
  -> feat/v2-cross-project-rsi
  -> feat/v2-migration
  -> feat/v2-cutover
```

Rules:

- one milestone must not silently include the next milestone's subsystem;
- neutral primitives discovered as necessary by a provider milestone belong in neutral `v2/**` and must have provider-independent tests;
- later branches consume earlier contracts rather than copying them;
- every milestone gets its own canonical exact-head CI evidence;
- milestone PRs remain merge-gated by operator/review workflow.

## 14. Program change-control rules

During implementation, Sol may make bounded decisions that do not change the architecture, for example:

- exact module/file split inside the already-approved boundary;
- exact names of private helper functions;
- test fixture organization;
- equivalent structured error naming where semantics remain identical;
- internal SQL/index implementation that preserves the specified contract.

Sol may not unilaterally decide to:

- introduce a permanent daemon;
- restore session-owned authority;
- copy the v2 brain into projects;
- weaken liveness/recovery gates;
- share raw project data cross-project;
- broaden RSI governance scope;
- skip a milestone acceptance gate;
- auto-migrate/delete v1 state without the specified explicit lifecycle;
- merge milestones merely to simplify the stack.

Those are architecture changes and require operator approval.

## 15. Canonical completion definition

The remaining v2 program is complete when all of the following are true simultaneously:

1. Codex uses a global adapter with thin local shim only.
2. Antigravity uses a global adapter with thin local shim only.
3. Sessions are disposable actors on both providers.
4. Global Runtime Images are immutable, pinnable, upgradeable and rollback-capable.
5. Recovery logic remains available even when the pinned project runtime is broken.
6. Sanitized Experience records aggregate useful cross-project diagnostics/execution outcomes without leaking raw private context.
7. Cross-project Dream/RSI can evaluate and promote bounded policy only after independent-lineage generalization/holdout gates.
8. Tsuzuki's known orphan failure class is migratable/recoverable through official lifecycle.
9. Orchestra can self-host under v2.
10. Registered projects no longer need independently installed Orchestra brains.
11. No known v2 workflow requires manual editing/deleting of authority/liveness state as the normal recovery mechanism.
12. Canonical CI/release evidence is green on the exact cutover head.

At that point the architectural objective is achieved:

> **One global Orchestra control plane governs isolated project workspaces, provider sessions are ephemeral provenance, transient execution is factually recoverable, and sanitized experience can improve execution policy across projects without collapsing their trust boundaries.**
