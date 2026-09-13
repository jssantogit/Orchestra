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
4. `requiredValidation`: Specific test/lint commands.
5. `retryBudget`: Capped retry attempts (default 2).

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

## 6. Testing & Verification

Run the deterministic policy test suite:

```bash
node --test runtimes/codex/tests/routing-policy.test.mjs
```
