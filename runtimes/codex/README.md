# Orchestra — Codex Runtime

This directory contains the OpenAI/Codex implementation of Orchestra.

Sol 6 owns control, investigation, and review. Luna 6 performs bounded product implementation. Astra remains manual-only.

```text
SOL MEDIUM (Global Control Plane)
  ├─ classify action/domain and write Scope Contract
  ├─ investigate → SOL HIGH / XHIGH / MAX
  ├─ implement   → LUNA HIGH (simple) or LUNA MAX (normal)
  ├─ support     → LUNA MEDIUM (deterministic/bounded)
  ├─ critical review → SOL REVIEW LOW; specialist → SOL REVIEW MEDIUM
  ├─ manual packet → ASTRA MANUAL ONLY
  └─ validate evidence, integrate deliverables, accept or fail closed
```

---

## 1. Prerequisites

- OpenAI Codex CLI / IDE integration with custom subagent support.
- Node.js v18+.

---

## 2. Runtime Layout

- `.codex/config.toml` — project-scoped model and multi-agent configuration.
- `.codex/hooks.json` — provider-native `SessionStart`, `UserPromptSubmit`, and `PreToolUse` hooks.
- `.codex/astra-orchestra/INSTRUCTIONS.md` — control-plane instructions.
- `.codex/astra-orchestra/routing-policy.mjs` — deterministic routing and scope policy.
- `.codex/astra-orchestra/evidence-*.mjs` — factual evidence, federation, provider registry, and CI watch support.
- `.codex/astra-orchestra/trust-boundary.mjs` — context and side-effect authority.
- `.codex/astra-orchestra/work-lease-authority.mjs` — Work Lease adapter for factual Codex sessions.
- `.codex/astra-orchestra/session-authority.mjs` — legacy session authority retained for rollback/recovery.
- `.codex/astra-orchestra/session-hook.mjs` — provider hook adapter selecting lease or rollback semantics.
- `.codex/astra-orchestra/session-handoff-cli.mjs` — recovery/debug boundary handoff CLI.
- `.codex/astra-orchestra/mechanical-fast-path.mjs` — bounded Luna Medium support.
- `.codex/astra-orchestra/context-packet.mjs` — bounded reference-oriented worker packets.
- `.codex/astra-orchestra/dream-lab.mjs` — isolated zero-authority Dream replay/shadow lab.
- `.codex/astra-orchestra/codex-runtime-manager.mjs` — legacy compatibility lifecycle retained for rollback/recovery tests; canonical current lifecycle is the manifest-driven v2 provider manager invoked by `scripts/orchestra-codex-project.mjs`.
- `.codex/agents/*.toml` — specialized Sol/Luna/Astra profiles.

---

## 3. Routing & Profiles

| Action / Intent | Profile | Model / Effort | Purpose |
| :--- | :--- | :--- | :--- |
| `ORCHESTRATE`, `DIRECT_ACTION`, intake | `sol-medium` | Sol 6 / medium | Global control plane, planning, acceptance |
| `IMPLEMENT` simple / `TEST` | `luna-high` | Luna 6 / high | Small conventional changes |
| `IMPLEMENT` normal/complex / `INTEGRATE` | `luna-max` | Luna 6 / max | Standard and complex product work |
| bounded deterministic support | `luna-medium` | Luna 6 / medium | Mechanical/docs/support work |
| `INVESTIGATE` | `sol-high` → `sol-xhigh` → `sol-max` | Sol 6 | Read-only investigation ladder |
| critical review / specialist | `sol-review-low` / `sol-review-medium` | Sol 6 | Independent review |
| approved escalation packet | `astra-manual` | GPT-6 Astra / medium | Manual-only consultation |

Sol Medium scopes and accepts work but never writes product code. Luna implements only within the declared Scope Contract and never self-accepts. Reviewers are read-only. Automatic Astra routing is prohibited.

---

## 4. Direct Work & Evidence

Bounded implementation defaults to Direct Work. With `ORCHESTRA_DIRECT_WORK_MODE` unset or empty, the gate is `on`; `shadow` computes the lane without changing legacy routing; `off` restores legacy routing; invalid explicit values fail safe to `shadow`.

Sol resolves the task into a canonical Implementation Packet before delegation. Luna receives execution decisions, anchors, scope, discovery permissions, validation requirements, and failure policy instead of a raw problem to reinterpret. Discovery is `NONE` or anchor-bound `DIRECTED`. Tests may change only when explicitly authorized. Workers repair only failures clearly caused by their own patch.

After candidate creation, factual evidence/CI and independent diff-scoped Quick Audit may run in parallel. Sol remains the sole acceptance authority.

`requiredEvidence` is first-class. Failed tools are never evidence. Delegated evidence is accepted only after factual producer/task/attempt/candidate correlation. Remote/public side effects remain default-deny without explicit factual capability.

---

## 5. Work Lease Authority

Orchestra 1.x makes Work Lease authority primary. Factual Codex `session_id` is actor provenance, not permanent project ownership.

The neutral lease is stored at `.orchestra/state/work-lease.json`; actors are persisted as provider plus stable `session_id` hash. Lease generation is the mutation fence.

`ORCHESTRA_AUTHORITY_MODE` supports:

- `lease` — default when unset/empty; primary 1.x authority.
- `dual` — migration/compatibility mode.
- `session` — temporary rollback to 0.10 session authority.

Invalid explicit values fail safe to `session`.

A fresh root may continue compatible factual work with no prepared handoff when no incompatible writer is active. An actor holding `WORKSPACE_EDIT` blocks takeover with `WRITE_LEASE_ACTIVE`. After a compatible root advances the generation, an older root is fenced as `STALE_WORK_LEASE`.

When a mutating tool is authorized, the lease upgrades to `WORKSPACE_EDIT`; after mutation completes, the runtime returns authority to `CONTROL`, allowing a later compatible root to continue. Read-only control never implicitly grants mutation authority.

Continuation can preserve only bounded factual work state: task/candidate identity, evidence/audit references, blockers, approved direction, and lease generation. Transcript, prompts, summaries, arbitrary prior-chat prose, and hidden reasoning are not authority.

The old boundary command remains available only for explicit recovery/debug and `session` rollback:

```bash
node .codex/astra-orchestra/session-handoff-cli.mjs prepare --boundary
```

It is no longer the normal fresh-chat workflow in `lease` mode.

---

## 6. Project Runtime Lifecycle

Existing Codex projects should use the source runtime manager instead of manually replacing `.codex`:

```bash
node scripts/orchestra-codex-project.mjs update /path/to/project --dry-run
node scripts/orchestra-codex-project.mjs update /path/to/project
node scripts/orchestra-codex-project.mjs doctor /path/to/project
node scripts/orchestra-codex-project.mjs version /path/to/project
node scripts/orchestra-codex-project.mjs diff-runtime /path/to/project
node scripts/orchestra-codex-project.mjs evidence /path/to/project
node scripts/orchestra-codex-project.mjs rollback /path/to/project --backup latest
```

The source lifecycle uses canonical schema `orchestra.project-runtime.v2` at `.orchestra/state/runtimes/codex.json` and compares the installed runtime against the deterministic built payload. It does not create or require legacy `.codex/orchestra-runtime.json` metadata.

Managed code is limited to `.codex/config.toml`, `.codex/hooks.json`, `.codex/agents/`, and `.codex/astra-orchestra/`. Provider state and neutral `.orchestra/state/**` remain project-owned and survive update/rollback.

Orchestra manages `.orchestra/state/**` in local `.git/info/exclude`; it does not add this runtime state to the project's tracked `.gitignore`.

---

## 7. Validation

```bash
npm run test:codex
npm run test:leases
npm run test:architecture-invariants
npm run test:firewall
node --test tests/installers/codex-v2-doctor.test.mjs
npm run test:installers
```

The Codex runtime remains provider-isolated: it does not import or emulate Antigravity operational code.