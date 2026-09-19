# Orchestra Project Runtime Management

Orchestra provides independent lifecycle managers for both active provider
runtimes. They replace manual runtime copying with deterministic update,
doctor, version, diff, backup, rollback, and quiescence checks while preserving
each runtime's project-owned state.

## Antigravity runtime

## Ownership boundary

Orchestra may replace only these runtime-owned paths:

- `.agents/agents/`
- `.agents/hooks/`
- `.agents/skills/`
- `.agents/dream/`
- `.agents/hooks.json`
- `GEMINI.md`

These project/state-owned paths are preserved across update and rollback:

- `.agents/rules/`
- `.agents/state/`
- `.agents/telemetry/`
- `.agents/dream-data/`
- `.agents/artifacts/`
- `.agents/semantic/`
- `.agents/runtime-management/`

Dream history, task state, telemetry, project rules, and generated artifacts therefore survive Orchestra runtime upgrades.

## Managed-runtime metadata

Managed projects contain `.agents/orchestra-runtime.json`, recording the Orchestra version, source commit/branch, content-addressed runtime manifest, timestamps, managed path boundary, preserved paths, and previous backup ID.

## Source-repository CLI

Run from the Orchestra checkout:

```bash
node scripts/orchestra-project.mjs install /path/to/project
node scripts/orchestra-project.mjs update /path/to/project --dry-run
node scripts/orchestra-project.mjs update /path/to/project
node scripts/orchestra-project.mjs diff-runtime /path/to/project
node scripts/orchestra-project.mjs doctor /path/to/project
node scripts/orchestra-project.mjs version /path/to/project
node scripts/orchestra-project.mjs backups /path/to/project
node scripts/orchestra-project.mjs evidence /path/to/project
node scripts/orchestra-project.mjs rollback-runtime /path/to/project --backup latest --dry-run
node scripts/orchestra-project.mjs rollback-runtime /path/to/project --backup latest
```

The source wrapper automatically uses the current `runtimes/antigravity` checkout as source of truth.

## Installed-project CLI

A managed project can inspect itself without the Orchestra checkout:

```bash
node .agents/skills/orchestra/project-runtime-cli.mjs doctor
node .agents/skills/orchestra/project-runtime-cli.mjs version
node .agents/skills/orchestra/project-runtime-cli.mjs backups
node .agents/skills/orchestra/project-runtime-cli.mjs evidence
```

Update/diff from the installed CLI require an explicit source runtime:

```bash
node .agents/skills/orchestra/project-runtime-cli.mjs update . \
  --source ~/projects/Orchestra/runtimes/antigravity
```

## Automatic backups

Before every mutating update, Orchestra snapshots only the currently installed managed runtime under `.agents/runtime-management/backups/<backup-id>/`.

Rollback restores only the managed runtime. It does not rewind `.agents/state`, telemetry, Dream data, rules, or artifacts. A safety backup of the current runtime is created before rollback.

Runtime-management events are appended to `.agents/runtime-management/history.jsonl`.

## Legacy adoption

A project installed before `.agents/orchestra-runtime.json` existed can be adopted directly with `update`. Orchestra backs up the legacy managed runtime, preserves project state/history, installs the current runtime, and writes first-class metadata. No clean reinstall or Dream reset is required.

## Quiescence guard

Update and rollback fail closed while the runtime is actively executing. Active states include `PLANNED`, `DELEGATED`, `EXECUTING`, `EVIDENCE_READY`, `CI_WAIT`, `ACCEPTANCE`, `INTEGRATING`, and `CRITICAL_REVIEW`.

`DONE`, `BLOCKED`, and `HUMAN_GATE` are quiescent. `HUMAN_GATE` is intentionally update-safe so a runtime bug can be repaired without deleting the blocked task or Dream history.

`--force` bypasses this guard for explicit operator recovery and should not be the normal path.

## Dry-run, diff, and doctor

`update --dry-run` performs no writes and creates no backup. `diff-runtime` reports added/missing, removed/stale, changed, and unchanged managed paths.

The project doctor checks runtime metadata, managed path presence, content integrity, current runtime state, available backups, preserved paths, and—when a source checkout is available—whether the installed runtime exactly matches that source.

Local edits/corruption under runtime-owned paths are reported as runtime drift instead of being silently trusted.

## Safety invariants

- source repository task state, telemetry, Dream data, and artifacts are never copied into a target;
- target project state/history is never deleted by update or rollback;
- active runtimes are not replaced without explicit `--force`;
- destructive managed-runtime replacement always has a pre-update/pre-rollback backup;
- runtime content is content-addressed and drift-detectable;
- project-owned data remains project-owned even though it lives under `.agents/`.

## Semantic project state

`.agents/semantic` is project-owned and preserved across runtime updates. It may contain local Jev Retrieval Assist approval artifacts; these are never shipped from the Orchestra source runtime.

---

## Codex runtime

Milestone M adds the same lifecycle guarantees to the independent Codex
runtime without importing or modifying Antigravity state.

### Ownership boundary

Codex-managed paths are exactly:

- `.codex/config.toml`
- `.codex/agents/`
- `.codex/astra-orchestra/`

Codex project-owned paths are preserved across update and rollback:

- `.codex/orchestra-state/`
- `.codex/orchestra-telemetry/`
- `.codex/orchestra-artifacts/`
- `.codex/orchestra-semantic/`
- `.codex/runtime-management/`

Metadata lives at `.codex/orchestra-runtime.json`. The manifest covers only
the managed paths, so project state cannot become runtime-owned by accident.

### Source CLI

From an Orchestra checkout:

```bash
node scripts/orchestra-codex-project.mjs install /path/to/project
node scripts/orchestra-codex-project.mjs update /path/to/project --dry-run
node scripts/orchestra-codex-project.mjs update /path/to/project
node scripts/orchestra-codex-project.mjs doctor /path/to/project
node scripts/orchestra-codex-project.mjs version /path/to/project
node scripts/orchestra-codex-project.mjs diff-runtime /path/to/project
node scripts/orchestra-codex-project.mjs backups /path/to/project
node scripts/orchestra-codex-project.mjs evidence /path/to/project
node scripts/orchestra-codex-project.mjs rollback /path/to/project --backup latest
```

A pre-Milestone-M project that already contains an unmanaged `.codex` tree
can be adopted with `update`: Orchestra backs it up first, installs only the
managed Codex paths, writes metadata, and preserves any existing
`.codex/orchestra-*/` project data.

The Codex quiescence guard reads
`.codex/orchestra-state/active-state.json`. `DONE`, `BLOCKED`, and
`HUMAN_GATE` are update-safe; active execution states fail closed unless the
operator explicitly supplies `--force`.

### Clean install behavior

`scripts/install-codex.mjs` and `scripts/install-codex.sh` now route through
the same lifecycle manager. A fresh Codex installation therefore receives
first-class runtime metadata immediately rather than becoming a legacy runtime
that must be adopted on its first update.
