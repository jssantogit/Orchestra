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
  │            │                                       │                                │
  │            │                                       ├──> PARTIAL_RESULT (Retry)      ├──> RETRY (Delta)
  │            │                                       ├──> CROSS_DOMAIN_REQUEST        ├──> INTEGRATING
  │            │                                       └──> STALLED ──> HUMAN_GATE      ├──> CRITICAL_REVIEW
  │            │                                                                        └──> HUMAN_GATE
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

---

## 5. Dream Layer Foundation (Offline Recursive Policy Improvement)

Orchestra incorporates an offline, deterministic recursive policy evaluation subsystem grounded in Dream-RSI:

- **Record-Only Operational Boundary**: During online execution, static routing remains fully authoritative. Lifecycle hooks record decisions, available legal action sets, compact decision states, and pre-action workspace snapshots (`.agents/dream/decision-recorder.mjs`). Subsequent Evidence Ledger outcomes are correlated to decisions (`.agents/dream/outcome-recorder.mjs`) with zero new model turns.
- **Fail-Closed World Sealing**: Offline tools validate provenance, verify canonical manifest hashes, and seal immutable execution worlds (`.agents/dream/world-sealer.mjs`). Worlds lacking verified evidence or containing unresolved actors fail closed and are excluded from replay.
- **Model-Free Exact Replay**: Replay simulates alternative policies over historical discovery trees with zero foundation model calls (`.agents/dream/replay-simulator.mjs`). Any unobserved counterfactual path terminates in `UNKNOWN_BRANCH` without hallucinated outcomes.
- **8-Tier Lexicographic Evaluator**: Trajectories are ranked strictly by Safety, Contract Integrity, Governance, Acceptance, First-Pass Acceptance, Turns, Tokens, and Latency (`.agents/dream/evaluator.mjs`) without composite scoring heuristics.
- **Zero Context Pollution**: Discovery trees and replay artifacts remain strictly offline and are never placed in online LLM prompt context.
