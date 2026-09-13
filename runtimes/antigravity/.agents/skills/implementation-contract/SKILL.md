---
name: implementation-contract
description: >-
  Use this skill to author, validate, and enforce compact Scope Contracts, handle Cross-Domain Requests, and manage bounded Delta Retries for Gemini Flash workers.
---

# Implementation Contract & Scope Governance

## Scope Contract Format

Before invoking any Flash worker, author a compact Scope Contract:

```json
{
  "taskAction": "IMPLEMENT",
  "taskDomain": "DSP_CORE",
  "allowedPaths": ["packages/core/src/dsp/**"],
  "forbiddenPaths": ["apps/**", "packages/core/benchmarks/**"],
  "dependencies": ["@autoeq-workbench/core"],
  "currentState": "Filter synthesis lacks high-shelf Q damping",
  "rootCauseDecision": "Biquad coefficient calculation uses inverted formula",
  "implementationPlan": ["Correct biquad transfer formula", "Add unit test"],
  "acceptanceCriteria": ["High-shelf Q damping matches reference response"],
  "testsRequired": ["pnpm --filter @autoeq-workbench/core test"],
  "retryBudget": { "maxAttempts": 2, "attempt": 0, "remainingAttempts": 2 },
  "stopConditions": ["Stop once tests pass"],
  "doNotChange": ["packages/core/src/constants.ts"],
  "criticality": "NORMAL"
}
```

## Cross-Domain Requests

Workers encountering cross-domain dependencies must stop immediately and emit:
```json
{
  "type": "CROSS_DOMAIN_REQUEST",
  "currentDomain": "UI",
  "requiredDomain": "DSP_CORE",
  "reason": "Need exported helper for filter response curve",
  "requestedCapability": "Export computeMagnitudeResponse() from core",
  "evidence": "apps/web/src/Plot.tsx cannot access internal core math",
  "blocking": true
}
```
The Orchestrator evaluates the request, decides whether to create a new subtask, and updates the contract. Workers NEVER expand domain scope autonomously.

## Bounded Delta Retries

When a worker returns an incomplete result or tests fail, the Orchestrator decrements `remainingAttempts` and dispatches a **Delta Retry**:
- `BASE PLAN`: unchanged
- `FAILED / MISSING`: specific gap identified
- `NEW EVIDENCE`: failure logs, test error snippets
- `REQUIRED CORRECTION`: directed instructions
- `PRESERVE`: verified working code
- `REMAINING ACCEPTANCE`: unsatisfied criteria
- `RETRY REASON`: `MISINTERPRETED_REQUIREMENT` | `INCOMPLETE_IMPLEMENTATION` | `FAILED_TEST` | `SCOPE_GAP` | `MISSING_CONTEXT` | `INTEGRATION_FAILURE`

## Worker Tool Discipline (Efficiency Pass v3 & v4)

- Follow: native inspect (`grep_search`, `view_file`) -> native edit (`replace_file_content`, `write_to_file`) -> shell verify (`run_command`).
- Workers must NOT use shell for manual file editing (`sed -i`, inline python rewrite scripts, `cat > file`).
- Shell is strictly reserved for execution (running tests, builds, benchmarks, typechecks) and native-tool fallbacks.

## Context Diet & Handoff Budget (Efficiency Pass v4)

- **Search-to-Window Policy**: Never read entire large files. Targeted windows ($[L-35, L+45]$) around grep matches save up to 85% of input tokens.
- **Worker Packet Budget**: Handoffs from workers to Orchestrator must be strictly bounded under 4,000 characters and 100 lines (target: < 2,500 chars / 60 lines).
- **References over Replication**: Reference artifact paths, symbols, line numbers, and evidence IDs. Never replicate full file contents or giant diff blocks in worker handoffs.
- **Verification Batching**: Use `verify-batch.mjs` to execute sequenced checks in a single tool call and leverage automatic fresh evidence reuse.

