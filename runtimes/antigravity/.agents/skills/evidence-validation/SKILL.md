---
name: evidence-validation
description: >-
  Use this skill to record and validate structured runtime evidence in the Evidence Ledger, determine acceptance eligibility, and enforce early stopping.
---

# Evidence Validation & Acceptance Eligibility

## Automatic Evidence Ledger (Runtime-Driven)

Acceptance requires empirical runtime evidence, not conversational claims.
In Efficiency Pass v2, the **Evidence Ledger is populated AUTOMATICALLY by the runtime**:
- When `run_command` executes, `output-gate-runner.mjs` and `post-tool-telemetry.mjs` capture the command, exit code, duration, and test counts.
- The entry is classified deterministically (`TYPECHECK`, `TEST_RUN`, `BUILD`, `LINT`, `BENCHMARK`, `SCOPE_CHECK`, or `GENERIC_COMMAND_RESULT`) and stored in `.agents/state/active-state.json`.
- The model **does not need to manually bookkeep or edit `active-state.json`** for runtime evidence.

## Stop Guard Enforcement & Idempotency

The Stop Hook strictly checks the automatic Evidence Ledger:
- If required tests or evidence are missing, it returns a concise, deterministic list: `EVIDENCE_MISSING: - <test>`.
- **Idempotency**: Calling the stop guard multiple times on the same evidence produces the exact same decision without requiring re-runs.
- **Loop Stall Protection**: If the identical missing evidence condition repeats without new runtime state changes, it trips `STOP_GUARD_STALLED` and halts safely to `HUMAN_GATE`.
- **Reactive Wakeup Support**: If background tasks are running (`fullyIdle === false`), the guard allows the agent to stop cleanly so the runtime can sleep until the task completion event wakes it.

## Large Data Policy & Context Protection

- Never dump large logs, raw reports, or giant JSONs (e.g. `campaign-report.json`) directly into the agent context (`cat`, `jq '.'`, `console.log(huge)`).
- Use filtered queries (`jq` with specific selection, `head`/`tail`), local summarizer scripts, or intermediate compact summary files.
- The **Pre-Context Output Gate** intercepts outputs exceeding `TOOL_OUTPUT_LIMITS.maxInlineBytes` (64 KB) or `maxInlineLines` (300 lines), persists raw output to `.agents/artifacts/outputs/`, and returns only a compact `[OUTPUT_TRUNCATED]` packet.

## Acceptance Eligibility Check
A task is `ACCEPTANCE_ELIGIBLE` if and only if:
1. All declared `acceptanceCriteria` are verified;
2. Required runtime evidence entries exist in Evidence Ledger;
3. Required tests executed with `exitCode === 0` and `failed === 0`;
4. No unresolved blockers;
5. No unresolved `CROSS_DOMAIN_REQUEST`;
6. No scope violations (`scopeViolation === false`).

## Early Stop Principle
Once `ACCEPTANCE_ELIGIBLE` is achieved and no blockers remain:
- **STOP IMMEDIATELY**.
- Do not perform refactoring, cosmetic styling, or speculative cleanups ("while I'm here").

## Evidence Freshness & Validation Reuse (Efficiency Pass v3)

- **Fresh vs Stale Evidence**: An evidence entry (`exitCode === 0`) remains reusable (`FRESH`) as long as no subsequent mutations invalidate its scope.
- **Mutation Tracking**: Every file creation or edit records `mutationSeq` and affected paths in `activeState`.
- **Scope-Aware Invalidation**:
  - Edits to `packages/core/**` invalidate core tests and app tests (since apps depend on core).
  - Edits to `apps/web/**` invalidate app tests, leaving core tests fresh.
  - Docs-only edits (`docs/**`, `*.md`) do NOT invalidate code validation evidence.
  - Unknown dependency relations result in conservative invalidation (`STALE`).
- **Validation Reuse**: Before executing a validation command, consult the Evidence Ledger. If matching FRESH evidence exists, reuse it. Do not re-verify without intermediate code mutations.

