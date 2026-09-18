# Orchestra Architecture

Orchestra is a local multi-agent orchestration framework designed for coding agents. It structures complex software development workflows through deterministic routing, strict separation of duties, progressive verification, and runtime isolation.

---

## 1. The Dual-Runtime Model

Modern software development often leverages different foundation model ecosystems. Orchestra supports two distinct, production-tested runtime implementations that share fundamental principles while keeping their control planes and model integrations completely separate:

```text
                               ┌────────────────────────────────┐
                               │       Shared Principles        │
                               │  - Separation of Duties        │
                               │  - Scope Contracts             │
                               │  - Evidence-Driven Acceptance  │
                               │  - Tool Truthfulness           │
                               │  - Progressive Verification    │
                               │  - Context Diet & Efficiency   │
                               └───────────────┬────────────────┘
                                               │
                       ┌───────────────────────┴───────────────────────┐
                       │                                               │
                       ▼                                               ▼
         ┌───────────────────────────┐                   ┌───────────────────────────┐
         │       CODEX RUNTIME       │                   │    ANTIGRAVITY RUNTIME    │
         │   (OpenAI Ecosystem)      │                   │    (Gemini Ecosystem)     │
         ├───────────────────────────┤                   ├───────────────────────────┤
         │ • Terra Medium Control    │                   │ • Flash Medium Control    │
         │ • Luna High/Max Workers   │                   │ • Flash Low/Med/High Work │
         │ • Luna Medium Support     │                   │ • Flash High Specialists  │
         │ • Terra High/Max Invest   │                   │ • Two-Key Flash Reviewers │
         │ • Sol Low/Medium Review   │                   │ • Engine Tool Hooks       │
         │ • Astra Manual Only       │                   │ • Automatic Ledger & Gate │
         │                           │                   │ • Dream Layer Foundation  │
         │                           │                   │   (Record-Only & Replay)  │
         └───────────────────────────┘                   └───────────────────────────┘
```

---

## 2. Separation of Duties

Orchestra enforces strict boundaries between the agent planning the work and the agent executing the work:

1. **Control Plane (Orchestrator)**:
   - Owns intent deconstruction, classification, scope contract authoring, and state management.
   - Evaluates verification evidence and makes acceptance, retry, or escalation decisions.
   - **Invariant**: The orchestrator never writes product code directly.

2. **Execution Plane (Worker)**:
   - Operates inside an explicit **Scope Contract** specifying `allowedPaths` and `forbiddenPaths`.
   - Never coordinates or spawns other workers.
   - Cannot accept its own work: completion is an evidence claim (`IMPLEMENTATION_COMPLETE`), never `TASK_ACCEPTED`.

3. **Specialist & Review Plane**:
   - High-risk or complex uncertainties route to dedicated investigation or review profiles (Sol in Codex; Two-Key review in Antigravity).
   - Reviewers operate strictly read-only and return findings to the Orchestrator.

---

## 3. The State Machine

Execution advances through a formal, deterministic state machine:

```text
INTAKE ──> CLASSIFIED ──> PLANNED ──> DELEGATED ──> EXECUTING ──> EVIDENCE_READY ──> ACCEPTANCE ──> DONE
  │            │                                  │             │
  │            │                                  ├──> CI_WAIT ─┘
  │            │                                  │      ├── success -> EVIDENCE_READY
  │            │                                  │      ├── failure -> Delta Retry / BLOCKED
  │            │                                  │      └── source unavailable -> bounded fail-closed recovery
  │            │                                  ├──> PARTIAL_RESULT (Retry)
  │            │                                  └──> STALLED ──> HUMAN_GATE
  │            ▼
  └──> DIRECT_ACTION ──> EXECUTING ──> DONE / BLOCKED
```

- Any unrecognized state transition fails closed.
- If automated attempts exhaust their retry budget or reviewers disagree, execution halts safely to a `HUMAN_GATE`.

---

## 4. Operational Guardrails

- **Scope Enforcement**: File writes outside `allowedPaths` are blocked immediately.
- **Side-Quest Prevention**: Direct operational tasks (git status, commit, test runs) follow a lightweight fast path with zero subagents and strict bounds against unsolicited refactoring.
- **Evidence Freshness**: Subsequent code mutations invalidate previous test results, ensuring that acceptance is based only on fresh verification facts.
- **Typed Evidence Contracts**: Scope Contracts may declare `requiredEvidence` independently of `testsRequired`. Acceptance consumes typed factual proofs rather than assuming every task must execute a local test.
- **Provider-Verified Remote CI**: Remote CI evidence is validated through the Evidence Provider Registry. GitHub Actions is the first built-in provider and is bound to the factual origin repository, workflow, current HEAD/ref, required jobs, retry attempt, and mutation state. Model text or arbitrary URLs never satisfy the gate.
- **Persistent Evidence Watch**: Pending remote evidence creates a task/attempt/mutation-bound watch with exponential backoff and deadline. `CI_WAIT` stops the model turn instead of polling through model invocations. A detached runtime runner may poll in the background; it can only move the task to `EVIDENCE_READY`, never accept, retry, or finish it.
- **Provider Separation**: Contract validation consults the provider registry, collection dispatch consults the same registry, and Stop Guard consumes only normalized evidence results. Adding a provider does not grant it acceptance authority.
- **Runtime Mechanical Facts**: Deterministic facts such as `FILE_EXISTS`, `GIT_IGNORED`, `GIT_CLEAN`, and `EXPECTED_FILE_MODIFIED` can be collected directly by the runtime instead of forcing shell-command ceremony on a worker.
- **Mechanical Fast Path**: A `MECHANICAL_FIX` may use the short lifecycle only when it is `NORMAL`, first-attempt, bounded to at most four concrete nonsensitive files, routed to `flash-low-worker`, and accepted exclusively by structured runtime-owned `LOCAL_FACT` evidence with at least one outcome fact. The normal Evidence Ledger and Stop Guard remain authoritative; the fast path grants no acceptance authority.
- **Mechanical Side-Quest Lock**: While the fast path is active, extra subagents/review, search, undeclared shell commands, out-of-scope reads, and mutation-budget expansion are denied. Any failed, stale, unavailable, or invalid evidence exits the short path into normal fail-closed recovery.
- **Child Evidence Lock**: A factual WORK/VALIDATION child cannot terminate while it still owes an actionable local command from its Scope Contract. Runtime-owned facts and remote CI remain parent/runtime responsibilities.
- **Cross-Agent Evidence Federation**: Local evidence produced by a delegated child is provisional until the runtime proves that child's exact identity. Once factual, Orchestra federates the record into the parent task ledger while binding producer, task, retry attempt, mutation sequence, parent identity, and candidate commit. Evidence from another task/attempt/commit remains stale and cannot satisfy acceptance.

---

## 5. Dream Layer Foundation (Offline Recursive Policy Improvement)

Orchestra incorporates an offline, deterministic recursive policy evaluation subsystem grounded in Dream-RSI:

- **Record-Only Operational Boundary**: During online execution, static routing remains fully authoritative. Lifecycle hooks record decisions, available legal action sets, compact decision states, and pre-action workspace snapshots (`.agents/dream/decision-recorder.mjs`). Subsequent Evidence Ledger outcomes are correlated to decisions (`.agents/dream/outcome-recorder.mjs`) with zero new model turns.
- **Fail-Closed World Sealing**: Offline tools validate provenance, verify canonical manifest hashes, and seal immutable execution worlds (`.agents/dream/world-sealer.mjs`). Worlds lacking verified evidence or containing unresolved actors fail closed and are excluded from replay.
- **Model-Free Exact Replay**: Replay simulates alternative policies over historical discovery trees with zero foundation model calls (`.agents/dream/replay-simulator.mjs`). Any unobserved counterfactual path terminates in `UNKNOWN_BRANCH` without hallucinated outcomes.
- **8-Tier Lexicographic Evaluator**: Trajectories are ranked strictly by Safety/Fidelity, Acceptance, Evidence Completeness, First-Pass Acceptance, Retry Cost, Model Calls, Tokens, and Latency (`.agents/dream/evaluator.mjs`) without composite scoring heuristics.
- **Explicit Isolated Exploration (Milestone E)**: Unknown factual branches may be explored only through an explicitly armed, physically isolated sibling with hard one-sibling / two-model-call / five-minute budgets and no external irreversible effects.
- **Offline Policy Lab (Milestone F)**: Valid sealed worlds are reduced to a content-addressed sanitized `PolicyDevelopmentDataset`; root lineages are frozen into deterministic 80/20 TRAIN/HOLDOUT partitions. A tool-less `flash-policy-designer` may propose JSON candidate policies under a two-call/four-candidates-per-call budget. Candidates are validated and evaluated by Exact Replay and the deterministic evaluator only.
- **Zero-Impact Shadow Mode (Milestone G)**: A locally selected, previously evaluated F candidate may compute a private counterfactual action after each factual DECISION is durably published. Shadow observations are isolated under `.agents/dream-data/shadow/`; the factual action remains authoritative and candidate output is not exposed to the model, Scope Contract, execution state, or telemetry stream.
- **Shadow-to-Canary Gate**: CRITICAL/HUMAN_GATE decisions are excluded before candidate evaluation. Canary review requires at least 50 eligible Shadow decisions, zero Shadow evaluation errors, and no more than 20% `UNKNOWN_BRANCH` among divergences. Passing the gate only yields `READY_FOR_HUMAN_CANARY_REVIEW`.
- **Human-approved 5% Canary (Milestone H)**: Explicit approval activates exactly 5% deterministic task-ID rollout. The current baseline policy is evaluated first; candidate routing can overlay only eligible NORMAL/local/reversible tasks. Two-Key, critical-path and external-side-effect work is excluded. Hard violations or exact proven regressions remove Canary authority immediately.
- **Atomic Human Promotion**: Canary completion yields only a promotion-review artifact. A second explicit approval stores the candidate in content-addressed policy versions and atomically updates a minimal active pointer using fsync+rename. Invalid/missing active state fails back to static routing. Automatic ramp and auto-promotion are absent.
- **Recursive Baseline Continuity**: The Policy Lab and online router resolve the same active-policy store, so the next RSI cycle starts from the last human-promoted policy rather than silently resetting to the original static policy.
- **Zero Context Pollution**: Raw discovery histories, prompts, terminal logs, file/web contents, replay artifacts, private Shadow actions, Canary approval state, and policy-store internals are never injected into normal model context; the policy designer receives only a sanitized aggregate packet.
