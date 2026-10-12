# Orchestra 1.x — Direct Work Architecture

**Date:** 2026-10-08  
**Status:** Design approved; implementation plan pending  
**Target:** Orchestra 1.x  
**Scope:** Core architecture, Codex/Antigravity provider adapters, execution workflow, authority model, migration strategy

## 1. Problem

Orchestra has accumulated strong governance guarantees across evidence, authority, trust, handoff, retries, provider isolation, worker boundaries, and acceptance. The current 0.10 baseline is behaviorally well protected by CI, but several architectural choices now impose disproportionate latency and coordination overhead on ordinary coding work.

The most visible symptom is that implementation and correction work through Codex can take materially longer than equivalent work performed through ChatGPT Web. This is not exclusively an Orchestra defect: Codex itself tends to incur more agentic coordination and exploration overhead. However, Orchestra currently amplifies that cost when small or normal implementation work is routed through heavyweight orchestration patterns by default.

The reformulation therefore has two goals at once:

1. preserve the safety and factual-governance properties that make Orchestra trustworthy; and
2. make normal coding work feel closer to the direct, objective, low-turn workflow used successfully through ChatGPT Web.

The target is **not** to make an expensive control model perform all implementation work. Cost remains a first-class constraint. Expensive intelligence should resolve and compress the task; cheaper models should perform most code generation and bounded verification.

A second structural problem exists in the current authority model. Codex and Antigravity bind project orchestration authority to factual provider conversation/session identity. This protects against impersonation and concurrent mutation, but it also makes a project or milestone operationally hostage to the lifetime of a chat. A fresh conversation may be blocked by an old factual session even when no incompatible work is actually running.

Orchestra 1.x must separate **session identity**, **work authority**, and **workspace mutation exclusivity**.

## 2. Design thesis

> **Root intelligent, execution cheap, coordination minimal.**

The default workflow should optimize for the shortest safe path from user intent to verified candidate:

```text
USER
  ↓
CONTROL / SOL
  ├─ understand intent
  ├─ investigate only what is necessary
  ├─ decide cause and implementation direction
  └─ emit Implementation Packet
        ↓
LUNA IMPLEMENTER
  ├─ directed location only
  ├─ implement
  ├─ modify tests only when authorized
  ├─ validate
  └─ repair only self-caused failures
        ↓
     CANDIDATE
        │
        ├──────────────→ AUTHORITATIVE CI / EVIDENCE
        │
        └──────────────→ LUNA AUDITOR
                           ├─ diff-scoped
                           ├─ task-scoped
                           └─ PASS / BLOCKING_FINDING
        │
        └──────────────┬───────────────┘
                       ↓
                 CONTROL / SOL
                    ACCEPT
```

This workflow is called **Direct Work** and becomes the normal path.

Heavy orchestration becomes an explicit escalation, not the starting assumption.

## 3. Permanent invariants

The reformulation changes implementation structure and default execution policy. It does **not** discard Orchestra's core trust principles.

The following remain permanent:

1. **A model is not authority.** Authority is factual runtime state.
2. **A failed tool is not evidence.** Failed, missing, or unverifiable execution cannot satisfy acceptance.
3. **Acceptance belongs to the control plane.** Implementers and auditors do not self-accept work.
4. **Workers do not coordinate workers.** Worker-to-worker orchestration is forbidden in Direct Work.
5. **Side effects require factual capability.** Narrative instruction cannot grant mutation or publication authority.
6. **Narrative context does not become authority.** Claims, summaries, and model assertions remain non-authoritative until backed by runtime facts.
7. **Scope expansion is fail-closed.** A worker cannot widen task scope by interpretation.
8. **Retries are bounded and delta-oriented.** A failed correction must narrow, not restart the whole task.
9. **Provider isolation remains strict at adapter boundaries.** Core behavior must be provider-neutral.
10. **Evidence is attached to the candidate/work unit, not to the lifetime of a chat.**

Two former architectural assumptions are deliberately removed as universal invariants:

- `orchestrator never writes product code` is no longer a constitutional rule. Direct Work should normally delegate implementation to a cheap worker for cost reasons, but control-plane direct mutation may exist as an explicit capability for exceptional cases.
- `one factual root session owns the project` is removed. Session identity becomes provenance; temporary work leases govern authority and mutation.

## 4. Execution modes

Orchestra 1.x defines three execution modes.

### 4.1 Direct Work — default

Use when a task can be resolved by one control agent and one primary implementation path.

Properties:

- one control/root reasoning path;
- one primary cheap implementer;
- optional cheap diff auditor after a candidate exists;
- CI/evidence and diff audit may run in parallel;
- no investigator by default;
- no reviewer swarm;
- no worker-to-worker conversation;
- bounded corrective delta only when the control plane confirms a finding.

Direct Work is the default unless factual task properties justify escalation.

### 4.2 Guided Work

Use when the control plane needs deeper investigation or a more explicit implementation decomposition before code changes begin.

Properties:

- control plane may inspect more broadly;
- an explicit investigator may be launched if independent investigation is cheaper or parallelizable;
- implementation still receives a resolved Implementation Packet;
- implementers do not inherit the investigator's open-ended mandate.

### 4.3 Orchestrated Work

Use only when risk, breadth, or true parallelism justifies a heavier graph.

Examples:

- multiple independent subsystems;
- security-sensitive or migration-sensitive changes;
- large refactors with independently verifiable workstreams;
- provider/runtime infrastructure work where dedicated reviewers materially reduce risk.

The control plane records the escalation reason. Orchestration is never selected merely because multiple agent roles exist.

## 5. Control-plane responsibility

The expensive control model is responsible for **compression**, not implementation volume.

Before handing normal work to the implementer, control should resolve enough uncertainty to state:

- what the user wants;
- what behavior is wrong or missing;
- the implementation direction;
- the relevant anchors or likely target area;
- the allowed scope;
- what must remain unchanged;
- whether test modification is authorized;
- required validation/evidence;
- side-effect capabilities;
- stop and return conditions.

The control plane should not over-specify mechanical edit details when the implementer can derive them directly from code. The packet must provide direction, not duplicate the patch.

The design objective is:

> **Use expensive intelligence to compress ambiguity; use cheap intelligence to expand that decision into code.**

## 6. Implementation Packet

`ImplementationPacket` becomes a first-class versioned domain object.

Illustrative shape:

```yaml
schema: orchestra.implementation-packet.v1
taskId: chapter-refresh-fix
candidateGeneration: 17

goal:
  correct chapter updates after refresh

direction:
  cause: observer can retain a stale snapshot after persistence
  change: invalidate or refresh the snapshot after successful persistence
  preserve:
    - current offline behavior
    - public API

anchors:
  - symbol: ChapterRepository.refresh
  - symbol: observeChapters
  - testHint: ChapterRepositoryTest

scope:
  allowedAreas:
    - domain/chapter/**
    - data/chapter/**
  forbidden:
    - unrelated cache refactor
    - public API redesign

permissions:
  discovery: DIRECTED
  tests: MODIFY_AUTHORIZED_TARGETS
  sideEffects:
    - WORKSPACE_EDIT
    - LOCAL_TEST

validation:
  - affected repository tests
  - formatter

failurePolicy:
  selfCaused: REPAIR
  unrelatedOrUncertain: RETURN_TO_CONTROL
```

The runtime, not prose convention alone, should validate packet shape and capabilities.

### 6.1 Packet quality rule

A packet is implementation-ready only when the control plane has resolved task intent and direction sufficiently that the worker does not need to rediscover the problem.

If a packet is internally contradictory, lacks required anchors/direction, or requires open-ended diagnosis to proceed, the worker returns `PACKET_INSUFFICIENT` instead of converting itself into an investigator.

## 7. Directed Discovery

Workers need enough freedom to locate exact code without reopening task diagnosis.

Orchestra defines three discovery classes:

### `NONE`

Targets are exact. The worker reads and edits declared targets and direct local context only.

### `DIRECTED`

Default for Direct Work. The worker may perform bounded mechanical location actions such as:

- find an explicitly named symbol;
- find a file by a specific name or narrow pattern;
- exact-text or signature search;
- follow a directly referenced import/interface/implementation;
- locate the corresponding test for an explicit target;
- read immediately surrounding code needed to edit safely.

### `INVESTIGATIVE`

Permits open-ended exploration, hypothesis formation, architecture discovery, broad repository search, or root-cause analysis. This mode is reserved for the control plane or an explicitly launched investigator.

A Direct Work implementer must never receive `INVESTIGATIVE` implicitly.

### 7.1 Semantic budget over blind read counts

Orchestra should not primarily enforce a simplistic maximum number of file reads. Five narrow, causally relevant reads may be cheaper and safer than two large exploratory reads.

The runtime should instead classify discovery operations by intent and relationship to packet anchors. Numeric caps may exist as secondary circuit breakers, not as the core policy.

## 8. Cheap Implementer contract

The primary implementer is optimized for execution, not task reinterpretation.

The default logical role is `IMPLEMENTER` and should map to a cost-efficient provider model such as Luna through the provider catalog.

The implementer may:

- consume the approved Implementation Packet;
- perform `NONE` or `DIRECTED` discovery according to the packet;
- edit within allowed scope;
- add or change tests only when explicitly authorized;
- run declared/local validation;
- correct failures that are clearly caused by its own patch;
- return candidate metadata and factual evidence references.

The implementer may not:

- reinterpret the user's goal;
- rediscover root cause through open-ended investigation;
- broaden scope;
- search for alternative unrelated solutions;
- perform architecture review;
- inspect git history unless explicitly authorized;
- fix unrelated failures;
- alter tests merely because a validation failed;
- create or coordinate other workers;
- accept its own result.

### 8.1 Failure rule

> **The implementer repairs only failures plausibly and directly caused by its own patch.**

If validation fails and the failure is unrelated or uncertain, the implementer returns control immediately with:

- failing command;
- compact relevant output/reference;
- suspected boundary;
- candidate/patch identity.

`uncertain` is treated like `unrelated` for authority purposes.

The implementer is not permitted to spend a large exploration budget merely to classify an external failure.

## 9. Test modification policy

Test mutation is an explicit packet capability.

The implementer may create or update tests only if the Implementation Packet authorizes that class of test change.

If an unauthorized test fails, the worker may report the failure but may not rewrite the test to obtain green validation.

If test modification is authorized, repair is still limited to behavior within the packet. A worker cannot use test authorization as permission for a broader redesign.

## 10. Cheap diff auditor

Direct Work may launch a second independent cheap worker after a candidate/diff exists.

Logical role: `QUICK_AUDITOR`.

Its purpose is not repository review. Its exact mission is:

> **Determine whether this specific candidate/diff correctly implements this specific Implementation Packet.**

### 10.1 Inputs

The auditor receives:

- Implementation Packet;
- candidate identity;
- diff/patch;
- changed-file list;
- available validation results/evidence references.

It does not inherit the implementer's hidden reasoning or exploratory context.

### 10.2 Allowed reads

The auditor may:

- inspect changed hunks and immediate surrounding code;
- follow a directly used type/interface/symbol needed to judge a hunk;
- inspect an explicitly corresponding test;
- resolve an exact reference required to validate a finding.

It may not:

- grep broadly to hunt unrelated bugs;
- audit repository architecture;
- search for general code smells;
- inspect unrelated files;
- perform git archaeology without explicit control-plane authorization;
- reinterpret the task;
- propose broad alternative designs;
- generate opportunistic refactor recommendations.

### 10.3 Finding validity

> **A Quick Audit finding is valid only when it has a causal path to the submitted diff or to an explicit acceptance criterion.**

Direct Work audit output is intentionally binary and compact:

```yaml
audit:
  verdict: PASS | BLOCKING_FINDING
  findings:
    - location: ChapterRepository.kt:83
      packetRequirement: preserve_offline_behavior
      issue: invalidation now runs before persistence succeeds
      evidence: added lines 81-84 execute before save completion
```

No `nit`, style essay, speculative suggestion, or unrelated warning is emitted in this lane.

### 10.4 No worker-to-worker correction loop

The auditor never instructs the implementer directly.

On `BLOCKING_FINDING`:

1. control validates or dismisses the finding;
2. if valid, control emits a narrow Delta Packet;
3. the implementer applies only the confirmed correction;
4. required validation/audit is repeated according to policy.

This preserves bounded delta retries and prevents cheap models from entering an unbounded debate loop.

## 11. Parallel post-implementation verification

Once a candidate exists, independent verification should be parallelized when beneficial:

```text
                 ┌→ CI / authoritative evidence
CANDIDATE ───────┤
                 └→ QUICK_AUDITOR
```

Neither path should wait for the other to begin.

The control plane consumes both results when required by the task's acceptance policy.

Quick Audit is not mandatory for every mechanical change. Policy may choose:

- mechanical/low-risk: evidence only;
- normal product code: evidence + Quick Audit;
- high-risk: deeper review/escalated workflow.

## 12. Acceptance

Only the control plane can transition a work unit to accepted terminal state.

Acceptance evaluates factual candidate-bound evidence, not worker confidence.

A normal Direct Work acceptance decision consumes:

- exact candidate identity/HEAD where applicable;
- required validation evidence;
- Quick Audit result when policy requires it;
- scope/capability compliance;
- absence of unresolved blocking findings;
- current Work Lease generation.

Acceptance must fail closed if evidence belongs to a different candidate generation or stale workspace identity.

## 13. Authority redesign: session identity is provenance

Orchestra 1.x removes conversation/session identity as the permanent owner of project authority.

The current pattern:

```text
PROJECT
  ↓
mainConversationId / root session_id
  ↓
all orchestration authority
```

is replaced by:

```text
PROJECT LINEAGE
  ↓
WORKSPACE
  ↓
WORK UNIT / TASK
  ↓
WORK LEASE GENERATION
  ↓
CAPABILITY
```

Provider `conversationId` / `session_id` remains factual and valuable, but only as an **actor/provenance identifier**.

### 13.1 Core rule

> **Chats do not own projects. Work leases govern mutations.**

A conversation may be recorded as:

- `createdBySession`;
- `lastActorSession`;
- `implementationActor`;
- `auditActor`;
- `acceptanceActor`;

but not as permanent `PROJECT_OWNER`.

## 14. Work Lease

`WorkLease` is a versioned factual runtime object that grants temporary capability over a work unit/workspace generation.

Illustrative shape:

```yaml
schema: orchestra.work-lease.v1
projectLineage: tsuzuki
workspaceId: primary
taskId: chapter-refresh-fix
generation: 18
state: IMPLEMENTING
actor:
  provider: codex
  sessionIdHash: ...
capabilities:
  - WORKSPACE_EDIT
candidate: null
```

The exact storage must avoid unnecessary exposure of raw provider identifiers where a stable hash is sufficient.

### 14.1 Generation fencing

Every mutation-sensitive action is checked against the current lease generation.

If a previous chat resumes with generation 17 after a new actor has atomically claimed generation 18:

```text
STALE_WORK_LEASE
actorGeneration: 17
currentGeneration: 18
```

Mutation is denied.

This protects against stale writers without requiring the project to remain hostage to the old conversation.

### 14.2 Claiming a new lease

A fresh root/session may claim work when factual state allows it.

An automatic claim is permitted when, for the relevant workspace/work unit:

- no incompatible mutation is in progress;
- no active writer capability is executing;
- repository/workspace identity is coherent;
- any existing candidate/evidence state is preserved and attributable;
- claim can be serialized atomically.

The existence of another historical conversation is not itself a denial condition.

### 14.3 Actual incompatibility blocks

Claim/mutation is denied when factual incompatible work exists, such as:

- implementer actively writing;
- patch application in progress;
- merge/rebase or other exclusive workspace mutation in progress;
- runtime transaction in a non-recoverable intermediate state.

The denial reason describes the real conflicting operation, not merely an old session identity.

## 15. Evidence and CI survive chat changes

CI/evidence belongs to work/candidate identity, not to the chat that triggered it.

Example:

```yaml
taskId: chapter-refresh-fix
candidate: abcdef1
evidenceGeneration: 22
ci:
  provider: github-actions
  runId: 123
  state: RUNNING
```

If a new control chat assumes the work while CI is running, it may continue observing and accepting that exact candidate when the evidence completes.

A chat transition must not invalidate valid work merely because `session_id` changed.

This removes the need for current-style milestone handoff as the normal mechanism of authority transfer.

## 16. Session transition and continuation

The runtime may still preserve bounded continuation facts to improve UX, but these are separate from authority ownership.

A new session should be able to discover factual project/work state according to its capabilities without importing prior transcripts or hidden reasoning.

Continuation material remains reference-oriented and bounded:

- active task/work unit;
- state;
- candidate identity;
- pending evidence/audit;
- lease generation;
- explicit unresolved blockers;
- approved implementation direction when task is still active.

Provider transcripts, hidden reasoning, large stdout/stderr dumps, and arbitrary prior conversation content remain excluded.

## 17. Provider-neutral core and provider adapters

The 1.x architecture moves operational provider-neutral concepts into an executable core.

Target structure:

```text
orchestra/
├── core/
│   ├── domain/
│   │   ├── task/
│   │   ├── implementation-packet/
│   │   ├── scope/
│   │   ├── authority/
│   │   ├── capability/
│   │   ├── candidate/
│   │   ├── evidence/
│   │   └── audit/
│   ├── state-machine/
│   ├── acceptance/
│   ├── retries/
│   ├── trust/
│   └── leases/
│
├── providers/
│   ├── codex/
│   │   ├── adapter/
│   │   ├── hooks/
│   │   ├── profiles/
│   │   └── model-catalog/
│   └── antigravity/
│       ├── adapter/
│       ├── hooks/
│       ├── profiles/
│       └── model-catalog/
│
├── runtime/
│   ├── installer/
│   ├── manifests/
│   ├── backup/
│   └── migration/
│
├── labs/
│   ├── dream/
│   └── jev/
│
├── schemas/
├── cli/
└── tests/
    ├── core/
    ├── provider-contract/
    ├── integration/
    └── invariants/
```

### 17.1 Firewall rule

The cross-provider firewall changes from duplicated provider-local behavior to explicit adapter boundaries:

- core imports no provider runtime;
- Codex adapter may import core but never Antigravity;
- Antigravity adapter may import core but never Codex;
- provider-specific model IDs, hooks, session fields, and tool semantics remain inside the adapter/provider tree;
- labs consume neutral events/artifacts and retain `authority=NONE` unless a future spec explicitly changes that.

This deliberately supersedes the current rule that executable shared behavior must not exist outside provider runtime trees.

## 18. Canonical schemas

Markdown contracts are documentation, not the source of truth.

1.x introduces versioned executable schemas, beginning with:

```text
schemas/
  implementation-packet.v1.schema.json
  scope-contract.v2.schema.json
  work-lease.v1.schema.json
  evidence.v1.schema.json
  candidate.v1.schema.json
  audit-result.v1.schema.json
  runtime-event.v1.schema.json
```

Runtime validation consumes the schemas. Documentation examples must be generated from or checked against them.

This replaces drift such as old `requiredValidation` documentation coexisting with runtime `requiredEvidence`, capability fields, and newer stop-condition semantics.

## 19. Logical roles and model catalogs

Core policy refers to logical roles, not commercial model SKU strings.

Initial logical roles:

```text
CONTROL
IMPLEMENTER
INVESTIGATOR
QUICK_AUDITOR
CRITICAL_REVIEWER
MANUAL_ESCALATION
```

Provider catalogs map these roles to current models and reasoning levels.

For example, the Codex catalog may map:

- `CONTROL` → GPT-6 Sol profile;
- `IMPLEMENTER` → GPT-6 Luna profile;
- `QUICK_AUDITOR` → GPT-6 Luna review profile;
- `CRITICAL_REVIEWER` → GPT-6 Sol review profile.

Changing GPT model generations should normally be a provider-catalog update, not an architecture migration.

## 20. State-machine direction

The current formal workflow remains useful but must be simplified for the normal path.

Direct Work should conceptually operate as:

```text
INTAKE
  ↓
RESOLVING
  ↓
IMPLEMENTATION_READY
  ↓
IMPLEMENTING
  ↓
CANDIDATE_READY
  ├→ EVIDENCE_PENDING
  └→ AUDIT_PENDING
  ↓
ACCEPTANCE
  ↓
DONE
```

Not every state needs to be serialized if it carries no recovery or authority value. The implementation plan should distinguish externally meaningful state from transient control-flow labels.

Escalation may branch to investigation/orchestrated states, but Direct Work should not pay that state complexity unless required.

## 21. Delta correction

When acceptance or Quick Audit identifies a confirmed patch-local issue, control emits a `DeltaPacket` rather than rebuilding the full task.

A Delta Packet contains:

- original task/candidate lineage;
- exact confirmed finding;
- permitted correction area;
- unchanged original direction;
- required revalidation.

The implementer is prohibited from using a delta retry as a new investigation cycle.

Retry budgets remain bounded.

## 22. Runtime packaging and source ownership

The reformulation should separate:

1. development source;
2. tests;
3. generated/installed provider runtime artifacts;
4. project-owned state.

Provider runtime directories should not simultaneously serve as the canonical development source, distribution payload, and primary test location.

Runtime installers should consume manifests that declare managed assets and versions. Doctor/health checks should validate manifests/schemas/invariants rather than rely on long manually maintained arrays of physical paths.

## 23. Labs boundary

Dream and Jev must have explicit boundaries.

Default 1.x rule:

- labs may observe neutral runtime events and artifacts;
- labs may persist experimental analysis within declared storage;
- labs do not satisfy acceptance;
- labs do not grant capabilities;
- labs do not own work leases;
- labs do not become required runtime authority merely because files exist in the repository.

If Dream or Jev later gains stronger authority, that requires a separate design/spec and explicit trust review.

## 24. Migration strategy

This is an incremental extraction, **not a rewrite from scratch**.

The current green 0.10 behavior and tests act as a regression oracle while ownership is moved.

### Phase 0 — Constitution and behavior oracle

- codify permanent invariants from this spec;
- identify current tests that protect them;
- add provider-contract tests around behavior that must survive refactoring;
- establish measurable workflow latency/turn counters for representative Direct Work tasks.

### Phase 1 — Canonical domain and schemas

Introduce provider-neutral schemas/types for:

- Implementation Packet;
- Scope/Capability;
- Candidate;
- Evidence;
- Quick Audit result;
- Work Lease.

Adapters initially translate existing runtime state into these structures without changing external behavior.

### Phase 2 — Extract neutral core

Move behavior already identical or conceptually provider-neutral out of duplicated runtime trees first, especially:

- evidence federation;
- evidence watch semantics;
- feedback/event primitives where still needed;
- lease/candidate/evidence validation;
- acceptance predicates that do not depend on provider hooks.

Keep compatibility shims while provider tests migrate.

### Phase 3 — Direct Work lane

Implement the new fast path behind an explicit feature/policy gate:

- control resolves and emits Implementation Packet;
- Luna implementer obeys Directed Discovery;
- candidate creation;
- CI/evidence + Quick Audit fan-out;
- Sol acceptance;
- bounded Delta Packet correction.

Run shadow/comparison tests against representative existing workflows before making it default.

### Phase 4 — Work Lease authority

Introduce task/workspace lease generation alongside current session authority.

Migration must prove:

- stale writers are fenced;
- fresh sessions can continue factual work without manual handoff;
- active writers remain protected;
- CI/evidence survive session changes;
- provider session IDs remain attributable provenance.

Only after these invariants pass should `mainConversationId` / root-session ownership cease being the primary authority mechanism.

### Phase 5 — Provider adapters and model catalogs

Move Codex/Antigravity hook semantics and model identifiers behind provider adapters/catalogs.

Remove duplicated neutral control logic once parity tests establish equivalent behavior.

### Phase 6 — Enforcement decomposition

Split current mini-kernel files such as routing policy, pre-tool enforcement, stop guard, and telemetry into narrowly owned components:

- classification/escalation;
- packet validation;
- discovery authorization;
- capability authorization;
- lease enforcement;
- candidate/evidence transitions;
- acceptance;
- telemetry/event emission.

### Phase 7 — Packaging, labs, doctor, documentation

- manifest-driven runtime packaging;
- source/test/distribution separation;
- Dream/Jev zero-authority lab boundary;
- schema-driven Doctor checks;
- generated/validated docs;
- remove obsolete handoff compatibility after migration window.

### Phase 8 — Repository governance and release hygiene

Before declaring 1.x stable:

- define protected/ruleset-governed `main` policy;
- remove merged stale development branches according to repository policy;
- align GitHub Releases with actual product versioning;
- document migration and rollback from 0.10.

## 25. Performance and cost acceptance criteria

The reformulation exists partly to improve practical development velocity. Functional equivalence alone is insufficient.

Representative benchmarks must record at least:

- number of control-model turns;
- number of worker turns;
- number of repository discovery operations;
- redundant reads;
- time/turns before first edit;
- number of delegations;
- number of model-to-model handoffs;
- validation wait structure;
- task completion outcome;
- approximate provider/model cost where available.

For normal Direct Work tasks, the target qualitative shape is:

```text
CONTROL: understand/investigate once
IMPLEMENTER: implement once (+ bounded self-repair)
AUDITOR: review diff once when required
CONTROL: accept once
```

The runtime should detect regressions where a normal task unexpectedly becomes a chain of repeated classification, rediscovery, delegation, and review cycles.

## 26. Security acceptance criteria

1.x is acceptable only if tests prove at least:

- stale lease generations cannot mutate;
- two incompatible writers cannot concurrently own the same workspace mutation capability;
- a historical session ID alone cannot block a healthy new control session;
- a new session cannot steal an active factual writer lease;
- workers cannot elevate Directed Discovery into Investigative Discovery;
- implementers cannot modify unauthorized tests;
- unrelated/uncertain validation failures return to control;
- Quick Auditor cannot broaden review beyond diff/task causal scope;
- auditor cannot directly coordinate implementer correction;
- evidence from another candidate/generation cannot satisfy acceptance;
- failed tools do not become evidence;
- provider-specific authority facts cannot cross adapter boundaries;
- labs remain non-authoritative;
- transcript/hidden reasoning never becomes required continuation state.

## 27. Non-goals for the first 1.x migration

The first migration does not attempt to:

- make every workflow fully provider-agnostic at once;
- introduce arbitrary concurrent writers in one workspace;
- make Dream/Jev decision authorities;
- replace Git/provider-native CI;
- optimize every rare high-risk orchestration scenario before Direct Work is proven;
- let cheap workers perform broad autonomous investigation;
- eliminate all compatibility state in one release;
- reproduce ChatGPT Web internals literally.

The goal is to reproduce the **effective working pattern**: concise control reasoning, fast delegated implementation, bounded independent verification, factual acceptance, and minimal coordination overhead.

## 28. Representative scenarios

### 28.1 Normal bug fix

1. User reports a bounded bug.
2. Sol inspects enough code to identify cause/direction.
3. Sol emits an Implementation Packet with anchors and authorized regression test change.
4. Luna locates exact symbols, edits, adds regression coverage, runs focused validation.
5. Candidate is created.
6. CI and Quick Auditor run in parallel.
7. Auditor returns PASS; CI passes.
8. Sol accepts.

No additional investigator or reviewer is spawned.

### 28.2 External test failure

1. Luna implements candidate.
2. Declared validation fails in an apparently unrelated module.
3. Luna does not investigate broadly and does not edit the failing external test.
4. Luna returns failure evidence to Sol.
5. Sol determines whether this is pre-existing, infra, or actually causal.
6. Control either accepts alternative authoritative evidence, emits a Delta Packet, or escalates investigation.

### 28.3 Quick Audit finding

1. Candidate exists.
2. Quick Auditor finds that a new line violates an explicit preservation criterion.
3. Auditor returns one blocking finding tied to the diff.
4. Sol confirms it.
5. Sol emits a narrow Delta Packet.
6. Luna fixes that issue only and revalidates.
7. Candidate generation advances and stale evidence is rejected.

### 28.4 Fresh chat during CI

1. Implementation is complete and candidate SHA exists.
2. CI is running; no writer is active.
3. User opens a fresh control chat.
4. New chat reads factual task/candidate/evidence state.
5. It atomically claims the next compatible control/work generation.
6. Old chat becomes stale for future mutation.
7. Existing CI remains valid because it is bound to candidate SHA, not chat ID.
8. New chat completes acceptance when evidence arrives.

No manual session handoff is required.

### 28.5 Fresh chat while Luna is actively writing

1. Luna holds an active mutation lease.
2. New control chat appears.
3. New chat may read bounded factual status but cannot acquire an incompatible writer capability.
4. It receives a factual `WRITE_LEASE_ACTIVE` state rather than a historical session-ownership denial.
5. Once the mutation transaction terminates, control may claim the next generation.

## 29. Design consequences

This design intentionally changes Orchestra from a milestone-accumulated collection of provider-local control mechanisms into a platform with an explicit kernel.

The central simplifications are:

- Direct Work is normal; orchestration is escalation.
- Sol owns ambiguity reduction and acceptance.
- Luna owns bounded implementation volume.
- a second Luna may audit the candidate, but only inside strict diff/task boundaries.
- CI/evidence is candidate-owned.
- chats provide provenance, not project ownership.
- Work Lease generations provide factual mutation fencing.
- provider adapters own provider mechanics;
- schemas and core own neutral contracts and policy.

The desired operational result for projects such as Tsuzuki is simple:

> **Resolve quickly, delegate once, implement cheaply, verify in parallel, accept factually, and move on.**
