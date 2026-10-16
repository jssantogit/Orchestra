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

Codex `install` and `update` also ensure the independent neutral delegation image under `.orchestra/runtime/delegation/**`. This does not make Antigravity part of the Codex runtime: the provider tree remains OpenAI-only and reaches an external provider only through the neutral broker boundary.

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

For read-only troubleshooting, the installed Codex runtime exposes an official
Work Lease diagnostic command:

```bash
node .codex/astra-orchestra/work-lease-diagnostic-cli.mjs --repo-root .
```

The command never claims, advances, repairs, or releases a lease. Successful
diagnostics exit `0` even when the semantic state is `MISSING`, `INVALID`, or
`DENIED`; usage/runtime failures exit `2` with a structured error on stderr. The
JSON result separates lease status, binding status, and authority status so a
missing lease cannot be confused with an invalid store or an authority denial.
Actor-specific diagnosis is optional and may use `--session-id` only with the
factual Codex-provided hook `session_id`; the diagnostic never fabricates one.
The returned `subject` explicitly marks a caller-supplied actor identity as
unverified as the current session, because the standalone diagnostic CLI cannot
observe Codex hook stdin by itself.

Do not derive actor identity from `CODEX_SESSION_ID`, `$env:CODEX_SESSION_ID`, or
any other environment variable. Codex provides the factual current `session_id`
to project hooks in their JSON stdin payload. If that value is not independently
available, omit `--session-id`; the result is lease-only and does not prove or
disprove CONTROL for the current session. During an in-session tool call,
Orchestra's `PreToolUse` hook is the factual authority gate for that current
session: if the tool executes, do not replace that hook decision with a denial
computed against an inferred identity.

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
does not use a trust bypass as part of normal operation. On Windows,
`commandWindows` entries are native PowerShell command bodies because Codex
already executes them through its Windows shell; Orchestra does not nest a
second `powershell -Command` launcher.

---

## 9. Testing & Verification

Run the complete deterministic Codex verification:

```bash
npm run test:codex
npm run test:leases
npm run test:delegation
npm run test:architecture-invariants
node --test tests/installers/codex-project-runtime-manager.test.mjs
```

---

## 10. Cross-Provider Delegation

Codex CONTROL may use the neutral `.orchestra/runtime/delegation/**` plane for two distinct contracts. V1 remains read-only for independent review and explicit `SECOND_OPINION`. V2 allows **explicit CONTROL-selected implementation** by Antigravity; normal implementation remains local unless that cross-provider intent is set. Codex never imports Antigravity runtime code and never launches `agy` directly from `.codex/**`.

Delegation still does not transfer the Codex root Work Lease, generation fence, candidate/evidence authority, acceptance, retry, publication, or finish authority. A v2 AGY implementer receives exactly `LOCAL_READ + PROCESS_EXEC + WORKSPACE_EDIT`, with mutation constrained to a machine-enforced path scope, network authority forbidden, and recursive delegation disabled.

Read-only v1 runs use an external ephemeral Git worktree and still treat any target-side mutation as a capability violation. Mutable v2 runs use an **independent hardened local clone** outside the canonical checkout with no hardlinks/alternates/remotes and an isolated Git configuration. The worker delta is derived by Orchestra, sealed under `.orchestra/state/delegation/artifacts/**`, and returned as `READY_FOR_REVIEW`; it is not a Candidate, Evidence, or Acceptance record.

Codex CONTROL may inspect the retained review workspace, run its own verification, then explicitly promote or discard the sealed artifact. Promotion is separately fenced by the original CONTROL provider/actor hash and Work Lease generation, verifies canonical workspace/Git freshness plus artifact integrity, and applies only the worker delta while preserving pre-existing staged/unstaged/untracked state. Provider failure, stale/tampered artifacts, or unavailable AGY return bounded failure; there is no silent Codex/manual fallback.

Prerequisites are intentionally external to Orchestra: an already installed/authenticated `agy` CLI plus Git worktree support for review and hardened local-clone support (`git clone --no-hardlinks`) for implementation. Discovery uses only version/help surfaces and performs no login or inference. `npm run doctor` reports review and implementation readiness separately, so an unavailable cross-provider implementation lane does not make an otherwise healthy Codex project structurally unhealthy.

---

## 11. Parallel Implementation 2

Codex CONTROL may explicitly choose `PARALLEL_2` only after it has already decomposed one implementation task into exactly two bounded shards with provably disjoint mutation scopes. Serial Direct Work remains the default; two healthy providers by themselves never trigger fan-out.

The intended lane is Codex CONTROL with one Codex implementation worker and one Antigravity implementation worker. Both are execution-plane children: each receives its own Implementation Packet and `WORKSPACE_ONLY` scope, both start from the same source snapshot in independent hardened clones, and neither owns the canonical checkout or Work Lease. Same-provider implementation remains forbidden for ordinary standalone v2 delegation and is permitted only as a member of this validated parallel group.

After execution, Orchestra seals each member delta from factual Git/filesystem state, proves factual `changedPaths` are disjoint, applies both artifacts in deterministic order inside a third isolated composition clone, and seals one Composite Mutation Artifact. Codex CONTROL then uses the neutral parallel lifecycle to inspect, promote, or discard the composite once. Member artifacts cannot be promoted individually.

Any worker failure, provider unavailability, scope/factual overlap, tamper, composition conflict, stale canonical source/Git boundary, or promotion failure closes the group without partial canonical mutation. Orchestra never silently falls back to serial/manual implementation. `npm run doctor` exposes `parallelImplementation` readiness separately; the lane requires hardened clone support plus two implementation-capable providers. Runtime updates are rejected while a parallel group is still in flight.
