# Orchestra 1.x Phase 5 — Independent Review

Date: 2026-10-12
Scope: Packaging, Labs, Doctor & Release — Task 8 review gate
Reviewed implementation checkpoint: `14527eda548baee36747f11107135cccb9e46ec2`
Phase 4 baseline: `d7a81a20c73c5dbdf560763751bb321f6b476690`

## Review method

The review was performed independently from the implementation sequence, with a security-first pass over the Phase 5 trust boundaries rather than treating green tests as sufficient evidence. The pass covered manifest source/output containment, symlink behavior, installer/update/rollback preservation and failure handling, clean Git project state including linked worktrees, Labs zero-authority and egress boundaries, generated-artifact freshness, Doctor/readiness gates, and compatibility with the existing Direct Work / Work Lease contracts.

## Findings resolved

### 1. Rollback backup integrity — BLOCKING, fixed

`rollbackProjectRuntime()` previously trusted `backup.json` and could remove the installed runtime before proving that the backup bytes still matched the recorded runtime hash.

Fix: rollback now snapshots the backup payload and validates both managed-root layout and `runtimeHash` before any destructive mutation. Corrupt backups fail closed with `RUNTIME_BACKUP_INTEGRITY_ERROR` and leave the installed runtime untouched.

Regression coverage: `rollback rejects a corrupted backup before mutating the installed runtime` in `tests/installers/manifest-project-runtime-manager.test.mjs`.

### 2. Jev synthetic-fixture symlink escape — BLOCKING, fixed

The synthetic-fixture live-egress exemption used lexical containment. A symlink created under the fixture directory could resolve to an external project while retaining the synthetic exemption.

Fix: the exemption now compares physical paths using `realpathSync`; resolution failure receives no exemption. Explicit project-egress opt-in remains a separate policy path.

Regression coverage: `synthetic fixture exemption follows physical paths and denies symlink escape` in `tests/labs/jev-canonical.test.mjs`.

### 3. Git linked-worktree local-state ignore — BLOCKING compatibility gap, fixed

The project-state ignore helper assumed `.git` was a directory. Linked Git worktrees use a `.git` file, so Orchestra managed state could reappear in `git status`.

Fix: local exclude resolution now uses `git rev-parse --git-path info/exclude`, which follows Git common-dir/worktree semantics and still fails closed for non-Git targets.

Regression coverage: `linked git worktrees share the repository exclude and keep managed state hidden` in `tests/leases/project-state-ignore.test.mjs`.

### 4. Windows drive-absolute manifest paths — BLOCKING portability/security gap, fixed

Portable manifest validation rejected POSIX absolute paths, traversal segments, and backslashes but could accept drive-absolute strings such as `C:/outside`.

Fix: relative path and glob validation now rejects drive-absolute forms before builder path resolution.

Regression coverage: `manifest validation rejects Windows drive-absolute paths and globs` in `tests/runtime/runtime-manifest.test.mjs`.

## Previously resolved Phase 5 findings rechecked

- Antigravity skill symlink parity is preserved literally through install/update/backup/rollback.
- `release:readiness` fails closed on stale schema validators and stale runtime distributions by invoking the canonical freshness gates.
- Doctor includes runtime build freshness in addition to builder-contract checks.
- Legacy installer tests now assert the Orchestra 1.x neutral runtime metadata and preserved mutable-state directories rather than 0.x artifacts.
- Diagnostic CI/workflows and temporary early-return instrumentation were removed before the clean RC gate.
- Dream and Jev remain zero-authority Labs; Jev live project egress is denied by default.

## Turn Economy / compatibility evidence

The factual Phase 4 → Phase 5 contract comparison is stored at:

`benchmarks/turn-economy/results/orchestra-1x-phase5-rc-contract-comparison.json`

It records the successful Phase 4 CI baseline and Phase 5 RC observation, the four representative Direct Work scenarios, and Work Lease continuity. Live external token/latency/cost fields are deliberately `null`; no such metrics are synthesized.

## Review verdict

No remaining blocking finding was identified in the reviewed Phase 5 trust-boundary scope after the four fixes above.

This review verdict is conditional on the final clean CI succeeding on the post-review branch HEAD. It does not authorize Task 9 release/governance mutations, merging PR #29, or synchronizing Tsuzuki.
