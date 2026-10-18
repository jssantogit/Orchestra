# Orchestra Project Runtime Management

## V2 default topology

Orchestra v2 runs from a user-level **global control plane** under Orchestra Home. A registered Project reaches that global engine through a **thin provider shim**; the Project stores its Project identity, current Work/Operation facts and Runtime Image pin in the global state instead of receiving a copied full v2 governance brain.

Runtime Images are installed once under Orchestra Home and Projects pin them independently. Runtime install, compatibility checks, Project upgrade/rollback, factual status and recovery are global operations. Current Project-scoped Work, generation and instruction epoch are authoritative; Work Lease/session handoff is legacy compatibility/recovery behavior, not normal v2 authority.

The project-local runtime lifecycle described in the remainder of this document is the Orchestra 1.x **compatibility/migration topology**. It remains supported for migration, rollback and historical compatibility, but normal v2 must not copy, install or materialize a full governance runtime per Project. See `docs/release/v2-cutover-runbook.md` and `docs/release/v2-rollback-runbook.md` for the operator-gated topology switch.

---

Orchestra uses one manifest-driven project-runtime contract for the active provider runtimes. Official installers build a deterministic provider payload, install only manifest-owned paths, preserve project-owned state, and record canonical runtime metadata under `.orchestra/state`.

## Canonical metadata and runtime-management state

Current installations use schema `orchestra.project-runtime.v2`.

- Codex metadata: `.orchestra/state/runtimes/codex.json`
- Antigravity metadata: `.orchestra/state/runtimes/antigravity.json`
- Delegation metadata: `.orchestra/state/runtimes/delegation.json`
- Codex backups/history: `.orchestra/state/runtime-management/codex/`
- Antigravity backups/history: `.orchestra/state/runtime-management/antigravity/`
- Delegation backups/history: `.orchestra/state/runtime-management/delegation/`

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

Both provider `install`/`update` flows also build and ensure the neutral `delegation` runtime. The public provider rollback commands remain provider-specific; they do not implicitly rewind `.orchestra/runtime/delegation`. The neutral manager has its own backup-protected rollback primitive for recovery/integration code, but Orchestra does not currently expose a standalone neutral rollback CLI.

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

### Neutral delegation runtime

The independent delegation manifest owns only `.orchestra/runtime/delegation/**`. Its built image contains the provider-neutral Core/contracts, delegation runtime machinery, and the bounded Codex/Antigravity delegation executor plus model-catalog files required to launch external workers. It does not own `.codex/**`, `.agents/**`, `GEMINI.md`, provider adapters, hooks, session state, or either provider control plane.

Durable delegation records under `.orchestra/state/delegations/**` are project-owned and preserved across runtime replacement. Temporary delegated worktrees are execution artifacts, not managed project runtime paths.

The manifest defines the exact ownership boundary. Runtime updates never promote unrelated project files into Orchestra-owned state.

## Quiescence guards

Provider adapters retain provider-native active-state locations while the generic v2 manager owns mutation mechanics.

Codex reads `.codex/orchestra-state/active-state.json`. `INTAKE`, `DONE`, `BLOCKED`, and `HUMAN_GATE` are update-safe. Known execution states fail closed.

Antigravity reads `.agents/state/active-state.json`. `DONE`, `BLOCKED`, and `HUMAN_GATE` are update-safe. Known execution states fail closed.

The neutral delegation adapter inspects `.orchestra/state/delegations/`. Any delegation still in flight blocks neutral runtime replacement with `DELEGATION_IN_FLIGHT`; unreadable delegation state also fails closed. A completed delegation does not block update, and its durable record survives the replacement.

Malformed, empty, or unrecognized active state fails closed for both providers. `--force` is reserved for explicit operator recovery. Provider `--force` does not silently bypass delegation quiescence when the provider wrapper is ensuring the neutral runtime.

## Doctor and drift detection

The provider Doctor validates:

- that the provider runtime is installed;
- canonical v2 metadata;
- byte-level managed-runtime integrity against a freshly built payload;
- metadata freshness against the current runtime manifest and payload.

The repository-level `npm run doctor` additionally validates the neutral delegation manifest/image and reports **delegation readiness separately from structural health**. Readiness probes only Git worktree support and provider CLI version/help surfaces. Orchestra does not install a CLI, authenticate an account, or perform an inference call during discovery.

`READY` means the required Git worktree support and both provider executors are discoverable; `DEGRADED` means the optional cross-provider surface is only partially available; `UNAVAILABLE` means delegation cannot currently execute. Missing optional provider CLIs therefore remain advisory and do not make an otherwise healthy single-provider Orchestra installation unhealthy.

A runtime edit or corruption under managed paths makes Doctor unhealthy. Missing or stale metadata also makes Doctor unhealthy. Failed structural checks are evidence of an unhealthy installation; optional delegation readiness is not silently promoted into structural health.

## Backups and rollback

Before a mutating runtime replacement, Orchestra creates a content-addressed backup under `.orchestra/state/runtime-management/<runtime>/backups/<backup-id>/`.

Rollback verifies backup metadata, managed-path ownership, and runtime snapshot integrity before destructive mutation. Project-owned provider state is not rewound by runtime rollback. The same generic backup/rollback mechanics back the neutral delegation manager, but provider-facing rollback commands currently target only their own provider runtime.

## Ignore behavior

Project-runtime state is hidden from normal project Git status through Orchestra's canonical project-state ignore handling. Installers preserve user-owned ignore entries and do not modify `.gitignore` merely to hide Orchestra state.

## Safety invariants

- provider model identity never grants runtime authority;
- official installers and source lifecycle commands share the same v2 metadata contract;
- provider install/update ensures the independent neutral delegation image without merging control planes;
- managed runtime is compared to the deterministic built payload;
- active runtimes are not replaced without explicit recovery authority;
- in-flight delegation blocks neutral runtime replacement;
- runtime replacement is backup-protected;
- backup restore is integrity-checked before mutation;
- project-owned state, including delegation records, survives update and rollback;
- failed or missing validation is not accepted as evidence;
- optional provider absence degrades delegation readiness without making the base provider runtime unhealthy;
- current lifecycle commands do not manufacture legacy provider-local metadata.
