# Codex Runtime Guide

The Codex runtime implementation of Orchestra coordinates multi-agent coding tasks within OpenAI Codex environments.

---

## 1. Architecture & Model Roles

The Codex control plane uses tiered OpenAI models:

```text
TERRA MEDIUM (Control Plane)
  ├─ classify action/domain and write scopeContract
  ├─ investigate → TERRA HIGH / XHIGH / MAX
  ├─ implement  → LUNA HIGH (simple) or LUNA MAX (normal)
  ├─ support    → LUNA MEDIUM (explicitly bounded deterministic)
  ├─ critical review → SOL LOW; justified specialist → SOL MEDIUM
  └─ validate evidence, integrate when needed, accept or fail closed
```

- **Terra Medium (`gpt-5.6-terra`, effort: medium)**: Main session control plane. Handles task intake, routing decisions, scope contracts, validation evaluation, and final acceptance.
- **Luna High (`gpt-5.6-luna`, effort: high)**: Implementation worker for small, conventional, and low-risk changes.
- **Luna Max (`gpt-5.6-luna`, effort: max)**: Implementation worker for standard, non-trivial, and complex product implementation.
- **Luna Medium (`gpt-5.6-luna`, effort: medium)**: Bounded deterministic support worker for mechanical tasks, docs, and non-critical formatting.
- **Terra High / XHigh / Max (`gpt-5.6-terra`, effort: high/xhigh/max)**: Escalation ladder for difficult architectural investigations and conflicting evidence. Operates in read-only sandbox mode.
- **Sol Low / Medium (`gpt-5.6-sol`, effort: low/medium)**: Independent critical review and specialist escalation. Sol never implements its own findings.
- **Astra Manual (`gpt-6-astra`, effort: medium)**: **MANUAL ONLY**. Accessible only via an explicitly approved user escalation packet. Automatic fallback or routing to Astra is prohibited.

---

## 2. Configuration (`.codex/config.toml`)

The configuration file is scoped to the repository:

```toml
#:schema https://developers.openai.com/codex/config-schema.json
model = "gpt-5.6-terra"
model_reasoning_effort = "medium"
model_instructions_file = "astra-orchestra/INSTRUCTIONS.md"

[features]
multi_agent = true
multi_agent_v2 = true

[agents]
enabled = true
max_concurrent_threads_per_session = 1
default_subagent_model = "gpt-5.6-luna"
default_subagent_reasoning_effort = "max"
```

---

## 3. Delegation & Scope Contracts

Every delegation to Luna or Terra includes:
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
- Executes directly in Terra with minimal tools.
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

---

## 8. Root session authority and milestone handoff

Orchestra 0.10 binds Codex project authority to the factual provider
`session_id` delivered by project hooks. `SessionStart` establishes or claims
root authority, `UserPromptSubmit` blocks future turns from a former root, and
`PreToolUse` denies supported local/MCP/function tools to sessions that do not
own the current authority record.

At an explicit completed-milestone chat boundary, the current Terra root runs:

```bash
node .codex/astra-orchestra/session-handoff-cli.mjs prepare --boundary
```

The next fresh root claims the lease automatically. The transfer is single-use,
workspace/state-bound, and fail-closed through
`ACTIVE -> TRANSFERRING -> ACTIVE`. A boundary claim resets task state to
`INTAKE` and removes the prior active Scope Contract instead of carrying
scope, evidence, workers, retries, transcript, prompts, or reasoning forward.

The normal user flow requires no copied session ID and no JSON edits. Project
hooks are subject to Codex's normal hook-trust review; Orchestra does not use a
trust bypass as part of normal operation. This milestone does not add an
Orchestra `LIVE_CONTINUATION` mode for Codex.

---

## 9. Testing & Verification

Run the complete deterministic Codex verification:

```bash
npm run test:codex
node --test tests/installers/codex-project-runtime-manager.test.mjs
node --test tests/architecture-invariants/codex-parity-authority.test.mjs tests/architecture-invariants/codex-session-authority.test.mjs
```
