---
name: critical-review
description: >-
  Use this skill to conduct independent Two-Key critical reviews for CRITICAL tasks using two independent Gemini 3.8 Flash High reviewers with zero cross-talk and mandatory consensus.
---

# Two-Key Critical Review Protocol

## Two-Key Architecture for `CRITICAL` Changes

When `criticality == "CRITICAL"` (e.g. core DSP math, optimizer convergence, raw data integrity, critical releases), acceptance requires **Two Independent Flash High Reviews**:

```text
                 +-------------------------------+
                 | FLASH MEDIUM ORCHESTRATOR     |
                 | Dispatches Factual Packet     |
                 +---------------+---------------+
                                 |
                 +---------------+---------------+
                 |                               |
                 v                               v
       FLASH HIGH REVIEWER A           FLASH HIGH REVIEWER B
       (Correctness Review)            (Adversarial Review)
                 |                               |
                 +---------------+---------------+
                                 |
                          Both ACCEPT?
                         /            \
                       YES             NO (Any disagreement)
                        |               |
                      DONE          HUMAN_GATE
```

### Reviewer A: Correctness Review
- Focus: Mathematical correctness, adherence to acceptance criteria, regression risks, edge case handling.

### Reviewer B: Adversarial Review
- Focus: Hidden coupling, broken assumptions, architectural invariant violations, boundary failure modes.

## Isolation Rules
1. **Clean Context**: Neither reviewer sees the implementer's conversational transcript or discarded hypotheses.
2. **Zero Cross-Talk**: Neither reviewer sees the other reviewer's evaluation or verdict.
3. **Strictly Read-Only**: Neither reviewer can modify files or execute mutating commands.
4. **Consensus Required**:
   - Both approval-class (`ACCEPT`, `ACCEPT_WITH_NOTES`) $\to$ Task accepted (`DONE`).
   - Disagreement (one approval-class, one blocking-class) $\to$ `HUMAN_GATE`. Never spawn Reviewer C to vote.
   - Both `CHANGES_REQUIRED` $\to$ Orchestrator issues Delta Retry.
   - Any `BLOCK` $\to$ `BLOCKED` or `HUMAN_GATE`.
