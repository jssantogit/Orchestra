# Orchestra v2 Completion Design — V2-5 through V2-11

Date: 2026-10-17
Status: awaiting written-spec review
Execution target: Codex implementation-only workflow
Base architecture: Orchestra v2 Global Control Plane
Current implementation base: V2-4 / `feat/v2-reconciler-recovery` at `a3002edb1493cc86e8e9f713477db3add31d1799`
Detailed V2-5 design: `docs/superpowers/specs/2026-10-17-v2-codex-global-adapter-design.md`

## 1. Purpose

This specification defines the complete remaining path from the current Orchestra v2 control-plane foundation to a production-ready global Orchestra v2 that can replace the project-local Orchestra 1.x topology.

V2-0 through V2-4 already established the hard architectural core:

- provider-neutral domain contracts;
- global Project registration and durable persistence;
- sessionless Work authority and Active Work Head;
- factual Operation liveness;
- deterministic Reconciler and crash recovery.

The remaining work is not an invitation to redesign those foundations. It is a bounded completion program that connects providers to the global core, adds runtime-image lifecycle, enables sanitized cross-project learning, migrates legacy projects, and proves the new topology under real use.

The target end state is:

```text
USER-LEVEL ORCHESTRA V2

Global Engine
├── Project Registry
├── Work Authority
├── Operation Registry
├── Reconciler
├── Runtime Image Manager
├── Provider Adapters
│   ├── Codex
│   └── Antigravity
├── Evidence / Governance Core
├── Experience Store
└── Dream / RSI
        │
        ├── Project A — isolated
        ├── Project B — isolated
        └── Project C — isolated

Project-local footprint
├── optional project identity marker
└── provider-required thin shims only
```

No project contains an independently evolving Orchestra brain.

## 2. Completion definition

Orchestra v2 is complete only when all of the following are true:

1. Codex and Antigravity can both operate registered v2 projects through the same global authority/liveness/recovery core.
2. Fresh chats attach to durable Work without handoff from an older conversation.
3. No provider session ID is persistent project ownership.
4. No persisted `RUNNING` state alone proves execution liveness.
5. Runtime versions are immutable global images pinned per project and independently upgradeable/rollbackable.
6. Recovery logic in a newer global engine can diagnose and recover state created by an older supported runtime image.
7. Cross-project Experience contains only explicitly sanitized, abstracted facts and never raw private project context by default.
8. Dream/RSI promotion requires cross-project generalization and cannot alter immutable governance ceilings.
9. Existing 1.x projects can migrate through an official, deterministic lifecycle without manual JSON edits or force flags.
10. The real Tsuzuki F7 orphan shape can be migrated, diagnosed, and recovered through official v2 surfaces.
11. Orchestra can self-host on v2 and survive real Windows Codex Desktop and Antigravity field usage.
12. Project-local 1.x runtime materialization can be removed from migrated projects without losing authority, evidence, recovery, or provider functionality.

## 3. Frozen architectural invariants

These rules are not milestone-local. Every remaining task must preserve them.

### 3.1 Authority

- A model is never authority.
- Chat/session identity is factual ActorProvenance only.
- Project authority is derived from current global Project + Work + generation + capability facts.
- A fresh provider root attaches to current Work; it does not claim ownership from another chat.
- Stale Work identity fails `STALE_ACTIVE_WORK` even when numeric generation matches.
- Stale generation fails closed.
- Instruction epoch freshness is checked on every protected provider action, not only SessionStart.

### 3.2 Liveness

- `workflowState = RUNNING` is not proof of `LIVE`.
- Factual liveness is execution-class specific and must be explicit.
- Local Orchestra-owned processes use process identity + heartbeat/deadline facts.
- Provider-managed execution uses provider-event facts and must never reuse a transient hook PID as false owner proof.
- `UNKNOWN` is not silently downgraded to stale.
- Fail-closed cannot mean fail-permanent: actionable recovery must exist for every transient blocking state that can become safely recoverable.

### 3.3 Isolation

- Project A authority never authorizes Project B.
- Work, evidence, candidates, artifacts and recovery state remain project-scoped.
- Provider correlation identifiers are scoped by provider + Project + Work/Operation facts and are not trusted as globally unique by themselves.
- Raw source, requirements, prompts, secrets, private artifacts, private transcripts and business logic do not cross project boundaries by default.

### 3.4 Runtime topology

- `v2/**` is global-engine code and must not be materialized into provider-local 1.x runtime mirrors.
- Provider-required project files are shims, not runtime copies.
- A global engine update is distinct from a project runtime-image upgrade.
- One engine may host multiple runtime images simultaneously.

### 3.5 Governance / RSI

- Learned policy operates below immutable governance.
- Learned policy may choose among already-legal behaviors; it cannot redefine trust, authority, evidence acceptance, mutation safety or recovery semantics.
- Cross-project promotion requires evidence from multiple independent project lineages.
- A single lineage cannot self-promote a global policy.

## 4. Program structure

The remaining implementation is divided into seven milestones:

```text
V2-5   Codex Global Adapter
V2-6   Antigravity Global Adapter
V2-7   Runtime Images + Project Upgrade/Rollback
V2-8   Global Experience Store
V2-9   Cross-project Dream / RSI
V2-10  Migration + Removal of Project-local 1.x Runtime
V2-11  Cutover, Self-hosting, Field Validation & Release
```

They are sequential in authority terms, although a milestone may internally contain parallelizable implementation tasks when file ownership and state dependencies are provably disjoint.

No later milestone may bypass an earlier contract for convenience.

## 5. V2-5 — Codex Global Adapter

The detailed design is authoritative in:

`docs/superpowers/specs/2026-10-17-v2-codex-global-adapter-design.md`

### 5.1 Goal

Connect Codex Desktop to the global v2 control plane through a project-local thin shim and global provider adapter without reintroducing session ownership or project-local governance state.

### 5.2 Required architecture

```text
Codex hook
  -> thin project shim
  -> stable global Orchestra launcher
  -> v2/providers/codex
  -> neutral WorkAuthority / Operation / Reconciler
```

### 5.3 Required provider facts

- factual `session_id` / child identity -> ActorProvenance hash;
- factual hook event identity;
- factual `tool_call_id` where a long-lived mutation Operation must be correlated;
- factual cwd/workspace used only to resolve a registered Project through the global registry.

### 5.4 Session Observation

Codex gets a provider-scoped global Session Observation containing the instruction epoch and Work facts actually delivered to that session. It is freshness metadata, not authority.

### 5.5 Intake

Registered Project + no Active Work returns a healthy INTAKE provider context. It must not block conversation-level use.

### 5.6 Tool Operations

Mutation-capable `PreToolUse` begins/correlates one provider-managed Operation using factual tool-call identity. `PostToolUse` terminalizes only the matching Operation.

The hook process PID is never the runtime owner for the provider tool execution.

A provider-neutral provider-event liveness class must exist because Codex tool-call lifecycle cannot truthfully use local-process liveness.

### 5.7 Acceptance gates

V2-5 is accepted only when:

- two fresh Codex sessions can attach to the same active Work without handoff or ownership transfer;
- stale instruction epoch is enforced on protected commands;
- no Active Work yields INTAKE;
- mutation without factual correlation is denied, never assigned a synthetic identity;
- duplicated/reordered/missing provider events fail deterministically;
- PostToolUse cannot release or terminalize a different writer;
- stale provider-managed Operations route through the neutral Reconciler;
- a v2 Codex project contains no project-local copied governance runtime;
- v1 Codex regression remains green.

## 6. V2-6 — Antigravity Global Adapter

### 6.1 Goal

Give Antigravity the same global-control-plane semantics as Codex while preserving provider isolation and AGY-specific factual protocol translation.

### 6.2 Architectural rule

V2-6 must consume the same neutral contracts that V2-5 consumes. It may reuse provider-neutral provider-event liveness abstractions introduced by V2-5, but it must not import Codex adapter code to implement AGY behavior.

```text
Antigravity event/protocol
  -> thin project shim when required
  -> global Orchestra launcher
  -> v2/providers/antigravity
  -> neutral WorkAuthority / Operation / Reconciler
```

### 6.3 Required provider responsibilities

The AGY adapter owns only:

- factual conversation/agent identity normalization;
- AGY event/protocol normalization;
- provider model/profile discovery;
- provider process invocation where Orchestra initiates AGY work;
- AGY-specific execution/correlation facts;
- provider response translation.

It does not own Work selection, generation fencing, mutation exclusivity, recovery classification or evidence acceptance.

### 6.4 Delegated implementation

Existing cross-provider/implementation delegation behavior must be re-homed so global Operations represent provider executions. AGY implementation capability must remain factual and provider-discovered, not assumed.

No project-local AGY runtime may become a second source of governance truth.

### 6.5 Acceptance gates

- fresh AGY conversations attach without chat ownership;
- same Work/generation/instruction freshness semantics as Codex;
- global project resolution and provider isolation are enforced;
- AGY mutations/delegations create globally visible factual Operations;
- provider crash/timeout cannot leave an unrecoverable project lock;
- Codex and AGY can both participate in valid Parallel 2 through the same global Operation model;
- provider firewall tests prove no Codex<->AGY authority imports;
- v1 Antigravity regression remains green.

## 7. V2-7 — Runtime Images, Pinning, Upgrade and Rollback

### 7.1 Goal

Replace project-local runtime copies with immutable global runtime images selected by Project state.

### 7.2 Runtime Image model

A runtime image is immutable and content-identified. At minimum it records:

```yaml
schema: orchestra.runtime-image.v2
imageId: ...
version: ...
contentDigest: sha256:...
engineCompatibility: ...
instructionEpoch: ...
createdAt: ...
```

Runtime image identity must not depend only on a mutable version string.

### 7.3 Global image store

Conceptual layout:

```text
<ORCHESTRA_HOME>/runtime-images/
  <content-id>/
    manifest
    provider shim templates
    instruction/policy payloads
    compatibility metadata
```

Project state contains a pin/reference to one runtime image.

### 7.4 Upgrade lifecycle

`orchestra project upgrade <project> <image>` is a control-plane lifecycle operation.

Before pin change:

1. resolve Project;
2. reconcile active Operations;
3. deny if factual LIVE incompatible work cannot safely continue;
4. preserve dirty/unknown recovery state;
5. validate target image compatibility;
6. atomically change runtime pin + instruction epoch;
7. regenerate only required thin provider shims;
8. preserve previous image reference for rollback/audit.

No upgrade is allowed to rewrite product repository code as a side effect of changing Orchestra runtime.

### 7.5 Bootstrap recovery rule

The global engine is above project image state.

A broken image N cannot prevent a newer engine/image N+1 from diagnosing or recovering state created by N. Recovery commands must not require executing the broken project-local runtime being replaced.

This rule exists specifically to prevent recurrence of the v1 Tsuzuki orphan/update deadlock.

### 7.6 Rollback

Rollback changes the Project's runtime-image pin under the same lifecycle gates. It does not restore a copied runtime tree from the project repository.

### 7.7 Acceptance gates

- multiple registered projects may run different image pins simultaneously;
- upgrade and rollback are atomic and restart-safe;
- instruction epoch advances on semantically relevant image change;
- stale sessions receive `SESSION_RUNTIME_STALE` after upgrade;
- upgrade cannot steal LIVE Operations;
- old stale Operations can be recovered by the current global engine;
- image corruption/digest mismatch fails closed;
- thin shims remain minimal and regenerated deterministically;
- no full runtime is materialized into the project.

## 8. V2-8 — Global Experience Store

### 8.1 Goal

Persist sanitized, provenance-bound experience across projects without making private project context globally visible.

### 8.2 Experience classes

The store supports four explicit visibility classes:

1. `GLOBAL_FACT` — environment/provider/tool behavior broadly reusable;
2. `ABSTRACT_EPISODE` — sanitized execution/recovery episode;
3. `DOMAIN_EPISODE` — sanitized episode restricted to a compatible domain cohort;
4. `PROJECT_PRIVATE` — never eligible for cross-project retrieval/promotion by default.

### 8.3 Required Experience shape

Experience records must carry enough provenance to audit what produced them without embedding raw private inputs.

Conceptually:

```yaml
experienceId: exp_...
projectId: prj_...
lineageId: lineage_...
visibilityClass: ABSTRACT_EPISODE
domainClass: ... | null
operationClass: ...
failureClass: ... | null
recoveryClass: ... | null
outcome: ...
metrics: {...}
provenanceRefs: [...]
sanitizationVersion: ...
createdAt: ...
```

`projectId`/`lineageId` are provenance and diversity facts; they do not grant cross-project access to private payloads.

### 8.4 Sanitization boundary

No record is globally eligible until a deterministic sanitizer proves it contains only allowed fields/classes.

The sanitizer must reject or strip:

- source text/bytes;
- private requirement prose;
- chat transcript content;
- secrets/tokens/credentials;
- raw prompts;
- filesystem paths that reveal private project-specific content beyond bounded normalized classes;
- arbitrary provider payloads;
- private artifact bodies.

Sanitization must be versioned and replayable.

### 8.5 Eligible global facts

Examples:

- provider capability/discovery outcomes;
- OS/process behavior;
- tool exit/timeout semantics;
- liveness/recovery signatures;
- routing performance;
- turn/token economy measurements;
- generic composition/overlap outcomes;
- generic failure/recovery patterns.

### 8.6 Acceptance gates

- cross-project query returns only globally/domain-eligible sanitized records;
- raw project-private payloads cannot be stored as globally eligible Experience;
- sanitizer version/provenance is durable;
- corruption/tampering fails closed;
- same Project can retain richer private episode facts without making them globally retrievable;
- lineage diversity can be computed without leaking project content;
- storage remains namespaced and auditable.

## 9. V2-9 — Cross-project Dream / RSI

### 9.1 Goal

Use sanitized Experience to propose, evaluate and promote bounded learned policy that generalizes across independent projects.

### 9.2 Governance hierarchy

The ordering is permanent:

```text
Immutable Governance
        ↓
Global Learned Policy
        ↓
Domain Learned Policy
        ↓
Project Policy
        ↓
Work Decision
```

No lower layer may widen the permissions of a higher layer.

### 9.3 Candidate policy classes

RSI may improve choices such as:

- provider/model routing among legal providers;
- serial vs bounded parallel implementation when scopes are proven independent;
- timeout/watchdog sizing inside governance ceilings;
- recovery recommendation ordering;
- turn-economy strategy;
- validation/evidence scheduling among already valid gates.

RSI may not learn away:

- authority checks;
- generation fencing;
- project isolation;
- evidence acceptance requirements;
- mutation capability checks;
- liveness proof requirements;
- human gates for destructive/unknown state;
- sanitization rules.

### 9.4 Promotion protocol

A global candidate must be evaluated across independent project lineages.

Minimum conceptual flow:

```text
Experience cohort -> candidate policy
Train/derive on multiple lineages
Evaluate on separate lineages
Hold out independent lineages when enough diversity exists
Compare safety + quality + cost metrics
Promote only if governance and regression gates pass
```

A policy cannot be promoted globally from one project lineage.

Domain policy requires diversity inside its explicit domain cohort and does not automatically become global policy.

### 9.5 Reproducibility

Every promoted policy stores:

- policy version/digest;
- Experience cohort references;
- sanitization versions;
- evaluation metrics;
- project-lineage diversity count;
- failed counterexamples;
- governance compatibility result;
- promotion/rollback provenance.

### 9.6 Rollback

Learned policy promotion is versioned and reversible without changing immutable governance or project source state.

### 9.7 Acceptance gates

- one lineage cannot globally promote itself;
- holdout/evaluation lineage facts are enforced, not narrative;
- policy candidate cannot express forbidden governance mutations;
- regressions on a protected project/domain cohort block promotion;
- replay produces the same evaluation from the same immutable Experience/policy inputs;
- rollback returns routing/learned behavior to the prior policy version;
- project-private Experience never appears in global candidate context unless explicitly eligible by policy and sanitization.

## 10. V2-10 — Migration and Removal of Project-local 1.x Runtime

### 10.1 Goal

Provide an official migration path from existing Orchestra 1.x projects to global v2 and remove the need for project-local runtime materialization after successful migration.

### 10.2 Migration principles

- migration is explicit, never silent;
- source 1.x state is treated as evidence, not automatically trusted as v2 truth;
- ambiguous state is preserved and surfaced, not normalized away;
- migration is restart-safe and idempotent;
- no manual JSON surgery is part of the supported path;
- migration never force-clears an unknown/live operation.

### 10.3 Migration phases

For one project:

1. inspect existing 1.x runtime/state without mutating it;
2. register/resolve the global Project identity;
3. classify legacy task/Work Lease/delegation/parallel state;
4. import only facts that can be mapped deterministically into v2 Project/Work/Operation/continuation/evidence records;
5. place ambiguous legacy facts behind an explicit migration Human Gate or recovery record;
6. reconcile imported transient Operations through v2 liveness/recovery semantics;
7. validate provider thin shims against the global adapters;
8. switch project runtime selection to v2;
9. verify continuation and mutation authority;
10. archive/remove project-local 1.x runtime copies only after cutover validation.

### 10.4 Legacy authority handling

Legacy session authority and Work Lease bindings are migration provenance only. They do not become persistent v2 session ownership.

If enough facts exist to identify current Work/generation, import them as Work facts. Otherwise migration stops at a structured gate instead of inventing continuation authority.

### 10.5 Tsuzuki F7 permanent fixture

The real legacy orphan shape must be represented as a migration fixture:

- persisted parallel group `RUNNING`;
- no member artifacts/composite artifact;
- no identifiable owner process;
- surviving temp clones;
- no proof that persisted RUNNING is LIVE.

Expected v2 behavior:

```text
legacy import
  -> provider/workflow facts preserved
  -> no fabricated success
  -> liveness not inferred from RUNNING
  -> official reconcile/recover path
  -> terminal ABORTED/ORPHANED-style outcome when factual recovery proof permits
  -> dirty/unknown workspaces preserved when required
```

This fixture is a release blocker: v2 is not migration-complete if the exact family of failure that motivated the architecture still requires manual cleanup.

### 10.6 Removal boundary

After successful migration, project-local copies such as the following are no longer authority/runtime sources:

```text
.codex/astra-orchestra/**
.agents/<full Orchestra runtime>/**
.orchestra/runtime/**
project-local Work Lease / session authority state
```

Only provider-required thin shims and optional ignored project identity metadata remain.

### 10.7 Acceptance gates

- migration is idempotent across restart;
- corrupt legacy state fails with actionable diagnostics;
- unknown/live state is never force-cleared;
- active Work continuation survives chat switch after migration;
- Codex and AGY both use global adapters after migration;
- Tsuzuki orphan fixture is officially recoverable;
- local runtime removal does not break Doctor/status/recovery/provider hooks;
- rollback boundary is explicit until destructive removal is committed;
- migrated project source tree remains free of copied v2 governance runtime.

## 11. V2-11 — Cutover, Self-hosting, Field Validation and Release

### 11.1 Goal

Prove that v2 is operationally ready to become the normal Orchestra architecture, not merely a passing test suite.

### 11.2 Self-hosting

The Orchestra repository itself must be registerable and usable under v2 without relying on hidden 1.x authority for normal development.

Self-hosting must exercise:

- fresh-chat attach;
- Work start/advance/abandon;
- provider tool Operations;
- reconciliation/recovery;
- runtime-image pinning/upgrades;
- provider shims;
- evidence/validation surfaces required by development.

### 11.3 Real provider field matrix

At minimum validate:

```text
Windows + Codex Desktop
Windows + Antigravity
Codex fresh session during active Work
AGY fresh conversation during active Work
Codex <-> AGY delegated implementation
Parallel 2 where scopes are proven independent
provider crash/timeout
hook/event loss or duplication
runtime-image upgrade during quiescent Work
stale session after instruction epoch change
recovery after abandoned provider execution
```

Portable CI remains mandatory, but it is not a substitute for these field tests.

### 11.4 Tsuzuki proving project

Tsuzuki is the primary migration proving project because it contains the real lifecycle failures v2 is intended to solve.

Cutover acceptance requires a normal development milestone on Tsuzuki where:

- a new chat can continue current Work without prepared handoff;
- no stale historical chat permanently blocks the project;
- Codex and AGY can execute under global Operations;
- provider crash/recovery does not require editing state files;
- runtime update/rollback does not require replacing project-local runtime copies.

### 11.5 Release gate

Release requires:

- all V2 milestone CI green on exact release head;
- full Orchestra 1.x compatibility suite green until the documented removal boundary;
- provider firewall/contamination tests green;
- migration fixtures green;
- Windows/Linux portability green;
- self-hosting evidence green;
- Tsuzuki field evidence green;
- runtime image install/upgrade/rollback evidence green;
- Experience sanitization/RSI governance tests green;
- no open blocker requiring manual authority/state edits.

### 11.6 1.x deprecation

1.x may be declared legacy only after v2 release gates pass. Physical removal of compatibility code can be a later cleanup release, but migrated projects must no longer depend on local 1.x authority.

## 12. Cross-milestone persistence policy

V2 already uses SQLite as durable global state. Remaining milestones should extend that model rather than introduce independent ad hoc JSON authority stores unless a file is explicitly an immutable content blob/manifest.

New persistence schemas require:

- explicit schema versions/migrations;
- fail-closed handling of newer unsupported schema;
- restart-safe idempotency;
- project/provider namespace keys where relevant;
- integrity checks for content-addressed/immutable records;
- conformance tests where an in-memory/reference contract exists.

## 13. Cross-milestone CLI / UX policy

The public lifecycle should remain small and factual.

Expected conceptual surfaces by completion:

```text
orchestra home
orchestra register <workspace>
orchestra project status <project>
orchestra project recover <project> <operation>
orchestra project resolve-dirty <project> <operation> ...
orchestra project rebind <project> <workspace>
orchestra project upgrade <project> <runtime-image>
orchestra project rollback <project> ...
orchestra migrate <workspace|project>
orchestra provider codex hook
orchestra provider antigravity ...
```

Exact command spelling may follow existing CLI conventions, but no emergency/manual state-file procedure counts as completion.

## 14. Branch and review topology

Implementation should remain stacked until integration review proves the complete chain.

Recommended branches:

```text
feat/v2-codex-global-adapter        # V2-5
feat/v2-antigravity-global-adapter  # V2-6, based on V2-5
feat/v2-runtime-images              # V2-7, based on V2-6
feat/v2-experience-store            # V2-8, based on V2-7
feat/v2-cross-project-rsi           # V2-9, based on V2-8
feat/v2-migration-cutover           # V2-10, based on V2-9
feat/v2-release-cutover             # V2-11, based on V2-10
```

Each milestone gets its own review boundary and exact-head CI evidence. Do not merge an intermediate PR merely to simplify the stack unless the operator explicitly requests integration.

## 15. TDD and verification policy

Every behavior-changing task follows RED -> GREEN -> focused refactor -> verification.

Each milestone must include:

1. unit/domain tests for new contracts;
2. adversarial tests for authority/isolation/liveness boundaries;
3. persistence restart/concurrency tests where durable state changes;
4. Windows + Linux coverage for platform-sensitive behavior;
5. full 1.x compatibility regression until V2-10/V2-11 explicitly changes that boundary;
6. exact-head CI before the milestone is promoted from draft/review state.

A passing focused test is not enough to declare a milestone complete.

## 16. Codex execution contract — implementation only

This completion program is transferred to Codex under a strict implementation-only operating mode.

### 16.1 Role assignment

```text
SOL = ORCHESTRATOR / CONTROL / REVIEW
LUNA = IMPLEMENTER
```

Sol owns:

- reading the approved spec and implementation plan;
- selecting the next plan task;
- issuing a bounded implementation packet to Luna;
- checking task acceptance criteria and test evidence;
- deciding retry vs accept vs structured block;
- maintaining branch/PR/checkpoint discipline;
- final whole-milestone review.

Luna owns:

- writing the specified failing test;
- implementing only the code required by the assigned task;
- running the plan-specified focused tests;
- making the task commit when green;
- returning factual changed files/tests/results to Sol.

### 16.2 Investigation is prohibited

Neither Sol nor Luna starts an open-ended investigation phase.

Prohibited behaviors include:

- broad repository archaeology to rediscover architecture already decided by the spec;
- web/external research to choose a different design;
- asking another model to redesign the milestone;
- speculative refactors unrelated to the assigned task;
- exploring multiple implementation approaches when the plan pins one;
- replacing a plan task with a new architecture because an agent prefers it;
- using old chats/transcripts as authority over the approved spec/plan.

### 16.3 What file reading is allowed

Implementation necessarily requires local code context. This is not considered investigation when it is bounded to:

- files explicitly named by the implementation plan;
- direct imports/callers needed to apply the named interface;
- tests explicitly named by the task;
- exact CI/log output from a failing planned command;
- generated/runtime mirrors only when the task explicitly requires compatibility verification.

If correctness requires reading beyond that boundary, Sol must first state the exact missing fact and why the current task cannot proceed without it.

### 16.4 Blocker protocol

When implementation facts contradict the approved plan, agents do not improvise a new design.

Return:

```text
ORCHESTRA V2 IMPLEMENTATION BLOCKED
milestone: V2-X
task: N
expected contract: ...
observed contradiction: ...
minimal factual evidence: ...
files/command involved: ...
impact: ...
```

Sol may resolve a purely local implementation detail if the spec already determines the semantics. Any true architectural contradiction returns to the operator/spec rather than triggering investigation.

### 16.5 No silent fallback

Agents may not silently:

- fall back from global v2 authority to 1.x authority;
- serialize a required parallel path merely to pass tests;
- skip provider correlation/liveness tracking;
- force-clear state;
- fabricate IDs/evidence/success;
- weaken fail-closed semantics;
- bypass a migration/recovery gate;
- mark a task complete without its required verification.

### 16.6 Context discipline

Each Luna implementation packet should contain only:

- milestone/task ID;
- goal;
- exact files/interfaces;
- test to write/run;
- invariants relevant to that task;
- acceptance result expected.

Do not send the entire historical Orchestra conversation to Luna. The approved spec + plan are the durable design authority.

## 17. Orchestrator acceptance contract

For every plan task, Sol accepts only when:

- the task's RED test was observed before implementation unless the task is documentation-only;
- the task's GREEN test passes;
- no unrelated files changed;
- exact interfaces match the plan;
- no new provider-local authority source was introduced;
- no project isolation/liveness/governance invariant was weakened;
- the commit is bounded to the task.

For every milestone, Sol additionally requires:

- focused milestone suite green;
- full required compatibility suite green;
- exact-head CI green;
- PR description/checkpoint updated with factual evidence;
- no unresolved review finding in the milestone scope.

## 18. End-state cleanup

After V2-11 release acceptance, the repository should have a clear separation:

```text
v2/**
  global neutral engine
  provider adapters
  runtime-image management
  experience/RSI

providers/** or v2/providers/**
  provider-specific source adapters

runtimes/**
  1.x compatibility/release history only until later deletion

project consumers
  thin shims + optional identity marker
```

The long-term target is that updating Orchestra is a user-level/global engine action and upgrading a project is a runtime-image pin transition, not copying code into every repository.

## 19. Explicitly deferred beyond v2 completion

These are not required to finish the architecture described here:

- cloud-hosted shared Orchestra control plane across different users/machines;
- multi-user collaborative project authority;
- arbitrary remote provider fleets;
- unbounded autonomous self-modification;
- automatic global policy promotion without deterministic evaluation gates;
- removal of every historical 1.x source file in the same release as v2 cutover.

They require separate designs if pursued.

## 20. Final completion invariant

The decisive v2 test is behavioral, not packaging:

> A registered project can survive provider/chat replacement, execution crash, runtime upgrade and project migration without granting authority to a conversation, equating persisted state with liveness, copying an Orchestra brain into the repository, or requiring manual state surgery — while the global system can learn only from sanitized, generalizable experience across isolated projects.

If any milestone violates that sentence, it is not an acceptable shortcut to v2 completion.
