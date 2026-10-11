# Orchestra — Antigravity (AGY) Runtime

This directory contains the Google Antigravity / ALL-GEMINI implementation of Orchestra.

```text
GEMINI 3.8 FLASH MEDIUM (Global Orchestrator & Control Plane)
  ├─ intake, state transitions, Scope Contracts, acceptance
  ├─ investigate → FLASH HIGH (isolated, read-only)
  ├─ implement   → FLASH LOW | MEDIUM | HIGH
  ├─ critical review → TWO-KEY FLASH HIGH
  ├─ fast path   → DIRECT_ACTION
  └─ validation  → Evidence Ledger, freshness, verification gates
```

---

## 1. Prerequisites

- Google Antigravity CLI (`agy`) or Antigravity IDE.
- Node.js v18+.

---

## 2. Runtime Layout

### Committed runtime

- `.agents/hooks.json` — engine lifecycle hook topology.
- `.agents/hooks/work-lease-pre-invocation.mjs` — root Work Lease authority before invocation, then legacy/runtime governance delegation.
- `.agents/hooks/work-lease-pre-tool.mjs` — root capability/generation fence before tool use, then `pre-tool-enforce.mjs`.
- `.agents/hooks/pre-tool-enforce.mjs` — Scope Contract, role, read/write, output and polling enforcement.
- `.agents/hooks/post-tool-telemetry.mjs` — mutation/evidence/telemetry capture.
- `.agents/hooks/stop-guard.mjs` — evidence-backed completion gate.
- `.agents/agents/` — orchestrator, low/medium/high workers, reviewer and policy designer profiles.
- `.agents/skills/orchestra/` — deterministic policy, authority, runtime management and handoff recovery.
- `.agents/dream/` — offline/shadow Dream components and bounded exploration policy machinery.

### Project-owned state

- `.agents/state/` — active Antigravity execution/governance state.
- `.agents/telemetry/` — factual runtime telemetry.
- `.agents/artifacts/` — output artifacts.
- `.agents/dream-data/` — durable offline Dream artifacts.
- `.orchestra/state/` — provider-neutral Work Lease state.

The neutral Work Lease namespace is locally hidden by managed `.git/info/exclude`, not by editing the project's tracked `.gitignore`.

---

## 3. ALL-GEMINI Roles

| Role | Profile / Model | Duties |
| :--- | :--- | :--- |
| Global orchestrator | `gemini-3.8-flash-medium` | Intake, state, Scope Contracts, acceptance |
| Worker Low | `gemini-3.8-flash-low` | Docs/mechanical/simple bounded fixes |
| Worker Medium | `gemini-3.8-flash-medium` | Standard implementation and routine testing |
| Worker High | `gemini-3.8-flash-high` | Complex implementation/integration |
| Investigation specialist | `gemini-3.8-flash-high` | Strictly read-only investigation |
| Two-Key reviewers | `gemini-3.8-flash-high` | Independent critical review |
| Offline policy designer | `gemini-3.8-flash-high` | Tool-less Dream policy proposals |

The runtime is ALL-GEMINI. Active Antigravity routing never imports or routes to Codex/OpenAI workers.

---

## 4. Execution, Evidence & Dream Boundaries

Antigravity enforces strict separation of duties: the orchestrator scopes and accepts but does not write product code; workers implement bounded Scope Contracts and cannot spawn subagents or self-accept.

Typed Evidence Contracts, mutation freshness, delegated evidence federation, runtime-owned mechanical facts, remote-CI providers, side-effect capabilities, and Stop Guard remain authoritative. Failed tools are never evidence.

Direct Work is the default bounded implementation lane. `ORCHESTRA_DIRECT_WORK_MODE` defaults to `on`; explicit `shadow` and `off` preserve migration/rollback paths, and invalid explicit values fail safe to `shadow`.

Dream remains zero-authority outside its static governance ceilings. Replay is model-free, exploration is physically isolated and budgeted, Shadow has no execution authority, Canary expansion is human-gated, and policy promotion remains explicitly human-approved.

---

## 5. Work Lease Authority

Orchestra 1.x separates Antigravity conversation provenance from project ownership. `mainConversationId` remains a provider compatibility projection; the primary authority object is the provider-neutral Work Lease under `.orchestra/state/work-lease.json`.

`ORCHESTRA_AUTHORITY_MODE` supports:

- `lease` — primary authority and the default when unset/empty.
- `dual` — migration/compatibility mode.
- `session` — temporary rollback to the 0.9 conversation/handoff authority path.

Invalid explicit values fail safe to `session`.

Only factual root identities may claim control. A child worker, reviewer, investigator, or delegated conversation cannot become root merely because it has a conversation ID. Neutral lease state persists only provider plus a stable conversation-ID hash.

Lease generation is the mutation fence. A current `WORKSPACE_EDIT` holder blocks an incompatible fresh root with `WRITE_LEASE_ACTIVE`. Once mutation authority is released to `CONTROL`, a compatible fresh root may atomically advance the generation and continue the current candidate/evidence lineage. Former generations are denied as `STALE_WORK_LEASE`.

The wrapper topology deliberately preserves existing governance:

```text
root PreInvocation
  -> Work Lease claim/fence
  -> legacy/runtime pre-invocation governance

root PreToolUse
  -> Work Lease capability/generation check
  -> pre-tool-enforce.mjs

delegated child
  -> existing factual role/scope governance
```

Continuation authority is bounded to factual task/work state, candidate identity, evidence/audit references, blockers, approved direction, and lease generation. Transcript, prompt history, summaries, prior-chat prose, and hidden reasoning are not authority.

The legacy handoff CLI remains only for recovery/debug and explicit `session` rollback:

```bash
node .agents/skills/orchestra/orchestrator-handoff-cli.mjs prepare --boundary
node .agents/skills/orchestra/orchestrator-handoff-cli.mjs prepare --live
```

It is no longer the normal fresh-root workflow in `lease` mode.

---

## 6. Project Runtime Lifecycle

Installed Antigravity projects use the managed updater rather than replacing `.agents` manually:

```bash
node scripts/orchestra-project.mjs update /path/to/project --dry-run
node scripts/orchestra-project.mjs update /path/to/project
node scripts/orchestra-project.mjs doctor /path/to/project
node scripts/orchestra-project.mjs version /path/to/project
node scripts/orchestra-project.mjs diff-runtime /path/to/project
node scripts/orchestra-project.mjs rollback-runtime /path/to/project --backup latest
```

Updates replace only Orchestra-owned runtime paths and preserve project rules, execution state, telemetry, Dream data, artifacts, semantic state, runtime-management history, and `.orchestra/state/**`.

---

## 7. Verification

```bash
node --test runtimes/antigravity/tests/routing-policy.test.mjs
node --test --test-concurrency=1 runtimes/antigravity/tests/hooks.test.mjs
npm run test:leases
npm run test:handoff
npm run test:architecture-invariants
npm run test:firewall
npm run test:installers
```
