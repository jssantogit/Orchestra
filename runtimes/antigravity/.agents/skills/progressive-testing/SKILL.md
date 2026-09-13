---
name: progressive-testing
description: >-
  Use this skill to determine progressive testing stages (Stage 1 to 4), execute verification loops, and compact test outputs.
---

# Progressive Testing & Output Compaction

## The 4 Testing Stages

1. **Stage 1 — Directly Affected Tests**:
   - Tests directly exercising the modified module or function.
   - Run during worker implementation iterations.
2. **Stage 2 — Package / Domain Test Suite**:
   - Package-level verification (e.g., `pnpm --filter @autoeq-workbench/core test`).
   - Run before declaring `IMPLEMENTATION_COMPLETE`.
3. **Stage 3 — Integration Tests**:
   - Cross-package boundary checks (e.g., core + web integration).
   - Run when multiple packages or domains interact.
4. **Stage 4 — Full Repository Test Suite**:
   - `pnpm test`, typecheck, build, and lint across the entire repo.
   - Run ONLY for `MAJOR` or `CRITICAL` tasks, wide multi-module integration, or explicit release requests.
   - Strictly forbidden as a ritual for small, isolated tasks.

## Test Output Compaction & Concise Reporters

- **Concise Reporters**:
  - Always run vitest with `--reporter=dot` or `--reporter=minimal` (e.g. `pnpm --filter @autoeq-workbench/core test -- --reporter=dot`).
  - Always run node test runner with `--test-reporter=dot` where supported.
- **Passing Runs**:
  - Report ONLY: `X passed / 0 failed` along with test command and duration if available.
  - Never pipe raw passing logs or stack traces into context.
- **Failing Runs**:
  - Extract only:
    - Failing test name
    - Direct error message / assertion failure
    - Relevant stack trace (max 3-5 lines)

## Verification Batch Runner (`verify-batch.mjs`)

Instead of invoking multiple sequential shell commands (causing intermediate tool turns and wakeups), batch required checks in one shot:

```bash
node .agents/hooks/verify-batch.mjs --steps '[
  {"id": "typecheck", "command": "pnpm --filter @autoeq-workbench/core run typecheck", "scope": "@autoeq-workbench/core"},
  {"id": "tests", "command": "pnpm --filter @autoeq-workbench/core test -- --reporter=dot", "scope": "@autoeq-workbench/core", "dependsOn": "typecheck"}
]'
```

- Each step automatically records separate runtime evidence in the Evidence Ledger.
- If a dependency fails, subsequent dependent steps are cleanly skipped without wasted computation.
- Steps with fresh, unmutated evidence already in the ledger are automatically reused.
