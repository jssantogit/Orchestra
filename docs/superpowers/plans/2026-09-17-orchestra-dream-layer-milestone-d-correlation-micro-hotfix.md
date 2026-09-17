# Orchestra Dream Layer Milestone D Correlation & Invariant Gate Micro-Hotfix Plan

> **For agentic workers:** Execute task-by-task according to strict execution invariants:
> 1. Reproduce; 2. Trace causal flow; 3. Identify root cause; 4. Write RED test; 5. Confirm RED for expected reason; 6. Make minimal correction; 7. Confirm GREEN; 8. Run regressions; 9. Commit.

**Goal:** Execute the Milestone D Correlation & Invariant Gate Micro-Hotfix:
1. **Hard Identity for Investigation Completion**:
   - The previous matcher allowed missing identity fields to implicitly match.
   - Investigation completion now matches ONLY IF:
     A. At least one verifiable HARD IDENTITY is present on BOTH sides (`toolCallId`, `executionId`, `childConversationId` / `subagentId`);
     B. Hard identity is exactly equal;
     C. Any additional identity dimensions on both sides do not conflict.
   - Missing hard identity -> NO MATCH.
   - Ambiguous identity -> NO MATCH.
   - Same parent conversation only -> NO MATCH.
   - Same role only -> NO MATCH.
   - Same profile only -> NO MATCH.
   - In `invoke_subagent`: requires shared causal identity (`toolCallId` / `executionId`).
   - In `manage_subagents`: requires exact child identity (`childConversationId` / `subagentId` / `executionId`). Role/profile alone NEVER matches.
   - Preserves failure/cancelled semantics: SUCCESS sets `post_investigation = true` & clears `investigationInFlight`; FAILED/CANCELLED clears `inFlight` but preserves `post_investigation = false`; no match leaves `inFlight` intact.
   - Zero new `DECISION` records created on completion.
2. **Normative Counterexamples & Hard Identity Tests (H through M)**:
   - TEST H: conv-A + call-A stored vs conv-A + missing toolCallId -> NO MATCH.
   - TEST I: conv-A + call-A + corr-A stored vs conv-A + call-A + missing corr-A -> MATCH on toolCallId (documented causal identity).
   - TEST J: conv-A + call-A stored vs conv-A without toolCallId/executionId/childConversationId -> NO MATCH.
   - TEST K: parent=A, child=investigator-A, role=investigator, profile=flash-worker stored vs parent=A, child=investigator-B, role=investigator, profile=flash-worker in manage_subagents -> NO MATCH.
   - TEST L: parent=A, child=investigator-A stored vs exact child=investigator-A -> MATCH.
   - TEST M: two investigators sharing role/profile/parent, completion contains only role/profile/parent -> NO MATCH (no FIFO/guesswork).
3. **Architecture Invariant Gate Hardening (ARCH-001 through ARCH-018)**:
   - ARCH-013 hardened to prove all conditions above.
   - ARCH-015: RETRY_SAME Exact Worker Identity (Medium->Medium allowed; Medium->Low, Medium->High, Low->Medium, High->Medium denied).
   - ARCH-016: Active Self-Host Image Isolation (test loads active policy A, candidate source modification B cannot hot-reload active session; test using temporary fixture projection without touching `.git/orchestra-self-host/**`).
   - ARCH-017: Policy Contract Truthfulness (Structural representable vs Semantic-only constraints; schema vs validatePolicy).
   - ARCH-018: Exact Replay Remains Model-Free (demonstrate local deterministic callback, zero model/provider invocation path, UNKNOWN_BRANCH epistemic stop).
   - Total factual count: exactly 18 architecture invariants.

---

## Status & Execution Checklist

- [x] Baseline HEAD verified clean at `9bb87f5b2df90c5a7f8e8f73784d96fa1ca8a88f`.
- [x] RED Tests (H through M) added to `runtimes/antigravity/tests/hooks.test.mjs`; RED failure observed (`red_gate_observed = true`, exit code 1).
- [x] Production fix applied to `runtimes/antigravity/.agents/hooks/pre-tool-enforce.mjs` and `post-tool-telemetry.mjs`.
- [x] Tests H through M confirmed GREEN.
- [x] ARCH-013 hardened and ARCH-015 through ARCH-018 added to `tests/architecture-invariants/dream-authority.test.mjs` (all 18 invariants pass).
- [x] Full test suite verification:
  - `npm run test:dream`: 69/69 passed (100% coverage, 100% parity across 280/280 cases)
  - `npm run test:antigravity`: 52/52 passed
  - `npm run test:hooks`: 85/85 passed
  - `npm run test:firewall`: 9/9 passed
  - `npm run test:turn-economy`: 99/99 passed (85 diet + 14 consensus)
  - `npm run test:installers`: 4/4 passed
  - `npm run test:architecture-invariants`: 18/18 passed
  - `npm run check:contamination`: passed (zero contamination)
  - `npm run doctor`: passed (healthy)
  - `npm test`: passed
  - `git diff --check`: clean (exit code 0)
- [x] Documentation updated in `docs/dream-layer.md`.
- [x] 3 atomic commits planned.
