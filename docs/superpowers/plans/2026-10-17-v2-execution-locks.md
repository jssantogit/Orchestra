# Orchestra v2 Remaining Program — Execution Locks

Status: NORMATIVE FOR CODEX HANDOFF
Date: 2026-10-17

This file resolves the final implementation-local ambiguities found during plan review. When a milestone plan contains wording that is less specific than this file, these locks take precedence. They do not change the approved architecture.

## V2-5

- Do not run optional tests with `|| true` or otherwise suppress failures. The corrected V2-5 plan already removes that pattern.
- `tests/installers/codex-project-runtime-manager.test.mjs` is a required V2-5 Task 6 modification/test surface.

### Task 1 exact SQLite paths

The approved predecessor `a3002edb1493cc86e8e9f713477db3add31d1799` does not contain generic `migrations.mjs` or `state.mjs` files. The authoritative paths are:

- Modify: `v2/persistence/sqlite/sqlite-state-core.mjs`
- Modify: `v2/persistence/sqlite/sqlite-state.mjs`

`sqlite-state-core.mjs` owns `CURRENT_SCHEMA_VERSION`, `MIGRATIONS`, schema initialization and the core SQLite state stores. `sqlite-state.mjs` owns composition/exposure of the public SQLite state. These paths are the intended Task 1 surfaces; do not create generic alias files merely to satisfy the earlier mistaken names.

### Existing V2 verification paths

Use the repository's real predecessor test surfaces:

- `tests/runtime/v2-domain-foundation.test.mjs`
- `tests/runtime/v2-reference-state.test.mjs`
- `tests/runtime/v2-continuation-boundary.test.mjs`

Do not substitute the nonexistent names `v2-domain-invariants.test.mjs` or `v2-continuation-capsule.test.mjs`.

### Task 7 exact workflow path

The canonical existing V2 persistence workflow at the same predecessor is:

- Modify: `.github/workflows/v2-persistence.yml`

Do not create `.github/workflows/orchestra-v2-persistence.yml` as an alias.

## V2-6

### Task 2 neutral helper rule

Do not search broadly for abstraction opportunities. Read only V2-5 provider helpers directly imported by the AGY handler. If identical neutral semantics are duplicated by the two handlers, extract that exact duplicated behavior under `v2/providers/`; otherwise keep provider handlers separate.

### Task 4 exact paths

- Create: `v2/providers/antigravity/process-execution.mjs`
- Modify: `providers/antigravity/delegation-executor.mjs`
- Test: `tests/runtime/v2-antigravity-global-adapter.test.mjs`

The v1 executor modification is limited to an explicit bridge/export used by the v2 path while preserving all existing v1 behavior and tests. Do not redesign delegation.

## V2-7

### Task 5 launcher surface

- Modify: `v2/global/cli.mjs`
- Do not modify `v2/global/orchestra.mjs` for Task 5 unless the current launcher contract cannot route the already-supported CLI module. If that concrete contradiction occurs, return `BLOCKED_BY_SPEC_GAP` rather than making an opportunistic launcher redesign.

### Task 6 bootstrap recovery

- Modify: `v2/runtime-images/manager.mjs`
- Reuse without redesign: `v2/global/reconciliation.mjs`
- Test: `tests/runtime/v2-runtime-upgrade.test.mjs`

The required behavior is that runtime activation calls the global reconciler/status/recovery boundary; recovery itself remains independent of the pinned image. If the existing reconciliation public API cannot support this, return `BLOCKED_BY_SPEC_GAP`.

## V2-8

The exact reviewed predecessor is V2-7 head `29e0ebd0af8b886ba1ce309dbc4b4fae55e24eac`.

### Task 1 exact projector path

- Create: `v2/experience/contracts.mjs`
- Modify: `v2/experience/projector.mjs`
- Test: `tests/runtime/v2-global-experience-store.test.mjs`

The predecessor contains `projector.mjs`, not `project.mjs`. Do not create `project.mjs` as an alias.

### Task 2 exact SQLite paths

- Create: `v2/experience/store.mjs`
- Modify: `v2/persistence/sqlite/sqlite-state-core.mjs`
- Modify: `v2/persistence/sqlite/sqlite-state.mjs`

`sqlite-state-core.mjs` remains the owner of SQLite schema versioning/migrations. `sqlite-state.mjs` remains the composition/public-state boundary. Do not create generic `migrations.mjs` or `state.mjs` aliases.

### Task 6 exact workflow path

- Modify: `.github/workflows/v2-persistence.yml`

Do not create `.github/workflows/orchestra-v2-persistence.yml` as an alias.

### V2-8 final invariant paths

Use:
- `tests/runtime/v2-domain-foundation.test.mjs`
- `tests/runtime/v2-reference-state.test.mjs`
- `tests/runtime/v2-continuation-boundary.test.mjs`

Do not substitute the nonexistent `v2-domain-invariants.test.mjs` or `v2-continuation-capsule.test.mjs` names.

## V2-9

The exact reviewed predecessor is V2-8 head `5b99311daadf9d89d0378bbf1626ffc70493de3d`.

### Task 2 exact SQLite paths

- Create: `v2/rsi/policy-store.mjs`
- Create: `v2/rsi/evaluation.mjs`
- Modify: `v2/persistence/sqlite/sqlite-state-core.mjs`
- Modify: `v2/persistence/sqlite/sqlite-state.mjs`
- Test: `tests/runtime/v2-cross-project-rsi.test.mjs`

The predecessor still has no generic `migrations.mjs` or `state.mjs`. `sqlite-state-core.mjs` remains the authoritative owner of schema versioning/migrations, and `sqlite-state.mjs` remains the public composition boundary. Do not create generic aliases.

### Task 6 exact integration boundary

Create:
- `v2/rsi/policy-resolver.mjs`
- `v2/rsi/execution-policy.mjs`

Test:
- `tests/runtime/v2-cross-project-rsi.test.mjs`

`execution-policy.mjs` is the neutral bounded-choice API. It accepts only already-legal candidate choices plus immutable limits and returns a selected legal choice or the deterministic baseline. It may expose route/provider-profile/retry/timeout/turn-economy selectors defined in the approved spec.

Do not modify immutable authorization modules in this task. Do not patch provider handlers merely to demonstrate activation. V2-11 cutover tests consume the public execution-policy service and prove the activated learned policy affects bounded choices without widening governance.

### Task 7 exact workflow and invariant paths

- Modify: `.github/workflows/v2-persistence.yml`
- Verify: `tests/runtime/v2-domain-foundation.test.mjs`
- Verify: `tests/runtime/v2-reference-state.test.mjs`
- Verify: `tests/runtime/v2-continuation-boundary.test.mjs`

Do not create `.github/workflows/orchestra-v2-persistence.yml` or substitute the nonexistent `v2-domain-invariants.test.mjs` / `v2-continuation-capsule.test.mjs` names.

## V2-10

The exact reviewed predecessor is V2-9 head `179589b317725f9d6ba7aa686f21bff68bcf1bd6`.

### Task 3 exact SQLite path

- Reuse: `v2/persistence/sqlite/sqlite-state.mjs`

The predecessor has no `v2/persistence/sqlite/state.mjs`. `sqlite-state.mjs` is the existing public SQLite state composition boundary. Do not create a generic `state.mjs` alias.

### Task 7 exact cleanup command

The CLI surface is exactly:

```text
orchestra project migrate cleanup <projectId> --command-id <id>
```

Do not select an alternate command name during implementation.

### Task 8 exact workflow and invariant paths

- Modify: `.github/workflows/v2-persistence.yml`
- Verify: `tests/runtime/v2-domain-foundation.test.mjs`
- Verify: `tests/runtime/v2-reference-state.test.mjs`
- Verify: `tests/runtime/v2-continuation-boundary.test.mjs`

Do not create `.github/workflows/orchestra-v2-persistence.yml` or substitute the nonexistent `v2-domain-invariants.test.mjs` / `v2-continuation-capsule.test.mjs` names.

## V2-11

### Task 7 exact documentation files

Modify:
- `docs/architecture.md`
- `docs/project-runtime.md`
- `docs/codex.md`
- `docs/antigravity.md`
- `docs/dream-layer.md`

Create:
- `docs/release/v2-cutover-runbook.md`
- `docs/release/v2-rollback-runbook.md`

Do not perform an open-ended documentation sweep.

### Task 7/8 exact release test surfaces

Modify:
- `tests/release/release-readiness.test.mjs`
- `tests/release/release-train.test.mjs`
- `tests/release/prepare-readiness-order.test.mjs`

Preserve the rest of `tests/release/` unchanged unless one of these exact tests imports a helper whose signature must change; such a helper edit is implementation-local and must be reported by Luna.

## Evidence rule

No task may use `|| true`, ignored exit codes, placeholder success evidence, synthetic provider identities, or manual state-file edits to make a gate pass.

If a path named by the approved plan/locks does not exist at the expected predecessor head, that is a factual plan contradiction and must be reported as `BLOCKED_BY_SPEC_GAP`; Luna must not replace it with a guessed path after broad repository exploration.
