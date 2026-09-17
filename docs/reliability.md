# Reliability & Truthfulness

Autonomous agents are prone to hallucinating command outcomes, declaring success when tests fail, or entering cyclic retry loops. Orchestra introduces deterministic reliability invariants to ensure trustworthy execution.

---

## 1. Tool Truthfulness: "FAILED TOOL IS NOT EVIDENCE"

- **Nonzero Exit Means Failure**: An exit code other than `0` (including exit code `182` from sandboxes or tool interruptions) is failure.
- **Empty Output Is Not Success**: If a command fails with empty stdout/stderr, it cannot be interpreted as `NO_CHANGES`, `CLEAN`, or `PASS`. It must be treated as `UNKNOWN` or `BLOCKED`.
- **Atomic Operations**: Git operations verify status after execution. A failed push preserves the local commit while reporting `pushSucceeded: false`.

---

## 2. Evidence Ledger & Evidence Freshness

- The **Evidence Ledger** is an append-only record of verified tool executions.
- Manual editing of state files by the model is disallowed; execution facts are captured directly by runtime hooks.
- **Freshness**: Each code modification increments `mutationSeq`. If code is modified after a test passes, the test evidence is marked **STALE** and must be re-run before task acceptance.

---

## 3. Bounded Delta Retries

- Retries are strictly capped (2 attempts for standard implementation, 3 for experimental investigation).
- Blind retries (re-submitting the exact same prompt) are forbidden.
- Each retry packet must identify:
  - Exact failing assertion;
  - Root cause;
  - Targeted fix;
  - Preserved work;
  - Remaining retry budget.
- Exhaustion of the retry budget immediately halts to a `HUMAN_GATE`.

---

## 4. Circuit Breakers

The runtime detects and halts on failure patterns:
- **Loop Circuit Breaker**: Repeated file reads without modifying state or advancing the task.
- **Stall Circuit Breaker**: Repeated identical tool executions or retry reasons without progress.
- **Coordination Overhead**: Excessive subagent turns without settling decisions.

---

## 5. Dream Layer Foundation Reliability & Epistemics

The Orchestra Dream Layer Foundation (Milestones A–C) enforces mathematical and operational guarantees for offline recursive policy evaluation:

- **Fail-Open Telemetry Semantics**: Decision and outcome instrumentation hooks operate with fail-open semantics. If telemetry serialization, filesystem writes, or pending correlation tracking fail (e.g., full disk, permissions, or transient I/O faults), the error is recorded in ephemeral diagnostics and execution falls back safely to static routing. Telemetry write failures **never block, stall, or fail primary user tasks**.
- **Tamper-Evident World Sealing**: Execution trajectories are sealed into immutable, content-addressed world records verified against SHA-256 canonical manifests. Worlds containing unverified mutations, absent Evidence Ledger executions, tampered event hashes, or unresolved actor identities fail closed (`WORLD_INVALID` or `WORLD_INCOMPLETE`) and are permanently excluded from replay eligibility.
- **Zero Model Calls in Replay**: Replay simulation executes deterministically over historical discovery trees with **zero foundation model calls, zero subprocesses, and zero network requests**. Exact replay matches observed execution steps strictly by snapshot hash identity. If a candidate policy selects an untaken counterfactual branch, replay halts deterministically at `UNKNOWN_BRANCH` without hallucinating or synthesizing unobserved outcomes.
- **Lexicographic Non-Compensatory Evaluation**: Trajectory evaluation follows an immutable 8-tier lexicographic ordering (`SAFETY_VIOLATIONS` → `CONTRACT_INTEGRITY` → `GOVERNANCE_INVARIANTS` → `EVENTUAL_ACCEPTANCE` → `FIRST_PASS_ACCEPTANCE` → `TURN_ECONOMY` → `TOKEN_ECONOMY` → `LATENCY`). Safety, contract adherence, and factual acceptance strictly dominate token or latency optimizations; composite scoring functions and compensatory trade-offs (e.g., sacrificing safety to save turns) are mathematically impossible.
