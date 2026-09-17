# Orchestra Dream Layer — Technical Specification

**Date:** 2026-09-17  
**Status:** APPROVED DESIGN SPECIFICATION — ready for implementation planning  
**Baseline:** `0e1dc980bf0d7eed8bf986c8e3e3f574520497eb`  
**Initial runtime:** Antigravity / ALL-GEMINI only  
**Research basis:** *Dream-RSI: Recursive Self-Improvement through Evolving Worlds* (Zheng et al., 2026, arXiv:2609.14858)

## 1. Purpose

The Orchestra Dream Layer adds recursive improvement to **operational policy**, not to model weights, agent definitions, enforcement hooks, or safety rules. It learns from factual execution outcomes and may eventually choose more efficient routes among actions already authorized by immutable Orchestra governance.

The system adopts the Dream-RSI pattern of online exploration -> discovery history -> offline replay -> policy improvement, but applies stricter causal, safety, and deployment constraints appropriate to a coding orchestration runtime.

The first implementation is deliberately limited to **Decision History + Exact Replay foundation**. It MUST NOT introduce automatic exploration, LLM policy design, shadow execution, canary deployment, or automatic policy promotion.

## 2. Normative language

`MUST`, `MUST NOT`, `SHOULD`, and `MAY` are normative. Existing Orchestra safety/fidelity invariants take precedence over this spec. This spec takes precedence over generated policy data or LLM instructions.

Source-of-truth order:

```text
1. Existing Orchestra safety/fidelity invariants
2. This specification
3. Versioned schemas + deterministic tests derived from this spec
4. Active/static policy data
5. LLM instructions or suggestions
```

## 3. Hard invariants

1. Dream MUST NOT modify or bypass state-machine rules, hooks, Scope Contracts, Evidence Ledger semantics, Human Gate, Two-Key Review, retry budgets, provider restrictions, action-space construction, policy evaluator, cross-runtime firewall, or promotion/rollback governance.
2. Discovery History MUST NOT enter worker context. The orchestrator MUST NOT receive raw history by default.
3. Exact Replay MUST reveal only outcomes actually observed for the same `snapshot_id`. Missing branches MUST return `UNKNOWN_BRANCH`.
4. Mutable policy MUST be declarative and schema-valid. LLM-generated arbitrary JavaScript/Python MUST NOT execute as policy.
5. Any Dream-layer failure MUST degrade to the validated static routing path without turning a healthy task into failure. Governance failures remain fail-closed.
6. Dream v1 MUST be AGY-only. Codex MUST remain operationally isolated.
7. Phase 1 MUST be record-only and behaviorally identical to the validated Orchestra baseline.
8. Dream MUST NOT increase its own authority, budgets, or evaluation criteria.

## 4. Architecture

### 4.1 Immutable governance

Immutable surfaces include:

- `pre-tool-enforce` and all enforcement hooks;
- valid state transitions;
- Scope Contract semantics;
- orchestrator product-write prohibition;
- reviewer write prohibition;
- worker no-subagent/no-self-accept rules;
- Evidence Ledger and freshness rules;
- `FAILED TOOL IS NOT EVIDENCE`;
- maximum retry budget;
- Human Gate;
- Two-Key Review;
- cross-runtime firewall;
- allowed model/provider families;
- action-space constructor;
- evaluator and comparison order;
- exploration-budget ceilings;
- side-effect safety rules;
- policy activation/rollback mechanism;
- schema validator and policy interpreter.

### 4.2 Mutable policy surface v1

Only three decision classes may become mutable:

- `WORKER_TIER`
- `INVESTIGATION_STRATEGY`
- `RETRY_ACTION`

Out of scope until a future architectural review: provider selection, reasoning-effort selection independent of worker tier, review policy, stopping policy, context allocation, test strategy, branch count, general parallelism, retry-budget size, Human Gate behavior, Two-Key behavior.

### 4.3 Data flow

```text
ONLINE
Task
 -> Governance normalization/classification
 -> Snapshot
 -> Governance-derived legal Action Space
 -> Static/active policy choice
 -> DECISION record
 -> Existing Orchestra execution path
 -> Existing Evidence Ledger path
 -> DECISION_OUTCOME
 -> sealed World / Discovery History

OFFLINE
Sealed Worlds
 -> Discovery tree projection
 -> Exact Replay
 -> Deterministic evaluation
 -> candidate analysis
```

The online runtime MUST NOT read historical worlds to answer ordinary task decisions in v1.

## 5. Component layout

Versioned runtime code:

```text
.agents/dream/
  schemas/
    snapshot-v1.schema.json
    decision-v1.schema.json
    outcome-v1.schema.json
    policy-v1.schema.json
    world-v1.schema.json
  canonical.mjs
  snapshot.mjs
  action-space.mjs
  decision-recorder.mjs
  outcome-recorder.mjs
  world-sealer.mjs
  discovery-tree-builder.mjs
  replay-simulator.mjs
  evaluator.mjs
  policy-engine.mjs
  policies/
    static-policy-v1.json
```

Later milestones MAY add `branch-materializer.mjs`, `policy-development.mjs`, and administrative CLI commands.

Generated local state:

```text
.agents/dream-data/
  worlds/
  snapshots/
  indexes/
  replay/
  aggregates/
  policies/
    versions/
    candidates/
    active.json
    history.jsonl
  shadow/
  canary/
```

`.agents/dream-data/` MUST be ignored by Git, MUST NOT be copied by installers as project history, MUST remain local by default, and MUST never be injected into worker prompts.

`.agents/telemetry/events.jsonl` remains the factual online stream. Discovery trees, indexes, aggregates, and replay reports are derived artifacts.

## 6. Policy format

Policy schema: `orchestra.exploration-policy.v1`.

Conceptual form:

```json
{
  "schema": "orchestra.exploration-policy.v1",
  "policy_id": "policy-<sha256>",
  "base_policy": "static-policy-v1",
  "rules": [
    {
      "id": "failed-test-first-retry",
      "decision_type": "RETRY_ACTION",
      "priority": 100,
      "when": {
        "task_action": ["IMPLEMENT"],
        "criticality": ["NORMAL"],
        "retry_reason": ["FAILED_TEST"],
        "attempt": {"min": 1, "max": 1}
      },
      "choose": "RETRY_SAME"
    }
  ]
}
```

Constraints:

- AND across fields in `when`;
- OR only through enum arrays;
- numeric `min`/`max` only for `attempt` and `retry_remaining`;
- no regex;
- no JavaScript expressions;
- no filesystem/network/time/history-ID access;
- no free-text conditions;
- maximum 128 rules;
- maximum serialized size 64 KiB;
- explicit descending priority;
- equal-priority conflicting matches => `POLICY_CONFLICT` and policy invalid;
- no match => `BASELINE_ACTION`.

Policy corruption, incompatibility, illegal action, schema failure, or hash failure MUST fall back to the validated static policy and record diagnostics.

## 7. Static-policy migration

Adoption MUST be staged:

**Phase A — observation:** current `routing-policy.mjs` remains authoritative; Dream only records decisions/outcomes with `policy_source=STATIC_ROUTING_CURRENT`.

**Phase B — parity shadow:** `static-policy-v1.json` represents current choices but runs only for comparison against the current router. Supported state-space parity MUST be 100%.

**Phase C — interpreter overlay:** only after deterministic parity + regression gates may the declarative interpreter make the three mutable decision classes. Original routing remains fallback.

The introduction of Dream instrumentation MUST NOT simultaneously change behavior being measured.

## 8. Action Space v1

Governance derives `available_actions`; policy selects one legal member.

### 8.1 `WORKER_TIER`

| State class | Legal actions |
|---|---|
| mechanical/docs/simple | `FLASH_LOW`, `FLASH_MEDIUM` |
| normal implementation | `FLASH_MEDIUM`, `FLASH_HIGH` |
| difficult/experimental/integration/post-investigation | `FLASH_HIGH` only |
| `CRITICAL` | fixed governance route |
| `DIRECT_ACTION` | outside Dream |

Reasoning effort remains bound to tier in v1.

### 8.2 `INVESTIGATION_STRATEGY`

Actions: `IMPLEMENT_DIRECT`, `INVESTIGATE_FIRST`.

Eligible only before first mutation, for technical `NORMAL`/`MAJOR` tasks without external side effects, excluding Direct Action, mechanical-only, critical-review, and tasks already classified as `INVESTIGATE`.

### 8.3 `RETRY_ACTION`

| Retry reason | Legal actions |
|---|---|
| `FAILED_TEST` | `RETRY_SAME`, `ESCALATE_WORKER`, `INVESTIGATE_FIRST` |
| `INCOMPLETE_IMPLEMENTATION` | `RETRY_SAME`, `ESCALATE_WORKER` |
| `MISSING_CONTEXT` | `INVESTIGATE_FIRST`, `REPLAN` |
| `MISINTERPRETED_REQUIREMENT` | `REPLAN` |
| `SCOPE_GAP` | `REPLAN` |
| `INTEGRATION_FAILURE` | `ESCALATE_WORKER`, `REPLAN` |

Policy MUST NOT increase retry budget.

## 9. Decision State contract

Policy-visible state is structured and compact:

```json
{
  "task_action": "IMPLEMENT",
  "task_domain": "CODE",
  "criticality": "NORMAL",
  "complexity": "NORMAL",
  "state": "EXECUTING",
  "attempt": 1,
  "retry_remaining": 1,
  "retry_reason": "FAILED_TEST",
  "mutation_seq": 1,
  "post_investigation": false,
  "evidence": {
    "tests": "FAIL",
    "typecheck": "PASS",
    "build": "NOT_REQUIRED",
    "scope_check": "PASS",
    "validation_fresh": true
  }
}
```

Raw prompts, source code, stack traces, chat history, web/file text, and outcomes from unrelated tasks MUST NOT be policy-visible. `UNKNOWN` is explicit; missing values MUST NOT be inferred as PASS.

## 10. Snapshot Contract v1

Exact Replay requires strict `snapshot_id` equality.

```text
snapshot_id = SHA-256(canonical({
  schema,
  task_fingerprint,
  contract_fingerprint,
  runtime_fingerprint,
  workspace_fingerprint,
  environment_fingerprint,
  execution_state_identity,
  evidence_fingerprint
}))
```

### 10.1 Task fingerprint

Includes normalized task-spec hash plus `taskAction`, `taskDomain`, and `criticality`. Normalization is limited to line endings and trailing whitespace. Rephrasing may intentionally produce a new fingerprint; false negatives are preferable to false equivalence.

### 10.2 Contract fingerprint

Canonicalizes `allowedPaths`, `forbiddenPaths`, acceptance criteria, required validation, `doNotChange`, retry budget, domain, and criticality. Set-like arrays are sorted; order-sensitive arrays preserve order.

### 10.3 Runtime fingerprint

Includes schema versions, hashes/versions of relevant governance/hooks, state machine, action space, Evidence Ledger semantics, agent profiles, AGY runtime/CLI, Node, OS/architecture, model identifiers, and declared project toolchain fingerprint.

The active exploration policy MUST NOT be part of runtime fingerprint.

### 10.4 Workspace fingerprint

V1 uses a conservative manifest of regular workspace files except deterministic exclusions: `.git/`, dependency stores, build outputs/caches, `.agents/state/`, `.agents/telemetry/`, `.agents/artifacts/`, `.agents/dream-data/`, and configured temporary/log paths.

Each manifest entry includes relative path, type, executable bit, size, and SHA-256 content hash. Timestamps are excluded. Large/binary files are streaming-hashed and never loaded into model context.

Internal symlinks record target text. Symlinks escaping the workspace make Exact Replay ineligible (`EXTERNAL_SYMLINK_UNSAFE`) unless an immutable project configuration fingerprints the external dependency.

### 10.5 Environment fingerprint

Only allowlisted execution-affecting variables participate, represented as variable name + value hash. Secret values MUST NOT be stored. Unfingerprinted external state that can affect execution makes exploration/promotion ineligible.

### 10.6 Canonicalization

`orchestra.snapshot.v1` uses UTF-8, lexicographically sorted object keys, `/` separators, workspace-relative paths, preserved path case, finite JSON numbers, no `undefined`, no timestamps/event IDs in identity, and schema-declared sorting only for set-like arrays.

Semantic changes require a new snapshot schema version; old history MUST NOT be silently reinterpreted.

## 11. Decision and Outcome records

IDs:

- `decision_id = dec-<UUID>`
- `branch_instance_id = br-<UUID>`
- `observation_id = obs-<UUID>`
- `world_id` derived from root snapshot + task lineage + runtime fingerprint.

`DECISION` MUST be written before execution and include schema, IDs, parent decision when applicable, snapshot ID, decision type, policy-visible state, available actions, chosen action, policy ID/source, factual actor identity, and audit timestamp.

`DECISION_OUTCOME` MUST include decision ID, observation/branch IDs, local result, resulting snapshot when applicable, evidence summary, retry semantics, cost metrics, terminal acceptance state when applicable, and Evidence Ledger provenance IDs.

Local failure MUST NOT be conflated with trajectory failure. `DecisionOutcome` captures immediate consequence; `TrajectoryOutcome` aggregates a decision sequence until terminal state or `UNKNOWN_BRANCH`. Policy promotion may use only complete supported trajectories.

## 12. Telemetry integrity and world sealing

`events.jsonl` remains the online append-only event stream and gains `DECISION` + `DECISION_OUTCOME` events.

Each event has:

```text
event_hash = SHA-256(canonical(event_without_hash))
```

A global append-order hash chain is NOT required in v1 because hook processes may be independent. `world-sealer` validates schema, correlations, hashes, actor identity, snapshot/runtime fingerprints, and required evidence, then produces a `world_manifest_hash` over ordered relevant event IDs/hashes.

A world enters replay only if all decisions are closed or explicitly aborted, actor identity is factual, snapshot/runtime fingerprints validate, required evidence correlates, and no hard integrity violation exists. Otherwise it is `WORLD_INCOMPLETE`/invalid and excluded from learning.

## 13. Discovery Tree semantics

A world projects to a causal tree with multiple observations per state/action edge:

```text
Snapshot S0
  |- MEDIUM
  |   |- O1 -> FAILED_TEST -> S1
  |   `- O2 -> ACCEPTED
  `- HIGH
      `- O3 -> ACCEPTED
```

Legal but unobserved actions are `UNKNOWN_BRANCH`. Exact Replay has no predicted outcome.

Persistence is tree-first: each observation has one causal parent. Storage indexes MAY deduplicate identical snapshots as a content-addressed DAG, but deduplication MUST NOT alter original lineage.

The tree is derived from sealed factual records and MUST NOT be edited by an LLM.

## 14. Branch isolation — future controlled exploration

Exploration MUST NOT execute in the live primary workspace.

A `BranchSeed` contains snapshot manifest, product/workspace state, Scope Contract, policy-visible state, evidence summary, and runtime fingerprint. It MUST NOT clone conversation IDs, execution IDs, pending correlations, locks, telemetry identity, PIDs, or timestamps.

Each exploratory branch uses a physically isolated directory. Git branches/worktrees are optional implementation techniques, never the causal mechanism. Conversation/execution IDs, role bindings, pending records, timestamps, telemetry, locks, PIDs, and ports are regenerated.

Exploratory branches MUST NOT execute external irreversible effects: remote push/release/publish, remote DB mutation, outbound messaging, cloud-resource mutation, destructive external operations, or credentialed side effects. Such tasks are `EXPLORATION_INELIGIBLE`.

## 15. Exploration Budget — future milestone

Automatic exploration is OFF by default. The first exploration mode is an explicit local/offline command on a sealed world/snapshot.

Initial hard budget:

- at most 1 sibling branch per decision;
- at most 2 model calls in the exploratory branch;
- 5-minute timeout;
- `NORMAL` local/reversible tasks by default;
- `MAJOR` only with explicit human approval;
- `CRITICAL` always excluded;
- no exploration under active Human Gate;
- no external side effects.

Unknown-branch selection initially uses deterministic `LEAST_OBSERVED_LEGAL_ACTION`, stable action-ID tie-break. Policy cannot change budget.

## 16. Stochastic outcomes

The system records observations, never the false equation `state + action = result`.

Support states:

- `OBSERVED_ONCE`
- `OBSERVED_MULTIPLE_CONSISTENT`
- `AMBIGUOUS_OBSERVED`
- `UNKNOWN_BRANCH`

V1 MUST NOT infer success probabilities. Conflicting acceptance outcomes remain ambiguous and block automatic promotion until a separately versioned statistical policy exists or more evidence is collected.

Replay memoizes by `(snapshot_id, policy_state)`. If observations branch into multiple resulting snapshots, replay returns an outcome set. Maximum derived trajectories per evaluation: 10,000. Exceeding it returns `REPLAY_COMPLEXITY_LIMIT`; no silent approximation.

## 17. Outcome model

Outcome is structured fact, not a scalar score.

A trajectory is ineligible if any of the following occurs: governance violation, scope violation, orchestrator/reviewer product write, unattributed mutation, Evidence Ledger integrity failure, stale evidence used for acceptance, failed tool interpreted as success, Two-Key bypass, unresolved Human Gate treated as success, prohibited external branch side effect, illegal policy action, or invalid schema/provenance.

Terminal states:

- `ACCEPTED`
- `RETRY_REQUIRED`
- `HUMAN_GATE`
- `BLOCKED`
- `FAILED`
- `UNKNOWN`
- `ABORTED`

Evidence completeness records `required[]`, `observed{}`, and `complete`; `NOT_REQUIRED` is distinct from `MISSING`/`UNKNOWN`.

Cost fields include model calls, role-specific turns, tool calls, input/cached input/output/reasoning tokens when available, latency, retries, and useful-work ratio. AGY `uncached_input_tokens` remains `null/NOT_DERIVABLE`; cache counters MUST NOT be subtracted incorrectly.

## 18. Evaluator

No single weighted score is allowed. Ordering is immutable and lexicographic:

1. Safety / Fidelity
2. Acceptance
3. Evidence Completeness
4. First-pass Acceptance
5. Retry cost
6. Model calls per accepted task
7. Tokens per accepted task
8. Latency

Lower-priority gains MUST NOT compensate regressions in higher-priority dimensions.

Candidate dominance requires no degradation in any higher-priority common-support dimension, improvement in at least one dimension, and no unacceptable support loss.

`UNKNOWN_BRANCH` is lack of support, not failure. A policy cannot be automatically promoted if any holdout divergence lacks Exact Replay support; status becomes `NEEDS_EXPLORATION`.

After hard/quality gates, an operational improvement is material if at least one holds:

- >=5% reduction in model calls per accepted task; or
- >=10% reduction in retries per accepted task; or
- >=2 percentage-point increase in first-pass acceptance.

Smaller gains may be retained as candidates but do not justify automatic replacement.

## 19. Exact Replay v1

Conceptual API:

```text
replay(world, candidate_policy)
```

At each decision:

1. reconstruct policy-visible state;
2. governance derives legal actions;
3. candidate policy chooses;
4. validate action legality;
5. query observations for exact `snapshot_id + action`;
6. none => `UNKNOWN_BRANCH` and stop that path;
7. otherwise reveal only recorded observations;
8. continue through recorded resulting snapshots.

Statuses:

- `REPLAY_EXACT_SINGLE`
- `REPLAY_EXACT_MULTI_OBSERVATION`
- `EXACT_REPLAY_COMPLETE`
- `EXACT_REPLAY_PARTIAL`
- `UNKNOWN_BRANCH`
- `POLICY_INVALID_ACTION`
- `REPLAY_COMPLEXITY_LIMIT`
- `WORLD_INVALID`

Replay is **prefix-only**: policy sees only facts revealed up to the current decision. It MUST NOT receive unrevealed branch outcomes, future best scores, winning IDs, or other hindsight data.

Replay v1 MUST require zero model calls.

## 20. Generalized Evidence

Generalized cross-task evidence is explicitly out of v1. Any future similarity/inference channel MUST be labeled `INFERRED`, never `EXACT`, and cannot by itself authorize automatic promotion without a new architectural review.

Embeddings or LLM judgments MUST NOT define equality for Exact Replay.

## 21. Future Policy Development

Only after the factual foundation is mature may an offline `flash-policy-designer` propose candidate JSON policies. It MUST have no write access to product code, hooks, agents, governance, schemas, evaluator, or active-policy pointer.

It MUST NOT read raw history. A deterministic `PolicyDevelopmentDataset` may contain state-bucket counts, action support, terminal outcomes, first-pass rates, retry reasons, cost quantiles, ambiguity/unknown coverage, sanitized replay counterexamples, and the current policy. Up to 20 structured examples may be included; no raw user prompt, web/file text, terminal logs, or unsanitized free text.

Per improvement cycle: max 2 designer calls; call 1 produces up to 4 candidates, call 2 optionally produces up to 4 revisions after deterministic replay feedback. Baseline is always included.

## 22. Train / Holdout

Split is deterministic 80/20 by task fingerprint/root lineage hash. All descendants/observations from a lineage stay on one side.

Before any future automatic promotion:

- >=100 supported train lineages;
- >=30 supported holdout lineages;
- zero hard violations;
- complete common support for every holdout divergence.

Below those thresholds the system may report recommendations or shadow candidates, but promotion remains manual. Holdout is frozen for an improvement cycle.

## 23. Shadow Mode — future milestone

Shadow computes candidate action on the same current state but does not execute it or expose it to the model. It records baseline action, candidate action, divergence, replay support, policy latency, and errors.

Before canary, at least 50 eligible shadow decisions are required. If >20% of divergences are `UNKNOWN_BRANCH`, gather support instead of canarying.

Shadow MUST have zero effect on execution, Scope Contract, real worker tier, acceptance, or user output.

## 24. Canary / Promotion — future milestone

Automatic promotion is OFF by default. Canary requires explicit human approval.

Eligibility: `NORMAL`, local/reversible, no external side effects, no security/auth/release/migration critical paths, no Two-Key review.

Initial canary = 5% via deterministic task-ID hashing. Future ramp MAY be 5 -> 20 -> 50 -> 100%, with a new gate at each step.

Immediate rollback triggers:

- any hard safety/fidelity violation;
- policy/schema corruption;
- illegal action;
- required-evidence bypass;
- exact proven regression where baseline accepted and candidate did not for the same snapshot;
- any Dream attempt to modify governance.

Final promotion remains human-approved in the initial architecture. Any future `auto_promote=true` requires separate review and can never apply to `CRITICAL` tasks.

## 25. Policy storage and activation

Policies are content-addressed:

```text
.agents/dream-data/policies/versions/<sha256>.json
```

`active.json` contains only policy hash, schema/runtime compatibility, and promotion metadata. Pointer replacement MUST be atomic where supported (`temp + fsync + rename`).

`static-policy-v1` remains versioned with the runtime. Missing/corrupt/invalid `active.json` => static fallback.

Retain all promoted policies, at least the last 10 activations, and append-only promotion/rollback history. Never-promoted candidates MAY be garbage-collected after 30 days.

## 26. Runtime integration

AGY-only v1 is required because its lifecycle hooks, evidence telemetry, role attribution, and current architecture provide the necessary factual substrate. Codex MUST NOT import AGY Dream code or state.

Online ordering is fixed:

```text
facts/state
 -> governance normalize/classify
 -> buildSnapshot
 -> deriveAvailableActions
 -> compute current baseline action
 -> evaluate active policy overlay when enabled
 -> validate chosen action
 -> record DECISION
 -> existing delegation/execution
 -> existing evidence/acceptance path
 -> record DECISION_OUTCOME
```

Dream MUST never execute before governance.

A future Codex implementation requires an independent adapter and separate review; shared concepts MAY move to `shared/`, but shared runtime state is forbidden.

## 27. Failure semantics

Operational rule:

> Dream failure => static routing + no learning. Governance failure => existing fail-closed behavior.

| Failure | Required behavior |
|---|---|
| snapshot cannot be calculated | static route; mark data invalid |
| telemetry write fails | task continues; world cannot seal |
| active policy corrupt | static policy + diagnostic |
| candidate chooses illegal action | candidate invalid; static action |
| replay corrupt | exclude world; no promotion |
| exploratory branch fails | primary unaffected |
| policy designer fails | active policy unchanged |
| unknown schema | reject artifact; no implicit migration |
| exploration budget exceeded | cancel exploratory branch |
| model/provider unavailable | normal Orchestra rules; no forbidden provider fallback |

## 28. Storage and retention

Raw `events.jsonl` remains operational telemetry. Future rotation MAY occur at 256 MB or 30 days with up to 10 local segments; rotation is not required for the first foundation change.

Sealed worlds persist until explicit GC because they are the replay dataset. Indexes, aggregates, and replay reports are disposable/rebuildable.

When physical branch seeds exist: default TTL 7 days, default quota 10 GB/project, manifests/hashes may outlive removed payloads.

## 29. Security / Trust Model

### 29.1 History poisoning

Raw task/tool text MUST NOT be supplied to future policy-design LLMs. Only deterministic sanitized structured datasets are allowed.

### 29.2 Authority escalation

Policy designer cannot write hooks, agents, routing governance, schemas, evaluator, active pointer, or product workspace. It can only emit candidate policy JSON.

### 29.3 Evaluation and budget hacking

Candidate policies cannot define metrics, weights, thresholds, action-space rules, or exploration budgets.

### 29.4 Secret hygiene

Environment values are stored only as hashes when allowlisted. Credentials MUST NOT enter worlds. Dream data remains local and ignored by Git. Portable artifacts MUST remove/normalize absolute local paths.

### 29.5 Tamper detection

Per-event hashes + sealed world manifests provide audit/integrity detection, not a claim of security against an attacker with total filesystem write access.

## 30. Testing requirements

### 30.1 Canonicalization / snapshots

Must test: deterministic hash, object-key independence, set-like order independence, ordered-array sensitivity, path normalization, file-content sensitivity, executable-bit sensitivity, excluded-directory independence, external-symlink fail-closed.

### 30.2 Policy / action space

Must test: no illegal action, equal-priority conflict invalidation, no-match baseline fallback, rule/size limits, no learned route for CRITICAL, Direct Action bypasses learned policy.

### 30.3 Static parity

Exhaustive supported `decideRoute` fixtures MUST prove `static-policy-v1` produces identical worker tier/retry/investigate decisions. Any mismatch blocks activation.

### 30.4 Decision / outcome

Must test: decision-before-action, pre-side-effect snapshot, decision/outcome correlation, hook idempotency, incomplete decision => world ineligible.

### 30.5 Discovery / replay

Must test: exact-snapshot-only, unknown branch handling, no unrevealed outcome, multiple observation preservation, partial trajectory cannot promote, out-of-support candidate blocked, prefix-only behavior, zero model calls.

### 30.6 Governance escape tests

Candidate attempts to choose forbidden provider/model, extend retries, bypass review, alter action space, write as orchestrator, change evaluator, read raw history, or control budget MUST fail deterministically.

### 30.7 Cross-runtime

Existing firewall MUST continue proving zero AGY Dream imports/routes inside Codex.

## 31. Phase gates

### Phase 1 — Decision History / Record-only

Required:

- 100% routing parity;
- zero new model turns;
- zero worker/reviewer-selection change;
- factual Decision + Outcome records for supported cases;
- deterministic snapshots;
- Dream telemetry failure does not fail primary task;
- all offline suites PASS;
- live regression only when active hooks/routing behavior is modified;
- decision-recording CPU target <5 ms excluding workspace hashing;
- workspace hashing target <1 s in common workspaces using metadata cache; if exceeded, Dream recording fails open to static routing for that decision without blocking task.

### Phase 2 — Exact Replay

Required:

- zero model calls;
- unknown action => `UNKNOWN_BRANCH`;
- prefix-only proof tests;
- invalid world excluded;
- baseline replay reproduces historical path;
- replay-derived metrics match factual records.

### Phase 3 — Controlled Exploration

Requires explicit opt-in, isolated branch, unchanged primary workspace hash, zero external side effects, enforced budget, regenerated ephemeral IDs, max one sibling.

### Phase 4 — Policy Development

Requires schema-valid JSON-only candidates, no raw history in LLM, fixed train/holdout, baseline in candidate set, no auto-promotion.

### Phase 5 — Shadow / Canary

Requires zero-impact shadow, >=50 eligible decisions, human-approved canary, rollback hard gates, CRITICAL exclusion.

## 32. Required implementation sequence

1. **Milestone A — Foundation Schema:** canonical serializer, schemas, snapshot, action-space representation, event records. No active policy.
2. **Milestone B — Record-only Integration:** instrument the three decision points while current router remains authoritative.
3. **Milestone C — World Sealing + Exact Replay:** seal valid worlds, replay static choices, generate deterministic reports.
4. **Milestone D — Declarative Static Policy:** implement `static-policy-v1`, prove parity, only then allow interpreter overlay.
5. **Milestone E — Explicit Exploration Lab:** optional local CLI for one isolated sibling.
6. **Milestone F — Policy Lab:** aggregate dataset, train/holdout, policy designer, candidate evaluation; no automatic deploy.
7. **Milestone G — Shadow.**
8. **Milestone H — Human-approved Canary.**

No release is required to complete all milestones at once. Each milestone MUST satisfy previous gates before the next acquires execution authority.

## 33. Phase-1 implementation scope

The first implementation plan MUST include only Milestones A-C unless a later explicit approval expands scope.

It therefore includes:

- canonical serializer;
- versioned snapshot/decision/outcome/world schemas;
- snapshot builder and fingerprints;
- governance-derived action-space serialization;
- `DECISION` and `DECISION_OUTCOME` event recording;
- sealed-world validation/manifests;
- discovery-tree derivation;
- Exact Replay simulator;
- deterministic evaluator sufficient to report factual trajectory properties;
- `.agents/dream-data/` ignore/install hygiene;
- deterministic tests and required regression verification.

It excludes:

- automatic branch exploration;
- paid sibling execution;
- LLM policy designer;
- generalized/inferred evidence;
- shadow;
- canary;
- active learned policy deployment;
- automatic promotion.

## 34. Definition of done for the foundation

Foundation is complete only when all of the following are demonstrated:

1. Existing static Orchestra behavior is unchanged for supported baseline fixtures and required live regression.
2. A decision can be reconstructed with factual state, legal action set, chosen action, policy source, and exact pre-action snapshot.
3. Outcomes are correlated to factual Evidence Ledger provenance.
4. Invalid/incomplete worlds cannot enter replay.
5. Exact Replay never invents an outcome and halts with `UNKNOWN_BRANCH` outside support.
6. Replay uses zero model calls.
7. Raw Discovery History is not injected into online LLM context.
8. Dream failures deterministically return to static routing.
9. Cross-runtime firewall remains clean.
10. The repository contains enough tests and documentation to explain exactly why a replayed trajectory is factual.

## 35. Known residual risks

- Provider backend drift may occur under unchanged model IDs; replay describes historical recorded outcomes, not guaranteed present-day reproducibility.
- External services/clocks/network state may escape workspace fingerprinting; such tasks are ineligible for controlled exploration/promotion unless external state is explicitly fingerprinted.
- Counterfactual support will initially be sparse; frequent `UNKNOWN_BRANCH` is expected and preferable to fabricated inference.
- Current policy creates selection bias in observed branches; later controlled exploration reduces but does not remove it.
- Stochastic agents make single observations weak evidence; ambiguity is preserved rather than hidden.
- Sealed histories may grow significantly; quotas/GC are required before large-scale exploration.
- Dream is a failure if its meta-compute costs more than it saves; record/replay should remain mostly deterministic and offline.

## 36. System-level success criteria

The complete Dream architecture is successful only if real use demonstrates:

- same Safety/Fidelity as static Orchestra;
- equal or better eventual acceptance;
- equal or better evidence completeness;
- improved first-pass acceptance and/or lower operational cost;
- fewer calls/retries/tokens per accepted task where quality is unchanged;
- no need to place raw Discovery History in online context;
- reliable immediate rollback to `static-policy-v1`;
- an audit trail explaining the factual state, legal actions, selected policy action, observed outcomes, and evidence supporting any promotion.

Until those criteria are demonstrated, Dream remains an experimental subsystem under Orchestra governance, never a new governance authority.

## 37. References

- Zheng, T. et al. **Dream-RSI: Recursive Self-Improvement through Evolving Worlds.** arXiv:2609.14858, 2026. https://arxiv.org/html/2609.14858
- Dream-RSI repository: https://github.com/zhengkid/Dream-RSI
- Dream-RSI PDF: https://github.com/zhengkid/Dream-RSI/blob/main/papers/Dream-RSI.pdf
- Orchestra baseline commit: https://github.com/jssantogit/Orchestra/tree/0e1dc980bf0d7eed8bf986c8e3e3f574520497eb
- Relevant Orchestra documents: `README.md`, `docs/architecture.md`, `docs/routing.md`, `docs/reliability.md`, `docs/efficiency.md`, `docs/isolation.md`, `shared/principles.md`, `runtimes/antigravity/README.md`, `runtimes/antigravity/.agents/skills/orchestra/routing-policy.mjs`, `runtimes/antigravity/.agents/hooks.json`, `scripts/install-antigravity.mjs`, `runtimes/codex/README.md`.

## 38. Spec self-review

- No unresolved architecture placeholder is required for the Foundation scope.
- Dream v1 authority is bounded to factual recording/replay; later execution authority is milestone-gated.
- Policy cannot expand governance or change its evaluator.
- Exact Replay cannot infer unknown branches.
- Raw history is excluded from online context and future policy-design prompts.
- First integration is record-only and preserves validated routing authority.
- Any Dream-layer uncertainty defaults to no-learning/static-route rather than heuristic behavior.
