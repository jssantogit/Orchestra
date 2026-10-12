# Orchestra Project Runtime Management

Orchestra uses one manifest-driven project-runtime contract for the active provider runtimes. Official installers build a deterministic provider payload, install only manifest-owned paths, preserve project-owned state, and record canonical runtime metadata under `.orchestra/state`.

## Canonical metadata and runtime-management state

Current installations use schema `orchestra.project-runtime.v2`.

- Codex metadata: `.orchestra/state/runtimes/codex.json`
- Antigravity metadata: `.orchestra/state/runtimes/antigravity.json`
- Codex backups/history: `.orchestra/state/runtime-management/codex/`
- Antigravity backups/history: `.orchestra/state/runtime-management/antigravity/`

The old provider-local metadata files `.codex/orchestra-runtime.json` and `.agents/orchestra-runtime.json` are legacy compatibility artifacts. Official v2 installers and source-level lifecycle commands do not create them.

Metadata records the runtime version, canonical manifest hash, built runtime hash, timestamps, managed-path boundary, preserved paths, last operation, and previous backup ID. Doctor and update compare the installed tree to the same deterministic payload produced by the runtime builder rather than comparing it to an unbuilt source tree.

## Source-level lifecycle CLIs

Run lifecycle operations from an Orchestra checkout. The source wrappers build the current runtime payload in a temporary directory and route all mutations and Doctor checks through the v2 provider managers.

### Codex

```bash
node scripts/orchestra-codex-project.mjs install /path/to/project
node scripts/orchestra-codex-project.mjs update /path/to/project --dry-run
node scripts/orchestra-codex-project.mjs update /path/to/project
node scripts/orchestra-codex-project.mjs diff-runtime /path/to/project
node scripts/orchestra-codex-project.mjs doctor /path/to/project
node scripts/orchestra-codex-project.mjs version /path/to/project
node scripts/orchestra-codex-project.mjs backups /path/to/project
node scripts/orchestra-codex-project.mjs evidence /path/to/project
node scripts/orchestra-codex-project.mjs rollback /path/to/project --backup latest --dry-run
node scripts/orchestra-codex-project.mjs rollback /path/to/project --backup latest
```

### Antigravity

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

The dedicated installers use the same canonical managers:

```bash
node scripts/install-codex.mjs /path/to/project
node scripts/install-antigravity.mjs /path/to/project
```

A fresh install must be immediately recognizable by its corresponding source-level Doctor. No metadata migration or first-update adoption step is required.

## Ownership boundaries

### Codex managed runtime

Manifest-owned paths include:

- `.codex/config.toml`
- `.codex/hooks.json`
- `.codex/agents/`
- `.codex/astra-orchestra/`

Project-owned paths preserved across update and rollback include:

- `.codex/orchestra-state/`
- `.codex/orchestra-telemetry/`
- `.codex/orchestra-artifacts/`
- `.codex/orchestra-semantic/`
- `.codex/runtime-management/`
- `.orchestra/state/`

### Antigravity managed runtime

Manifest-owned paths include:

- `.agents/agents/`
- `.agents/hooks/`
- `.agents/skills/`
- `.agents/dream/`
- `.agents/hooks.json`
- `GEMINI.md`

Project-owned paths preserved across update and rollback include:

- `.agents/rules/`
- `.agents/state/`
- `.agents/telemetry/`
- `.agents/dream-data/`
- `.agents/artifacts/`
- `.agents/semantic/`
- `.agents/runtime-management/`
- `.orchestra/state/`

The manifest defines the exact ownership boundary. Runtime updates never promote unrelated project files into Orchestra-owned state.

## Quiescence guards

Provider adapters retain provider-native active-state locations while the generic v2 manager owns mutation mechanics.

Codex reads `.codex/orchestra-state/active-state.json`. `INTAKE`, `DONE`, `BLOCKED`, and `HUMAN_GATE` are update-safe. Known execution states fail closed.

Antigravity reads `.agents/state/active-state.json`. `DONE`, `BLOCKED`, and `HUMAN_GATE` are update-safe. Known execution states fail closed.

Malformed, empty, or unrecognized active state fails closed for both providers. `--force` is reserved for explicit operator recovery.

## Doctor and drift detection

The provider Doctor validates:

- that the provider runtime is installed;
- canonical v2 metadata;
- byte-level managed-runtime integrity against a freshly built payload;
- metadata freshness against the current runtime manifest and payload.

A runtime edit or corruption under managed paths makes Doctor unhealthy. Missing or stale metadata also makes Doctor unhealthy. Failed checks are evidence of an unhealthy installation; they are never silently normalized.

## Backups and rollback

Before a mutating runtime replacement, Orchestra creates a content-addressed backup under `.orchestra/state/runtime-management/<runtime>/backups/<backup-id>/`.

Rollback verifies backup metadata, managed-path ownership, and runtime snapshot integrity before destructive mutation. Project-owned provider state is not rewound by runtime rollback.

## Ignore behavior

Project-runtime state is hidden from normal project Git status through Orchestra's canonical project-state ignore handling. Installers preserve user-owned ignore entries and do not modify `.gitignore` merely to hide Orchestra state.

## Safety invariants

- provider model identity never grants runtime authority;
- official installers and source lifecycle commands share the same v2 metadata contract;
- managed runtime is compared to the deterministic built payload;
- active runtimes are not replaced without explicit `--force`;
- runtime replacement is backup-protected;
- backup restore is integrity-checked before mutation;
- project-owned state survives update and rollback;
- failed or missing validation is not accepted as evidence;
- current lifecycle commands do not manufacture legacy provider-local metadata.
