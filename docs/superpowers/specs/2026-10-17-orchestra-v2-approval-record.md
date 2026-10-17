# Orchestra v2 Remaining Program — Approval Record

Date: 2026-10-17
Status: APPROVED FOR IMPLEMENTATION AND CODEX HANDOFF

The operator approved the complete Orchestra v2 remaining-program specification on 2026-10-17 after approving Design A for the Codex Global Adapter.

The following specifications are approved implementation authority for V2-5 through V2-11:

1. `docs/superpowers/specs/2026-10-17-orchestra-v2-remaining-program-design.md`
2. `docs/superpowers/specs/2026-10-17-v2-codex-global-adapter-design.md`

Any older header inside those documents that says `awaiting written-spec review` is stale metadata from before the operator approval and is not an execution gate.

Implementation must use, in this precedence order:

1. this approval record;
2. `docs/superpowers/plans/2026-10-17-v2-execution-locks.md` for final path/command clarifications;
3. `docs/superpowers/plans/2026-10-17-orchestra-v2-remaining-program.md`;
4. the milestone-specific V2-5 through V2-11 plan referenced by the master plan;
5. the approved design specs for architectural intent and invariants.

Execution doctrine is fixed:

- Sol orchestrates only.
- Luna implements.
- There is no investigation workstream.
- Implementation-local file reading is allowed only to execute the assigned bounded task.
- A factual contradiction with the approved spec/plan returns `BLOCKED_BY_SPEC_GAP`.
- Architecture is not redesigned during implementation.
- TDD RED -> GREEN -> refactor is mandatory for behavior changes.
- Milestones use stacked PRs and exact-head CI evidence.
- Merge, tag, release, and production cutover remain explicit operator gates.
