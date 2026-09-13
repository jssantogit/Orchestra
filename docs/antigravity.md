# Antigravity (AGY) Runtime Guide

The Antigravity runtime provides a 100% **ALL-GEMINI** local multi-agent architecture integrated directly with the Antigravity CLI and IDE engine.

---

## 1. Architecture & Model Roles

```text
GEMINI 3.8 FLASH MEDIUM (Global Orchestrator)
  ├─ Intake & classification
  ├─ Investigation → FLASH HIGH (isolated subagent, read-only)
  ├─ Implementation → FLASH LOW | MEDIUM | HIGH
  ├─ Critical review → TWO-KEY REVIEW (Two independent Flash High reviewers)
  └─ Fast path → DIRECT_ACTION (single command, zero subagents)
```

- **Global Orchestrator (`gemini-3.8-flash-medium`)**: Control plane, intent decomposition, scope contracts, state machine transitions, and evidence acceptance.
- **Worker Low (`gemini-3.8-flash-low`)**: Ultra-lightweight worker for documentation, mechanical formatting, and minor fixes.
- **Worker Medium (`gemini-3.8-flash-medium`)**: Primary worker for standard feature implementations and routine bug fixes.
- **Worker High (`gemini-3.8-flash-high`)**: High-complexity implementation worker, algorithm specialist, and deep investigator.
- **Reviewer (`gemini-3.8-flash-high`)**: Independent critical reviewer. In Two-Key reviews, Reviewer A verifies correctness and Reviewer B performs adversarial edge-case analysis.

---

## 2. Tool Lifecycle Hooks (`.agents/hooks/`)

The Antigravity runtime registers lifecycle hooks in `.agents/hooks.json`:

1. **`pre-tool-enforce.mjs` (`PreToolUse`)**:
   - Validates file edits against the active `scopeContract` (`allowedPaths`, `forbiddenPaths`).
   - Blocks workers from invoking subagents.
   - Prevents orchestrators from directly editing product code.
   - Enforces the `Large File Guard` (blocking `cat` or `jq` dumps on files >200 KB).
   - Enforces polling budgets and backoff on `manage_task(Action='status')`.

2. **`post-tool-telemetry.mjs` (`PostToolUse`)**:
   - Captures command exit codes, test counts, and execution duration automatically into the Evidence Ledger.
   - Increments `mutationSeq` on file modifications and records modified paths.
   - Tracks tool mix, shell overuse, and exploration overhead.

3. **`pre-invocation-guard.mjs` (`PreInvocation`)**:
   - Injects pending advisory notices (e.g. `NATIVE_TOOLS_FIRST`).
   - Activates circuit breakers upon detecting loops, stalls, or excessive coordination overhead.

4. **`stop-guard.mjs` (`Stop`)**:
   - Prevents the agent from declaring a task complete unless required verification evidence is fresh and recorded in the Evidence Ledger.

5. **`output-gate-runner.mjs`**:
   - Intercepts large command outputs (>64 KB or >300 lines), saves full logs to `.agents/artifacts/outputs/`, and returns a compact truncated preview packet to the model context.

6. **`verify-batch.mjs`**:
   - Sequenced verification runner that short-circuits on prerequisite failures.

7. **`git-operation.mjs`**:
   - Safe, atomic git transactions (`status`, `diff_summary`, `commit`, `push`, `commit_push`) with sensitive file protection.

---

## 3. Evidence Freshness Invariant

Every validation evidence record carries the `mutationSeq` at the time of execution.
- If subsequent code mutations occur, earlier test evidence is marked **STALE**.
- Scope-aware invalidation ensures that modifying documentation preserves code test freshness, while modifying core logic invalidates dependent integration tests.

---

## 4. Verification & Tests

Run the Antigravity test suites:

```bash
# Policy unit tests
node --test runtimes/antigravity/tests/routing-policy.test.mjs

# Lifecycle hook tests (always run with concurrency 1)
node --test --test-concurrency=1 runtimes/antigravity/tests/hooks.test.mjs
```
