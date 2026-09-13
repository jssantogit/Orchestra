# Shared Orchestration Principles

Orchestra coordinates coding agents across different execution environments using a set of core principles. These principles are architectural and behavioral invariants shared by all Orchestra runtimes (Codex and Antigravity), even though their underlying model providers and control-plane implementations are completely independent.

---

## 1. Separation of Duties

- **Control Plane vs. Execution Plane**:
  - The orchestrator (control plane) handles intake, classification, scope contract authoring, delegation, evidence validation, acceptance, and retry decisions. The orchestrator never writes product code.
  - The worker (execution plane) executes strictly within the declared scope contract and returns objective evidence.
- **Workers Do Not Coordinate Workers**:
  - Workers do not spawn subagents, delegate tasks, or orchestrate other workers.
- **Workers Do Not Self-Accept**:
  - `IMPLEMENTATION_COMPLETE` is an evidence claim submitted by the worker, never an acceptance decision. Only the control plane (or an independent reviewer) can accept work.
- **Independent Review**:
  - Critical or high-risk changes require independent verification (e.g. Sol in Codex, Two-Key review in Antigravity) that cannot be bypassed by the authoring worker.

---

## 2. Minimum Sufficient Orchestration

- Classify once, inspect only the evidence needed for the current decision, act once, validate sufficiently, and stop.
- Avoid excessive coordination turns, redundant file reads, and unnecessary ceremony when direct action suffices.
- Direct operational tasks (status, diffs, running tests, single-file scripts, clean commits) follow a fast path that avoids spawning subagents.

---

## 3. Tool Truthfulness: "FAILED TOOL IS NOT EVIDENCE"

- Every factual claim derived from a tool execution requires a verified successful exit code (`0`) and expected output semantics.
- A failed command, tool error, timeout, or blocked execution is `UNKNOWN` or `BLOCKED`.
- It must **never** be interpreted as `clean`, `passing`, `exists`, `missing`, or `success`.
- Empty output from a failing command is failure, never `NO_CHANGES` or `ALL_TESTS_PASS`.

---

## 4. References Over Replication (Context Diet)

- Pass file paths, line ranges, symbol names, and artifact paths in handoffs instead of inlining entire files, long terminal logs, or full diffs into model context.
- Keep agent handoffs compact and focused on the delta needed for the current step.
- Truncate large tool outputs before injecting them into model context, preserving full output in disk artifacts.

---

## 5. Bound Scope & Fail-Closed Routing

- Every delegation must be governed by an explicit **Scope Contract** specifying:
  - `allowedPaths`: Glob patterns of files the worker is authorized to inspect or modify.
  - `forbiddenPaths`: Protected files, immutable fixtures, vendor directories, and unrelated packages.
  - `acceptanceCriteria`: Objective conditions that must be satisfied.
  - `requiredValidation`: Specific test or verification commands.
  - `retryBudget`: Maximum number of retries before halting.
- Any attempt to access unauthorized paths or invalid states fails closed and halts execution or requests cross-domain approval.

---

## 6. Bounded Retries & Delta Handoffs

- Retries are strictly bounded (typically 2 attempts for normal work; up to 3 for experimental tasks).
- Blind retries that repeat the same prompt are strictly prohibited.
- Every retry must be a **Delta Retry** that explicitly states:
  1. The specific assertion or criterion that failed;
  2. The objective evidence of failure;
  3. The root cause or targeted correction;
  4. What parts of the implementation remain valid and unchanged;
  5. The remaining retry budget.
- If the budget is exhausted, halt immediately to a `HUMAN_GATE`.

---

## 7. Progressive Verification & Freshness

- Verify incrementally:
  1. Unit / focused test on modified functions or components;
  2. Module / package test suite;
  3. Integration / lint / typecheck across affected boundaries.
- Track mutation freshness:
  - Evidence from earlier runs is valid only if subsequent mutations have not touched dependent source code.
  - Modifying documentation does not invalidate code test evidence; modifying core code invalidates downstream application and integration tests.

---

## 8. No Side Quests (Exact Intent Boundary)

- Agents must stay strictly within the user's requested intent.
- When performing a direct operation (such as commit, test, or status), agents must not execute unsolicited refactoring, whitespace cleaning, dependency upgrades, or unrelated repository restructuring.
- Blockers or out-of-scope issues should be reported clearly rather than resolved via unapproved side quests.

---

## 9. Early Stop

- When the task criteria are verified and evidence is complete, the agent must stop immediately.
- Do not make speculative edits, repetitive checks, or unnecessary follow-up queries once the goal is achieved.
