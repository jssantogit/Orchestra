# Orchestra Milestones I-K Specification

Status: IMPLEMENTING
Target cycle: Orchestra 0.4.x -> 0.6.x
Base: 63d96a2982f85c33974338f5cb2cdbbf15d850e1

## Objective

Extend Orchestra after Dream Milestone H+ in three strictly ordered layers:

1. Milestone I — Attributable Feedback Plane
2. Milestone J — Context & Side-Effect Trust Boundary
3. Milestone K — Full Exploration Policy

The later milestone MUST NOT weaken authority established by an earlier milestone.

## Milestone I — Attributable Feedback Plane

Evidence answers whether work is acceptable. Feedback answers what an observation demonstrates and which hypothesis it changes.

### Records

- `HYPOTHESIS`: a model-declared, falsifiable claim. Never factual merely because an agent emitted it.
- `EXPERIMENT`: a model-declared test design bound to one hypothesis and an exact command.
- `OBSERVATION`: runtime-derived binding from an experiment to an Evidence Ledger execution.
- `FEEDBACK`: deterministic inference over factual observations.

### Confidence states

`OBSERVED -> SUPPORTED | FALSIFIED -> CAUSALLY_VERIFIED`

`CAUSALLY_VERIFIED` requires a bounded before/after intervention pattern: the same exact factual validation command must fail before and pass after, the experiment must explicitly opt into `MUTATION_AB`, and exactly one HIGH-confidence `RUNTIME_IDENTITY` mutation may occur between those observations. That intervention must touch at least one hypothesis `target_paths` entry. Multiple/intervening mutations are confounded and remain at most `SUPPORTED`. A textual root-cause claim can never satisfy this state.

### Authority

- Feedback never satisfies an Evidence Contract.
- Feedback never grants write/tool/routing authority.
- Failed/unbound/model-only evidence remains `UNKNOWN`.
- Records are task/attempt/mutation/actor bound and content addressed.
- Runtime-derived observations reference factual Evidence Ledger IDs/execution IDs.

## Milestone J — Context & Side-Effect Trust Boundary

Principle: data may cross a context boundary; authority may not.

### Context trust classes

- `RUNTIME_AUTHORITY`: runtime state, Scope Contract, role bindings, Evidence Ledger, Human Gate state.
- `MODEL_CLAIM`: worker/reviewer/orchestrator prose and handoff fields.
- `UNTRUSTED_CONTEXT`: compacted summaries, retrieved external text, tool output text, historical prose.
- `FACTUAL_EVIDENCE_REF`: references to runtime-verified evidence, still not instructions.

A Runtime Continuation Capsule is derived only from `RUNTIME_AUTHORITY`; compacted summaries can add semantic hints but cannot change scope, roles, required evidence, attempt budget, human gates, or routing authority.

### Side-effect capabilities

`LOCAL_READ, LOCAL_WRITE, PROCESS_EXEC, NETWORK_READ, NETWORK_WRITE, REMOTE_REPO_WRITE, VCS_REMOTE_WRITE, CROSS_AGENT_MESSAGE, PUBLICATION`.

Remote/public writes default deny unless the active factual contract explicitly grants the required capability. This boundary is enforced by a global PreToolUse guard independent of the native scope-enforcer matcher, so newly introduced plugins/connectors cannot bypass capability classification. Unknown external-tool semantics fail toward `NETWORK_WRITE`; clearly read-only external verbs may use `NETWORK_READ`.

## Milestone K — Full Exploration Policy

Only after I and J are enforced may Dream optimize exploration control.

New decision points:

- `EXPLORATION_BRANCHING`: whether to open another bounded hypothesis branch.
- `PARALLELISM`: bounded sibling count within runtime maximum.
- `PRUNE_BRANCH`: terminate a branch proven dominated/invalid.
- `STOPPING`: continue investigation vs stop with evidence.

Hard ceilings remain static governance, not learned policy. Learned policy may choose a value only inside the legal action set computed by runtime authority.

K preserves standalone Milestone-E semantics. Additional siblings are legal only when `prepareExploration` can verify an active `orchestra.full-exploration.v1` controller with the exact static limits, a fresh branch ordinal, and an exact O_EXCL-created branch-slot capability token. The controller namespaces E reservations and excludes alternatives already selected for the same factual source decision. It also scans valid sealed worlds for the exact `snapshot_id + decision_type + state_hash` and excludes already observed actions across previous K sessions. No similarity inference is used.

Controller shutdown is quiescence-aware. A human stop with live branches or pending causal outcomes enters `STOP_REQUESTED`; a successor controller cannot start until those branches terminate and every recorded control decision is closed. Budget exhaustion follows the same quiescence requirement.

K control decisions use **deferred causal outcomes**:
- `CONTINUE_EXPLORATION`, `OPEN_BRANCH`, and `PARALLELISM` are recorded before execution but remain outcome-pending;
- they close only when the corresponding branch yields a sealed factual world, or when a factual infrastructure failure proves the branch consequence unavailable;
- infrastructure/setup failures are factual but `attributable: false` and therefore become `INSUFFICIENT_SUPPORT`, never negative policy evidence;
- each K decision/outcome pair is sealed into its own one-decision world, preventing multiple decision types at one snapshot from becoming ambiguous in Exact Replay;
- failed materialization still consumes a K branch attempt so repeated setup failure cannot create an unbounded retry loophole.

K inherits Exact Replay, UNKNOWN_BRANCH semantics, holdout evaluation, Shadow, progressive Canary, human promotion, and all Milestone J capability restrictions.

## Delivery

Each milestone receives:
- deterministic runtime module(s);
- unit tests;
- architecture invariant tests;
- documentation;
- doctor/package integration;
- full CI before merge.

No Tsuzuki runtime update occurs until I-K are merged and the resulting Orchestra runtime version is final.
