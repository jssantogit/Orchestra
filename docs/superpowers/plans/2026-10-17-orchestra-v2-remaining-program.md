# Orchestra v2 Remaining Program — Implementation Master Plan

> **For Codex execution:** Sol orchestrates; Luna implements. No investigation tasks. Follow the approved specs and milestone plans task-by-task. If repository facts contradict the approved design, return `BLOCKED_BY_SPEC_GAP` instead of redesigning.

**Goal:** Complete Orchestra v2 from V2-5 through V2-11 and move normal operation from project-local 1.x runtimes to the approved user-global control plane.

**Approved specs:**
- `docs/superpowers/specs/2026-10-17-orchestra-v2-remaining-program-design.md`
- `docs/superpowers/specs/2026-10-17-v2-codex-global-adapter-design.md`

**Baseline:** V2-4 branch `feat/v2-reconciler-recovery`, reviewed head `a3002edb1493cc86e8e9f713477db3add31d1799`.

**Tech stack:** Node.js 24 for v2, ESM, `node:test`, SQLite through `node:sqlite`, SHA-256/content-addressed blobs where already used, GitHub Actions, existing v2 global authority/liveness/reconciliation core.

---

## 1. Execution doctrine

### Sol — orchestrator only

Sol must:
- read the approved spec and the current milestone plan;
- verify the branch starts from the reviewed predecessor head;
- assign one bounded implementation task at a time to Luna;
- require RED evidence before behavior implementation;
- inspect Luna's diff and test evidence;
- run or request focused/full verification;
- decide retry, rollback, or `BLOCKED_BY_SPEC_GAP`;
- update PR evidence only after exact-head CI.

Sol must not implement product code, tests, migrations, provider adapters, or documentation tasks assigned to Luna.

### Luna — implementer

Luna may read only the files named by the current task plus direct imports/tests required to edit them safely. Luna implements the bounded change, tests it, commits it, and reports:
- changed paths;
- RED command/output summary;
- GREEN command/output summary;
- commit SHA;
- any blocker.

No broad archaeology, capability research, architecture alternatives, speculative refactors, or requirement rediscovery.

### Spec-gap protocol

If code facts make the task impossible as written, stop with:

```text
BLOCKED_BY_SPEC_GAP
milestone: V2-X
 task: <task id>
spec: <section>
fact: <exact code/test contradiction>
decision_required: <smallest unresolved decision>
```

Do not invent a new architecture locally.

---

## 2. Branch and PR stack

Use stacked branches. Do not merge a predecessor merely to begin the next milestone.

```text
feat/v2-reconciler-recovery
  -> feat/v2-codex-global-adapter
  -> feat/v2-antigravity-global-adapter
  -> feat/v2-runtime-images
  -> feat/v2-global-experience
  -> feat/v2-cross-project-rsi
  -> feat/v2-migration-delocalization
  -> feat/v2-cutover-release
```

For each milestone:
1. branch from the exact reviewed head of the predecessor;
2. create a draft PR against the predecessor branch;
3. execute TDD tasks in order;
4. run focused milestone tests;
5. run prior v2 invariant tests;
6. run `npm test`;
7. push exact head;
8. wait for canonical GitHub Actions on that exact head;
9. Sol records exact head/run in PR body;
10. mark ready for review only when all required jobs are green.

No merge or release without explicit operator approval.

---

## 3. Milestone plans

Execute strictly in this order:

1. `docs/superpowers/plans/2026-10-17-v2-5-codex-global-adapter.md`
2. `docs/superpowers/plans/2026-10-17-v2-6-antigravity-global-adapter.md`
3. `docs/superpowers/plans/2026-10-17-v2-7-runtime-images.md`
4. `docs/superpowers/plans/2026-10-17-v2-8-global-experience-store.md`
5. `docs/superpowers/plans/2026-10-17-v2-9-cross-project-rsi.md`
6. `docs/superpowers/plans/2026-10-17-v2-10-migration-delocalization.md`
7. `docs/superpowers/plans/2026-10-17-v2-11-cutover-release.md`

A later milestone may consume predecessor contracts but must not redefine them.

---

## 4. Permanent verification surface

At every milestone close, run at minimum:

```bash
node --test tests/runtime/v2-domain-invariants.test.mjs
node --test tests/runtime/v2-reference-state.test.mjs
node --test tests/runtime/v2-continuation-capsule.test.mjs
npm run test:runtime
npm test
```

Also run the milestone-specific test files listed in its plan.

Where provider packaging/shims change, also run:

```bash
npm run test:firewall
npm run test:installers
npm run check:runtimes
npm run check:runtime-core
```

Where release/cutover changes occur, also run:

```bash
npm run test:release
npm run release:readiness
npm run check:contamination
```

Canonical CI remains `.github/workflows/orchestra-v2-persistence.yml` for the growing v2 matrix plus existing v1 compatibility jobs. Expand that workflow only when a milestone requires new platform gates; never weaken existing jobs to make the stack pass.

---

## 5. Cross-program stop conditions

Stop the current task and return a factual blocker if any change would require:
- making session/conversation identity project authority;
- treating persisted `RUNNING` as liveness proof;
- creating synthetic provider execution IDs;
- copying a v2 governance runtime into a project for convenience;
- storing raw source/prompts/transcripts in global Experience;
- letting learned policy override immutable governance;
- destructively auto-healing ambiguous v1 migration state;
- making runtime N responsible for permitting installation of recovery logic in N+1;
- bypassing exact project/work/generation/epoch fences.

These are architecture violations, not implementation choices.

---

## 6. Milestone acceptance records

At the end of each milestone Sol must leave a concise PR checkpoint containing:

```text
Milestone: V2-X
Branch: ...
Head: ...
Focused tests: PASS
Prior v2 invariants: PASS
Full v1 regression: PASS
Portable runtime: PASS/NOT-APPLICABLE
Canonical workflow: <run id> SUCCESS
Open blockers: none
Merge performed: no
```

If any field is not factually proven, the milestone remains incomplete.

---

## 7. Final program completion

The remaining program is complete only when V2-11 proves:
- Orchestra self-hosts through the v2 global control plane;
- Codex and Antigravity both use global adapters in real field execution;
- at least two independent registered projects operate without full local Orchestra brains;
- runtime image upgrade/rollback and stale recovery work;
- Experience/RSI promotion requires independent lineages and survives replay/holdout checks;
- Tsuzuki's F7 orphan shape is migrated/reconciled through official lifecycle;
- Windows and POSIX paths are green;
- v1 local topology is no longer required for normal operation;
- rollback remains documented and executable.
