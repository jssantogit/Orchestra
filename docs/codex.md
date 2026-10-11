# Codex Runtime Guide

The Codex runtime implementation of Orchestra coordinates multi-agent coding tasks within OpenAI Codex environments.

---

## 1. Architecture & Model Roles

The Codex control plane uses tiered OpenAI models:

Sol 6 handles orchestration and investigation through `sol-medium`,
`sol-high`, `sol-xhigh`, and `sol-max`. Reviewers use separate
`sol-review-low` and `sol-review-medium` profiles.

```text
SOL MEDIUM (Control Plane)
  ├─ classify action/domain and write scopeContract
  ├─ investigate → SOL HIGH / XHIGH / MAX
  ├─ implement  → LUNA HIGH (simple) or LUNA MAX (normal)
  ├─ support    → LUNA MEDIUM (explicitly bounded deterministic)
  ├─ critical review → SOL REVIEW LOW; specialist → SOL REVIEW MEDIUM
  └─ validate evidence, integrate when needed, accept or fail closed
```

- **Sol Medium (`gpt-6-sol`, effort: medium)**: Main session control plane. Handles task intake, routing decisions, scope contracts, validation evaluation, and final acceptance.
- **Luna High (`gpt-6-luna`, effort: high)**: Implementation worker for small, conventional, and low-risk changes.
- **Luna Max (`gpt-6-luna`, effort: max)**: Implementation worker for standard, non-trivial, and complex product implementation.
- **Luna Medium (`gpt-6-luna`, effort: medium)**: Bounded deterministic support worker for mechanical tasks, docs, and non-critical formatting.
- **Sol High / XHigh / Max (`gpt-6-sol`, effort: high/xhigh/max)**: Escalation ladder for difficult architectural investigations and conflicting evidence. Operates in read-only sandbox mode.
- **Sol Review Low / Medium (`gpt-6-sol`, effort: low/medium)**: Independent critical review and specialist escalation. Reviewers never implement their own findings.
- **Astra Manual (`gpt-6-astra`, effort: medium)**: **MANUAL ONLY**. Accessible only via an explicitly approved user escalation packet. Automatic fallback or routing to Astra is prohibited.

---

## 2. Configuration (`.codex/config.toml`)

The configuration file is scoped to the repository:

```toml
#:schema https://developers.openai.com/codex/config-schema.json
model = "gpt-6-sol"
model_reasoning_effort = "medium"
model_instructions_file = "astra-orchestra/INSTRUCTIONS.md"

[features]
multi_agent = true
multi_agent_v2 = true

[agents]
enabled = true
max_concurrent_threads_per_session = 1
default_subagent_model = "gpt-6-luna"
default_subagent_reasoning_effort = "max"
```

---

## 3. Delegation & Scope Contracts

Every delegation to Luna or Sol includes:
1. `taskDomain`: Canonical domain (`CODE`, `UI`, `DATA`, `INFRA`, `TESTING`, `DOCS`, `RESEARCH`, `GENERAL`).
2. `scopeContract`: Explicit `allowedPaths` and `forbiddenPaths`.
3. `acceptanceCriteria`: Measurable requirements.
4. `testsRequired` and/or structured `requiredEvidence`.
5. `sideEffectCapabilities`: Explicit capabilities for remote/public writes when needed.
6. `retryBudget`: Capped retry attempts (default 2).

---

## 4. Tool Truthfulness: "FAILED TOOL IS NOT EVIDENCE"

The Codex policy module enforces deterministic tool evaluation:
- Every command must exit with code `0` and expected output semantics.
- Nonzero exits, timeouts, or sandbox denials are treated strictly as `UNKNOWN` or `BLOCKED`.
- Empty output from a failing command is never interpreted as clean repository state or passing tests.

---

## 5. Direct Action Fast Path

When the user requests routine operations (e.g. status, diff, running a named test, committing, pushing):
- Bypasses worker spawning and acceptance ceremonies.
- Executes directly in Sol with minimal tools.
- Halts immediately on nonzero exits.

---

## 6. Native parity modules (0.8)

Milestone M adds provider-native Codex implementations for:

- first-class Evidence Contract verification and delegated evidence federation;
- read-only Evidence Inspector and explicit remote-CI watch steps;
- Attributable Feedback Plane;
- side-effect/context Trust Boundary;
- bounded Luna Medium Mechanical Fast Path;
- mandatory-core, bounded-reference Context Packet with output/search guards;
- zero-authority Dream replay/shadow with explicit human Canary approval;
- managed `.codex` install/update/doctor/diff/backup/rollback lifecycle.

These modules live under `.codex/astra-orchestra/` and never import
Antigravity operational code.

Provider-native transcript management remains owned by Codex. Orchestra stores
only bounded factual sidecars under project-owned `.codex/orchestra-*/`
namespaces.

---

## 7. Project runtime management

For an existing Codex project:

```bash
node scripts/orchestra-codex-project.mjs update /path/to/project --dry-run
node scripts/orchestra-codex-project.mjs update /path/to/project
node scripts/orchestra-codex-project.mjs doctor /path/to/project
node scripts/orchestra-codex-project.mjs version /path/to/project
node scripts/orchestra-codex-project.mjs diff-runtime /path/to/project
node scripts/orchestra-codex-project.mjs evidence /path/to/project
node scripts/orchestra-codex-project.mjs rollback /path/to/project --backup latest
```

The manager owns only `.codex/config.toml`, `.codex/hooks.json`, `.codex/agents/`, and
`.codex/astra-orchestra/`. State, telemetry, artifacts, semantic approval
data, and runtime-management history remain project-owned and survive updates.
The neutral `.orchestra/state/**` Work Lease namespace is also project-owned,
preserved across runtime replacement, and locally ignored through managed
`.git/info/exclude` rather than a tracked `.gitignore` entry.

---

## 8. Work Lease authority and session recovery

Orchestra 1.x treats Codex `session_id` as **provenance**, not permanent project
ownership. Primary project authority is the provider-neutral, generation-fenced
Work Lease stored under `.orchestra/state/work-lease.json`.

With `ORCHESTRA_AUTHORITY_MODE` unset or empty, Codex now resolves authority to
`lease`. The supported migration/rollback values remain:

- `lease` — primary 1.x authority. A fresh root may continue compatible factual
  work when no incompatible writer is active.
- `dual` — compatibility mode that evaluates Work Lease authority while retaining
  the legacy session record for provenance and migration diagnostics.
- `session` — temporary rollback mode using the 0.10 session authority path.

An invalid explicit value fails safe to `session` rather than silently granting
new authority.

Each root actor is persisted only as provider plus a stable hash of the factual
`session_id`. A Work Lease generation is the mutation fence. After another root
advances the generation, the former root is denied as `STALE_WORK_LEASE`. While
an actor holds `WORKSPACE_EDIT`, an incompatible fresh root cannot take over and
receives `WRITE_LEASE_ACTIVE`. Once mutation authority is released back to
`CONTROL`, another fresh root may atomically advance the generation and continue
candidate/evidence-bound work without a prepared chat handoff.

Continuation is factual and bounded: task/work state, candidate identity,
evidence/audit references, generation, blockers, and approved direction may
survive. Provider transcript, prompts, summaries, arbitrary prior conversation
text, and hidden reasoning never grant continuation authority.

The legacy boundary command remains available only for recovery/debug or an
explicit rollback workflow:

```bash
node .codex/astra-orchestra/session-handoff-cli.mjs prepare --boundary
```

It is no longer the normal way to move development into a fresh Codex chat in
`lease` mode. In explicit `session` rollback mode it retains the 0.10
single-use, workspace/state-bound `ACTIVE -> TRANSFERRING -> ACTIVE` semantics
and still performs a clean milestone boundary rather than transcript migration.

Project-local hooks remain subject to Codex's normal hook-trust review; Orchestra
does not use a trust bypass as part of normal operation.

---

## 9. Testing & Verification

Run the complete deterministic Codex verification:

```bash
npm run test:codex
npm run test:leases
npm run test:architecture-invariants
node --test tests/installers/codex-project-runtime-manager.test.mjs
```
