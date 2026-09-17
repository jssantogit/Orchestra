# Orchestra — Antigravity (AGY) Runtime

This directory contains the Google Antigravity (AGY) / ALL-GEMINI implementation of the Orchestra multi-agent orchestration framework.

```text
GEMINI 3.8 FLASH MEDIUM (Global Orchestrator & Control Plane)
  ├─ state transitions: INTAKE -> CLASSIFIED -> PLANNED -> DELEGATED -> EXECUTING -> EVIDENCE_READY -> ACCEPTANCE
  ├─ investigate → GEMINI 3.8 FLASH HIGH (isolated, strictly read-only)
  ├─ implement   → FLASH LOW (docs/mechanical) | FLASH MEDIUM (normal) | FLASH HIGH (complex/integration)
  ├─ critical review → TWO-KEY REVIEW (Two independent Flash High reviewers; consensus required)
  ├─ fast path   → DIRECT_ACTION (1-3 tool calls, zero subagents, exact intent boundary)
  └─ validation  → Evidence Ledger, freshness tracking, verification batch, output gate
```

---

## 1. Prerequisites

- Google Antigravity CLI (`agy`) or Antigravity IDE.
- Node.js v18+ (for hook execution, routing policies, and deterministic tests).

---

## 2. Directory Layout & Architecture

### Source & Runtime Files (Committed)
- `.agents/hooks.json` — Declares tool lifecycle hooks registered with the Antigravity engine.
- `.agents/hooks/` — Lifecycle enforcement scripts:
  - `pre-tool-enforce.mjs`: Enforces scope contracts, path boundaries, worker subagent restrictions, large file guard, and polling budgets.
  - `post-tool-telemetry.mjs`: Captures tool telemetry, execution metrics, mutation sequences, and Evidence Ledger records.
  - `pre-invocation-guard.mjs`: Injects advisory notices, circuit breakers (loop, stall, coordination overhead), and native-tools-first guidance.
  - `stop-guard.mjs`: Blocks model completion claims unless verified evidence is recorded in the Evidence Ledger.
  - `output-gate-runner.mjs`: Truncates large stdout/stderr before entering context, redirecting to artifact files.
  - `verify-batch.mjs`: Executes sequenced verification commands with dependency short-circuiting.
  - `git-operation.mjs`: Atomic, deterministic git transaction runner for status, staging, committing, and pushing.
- `.agents/agents/` — 5 agent definitions:
  - `flash-orchestrator.md`: Global control plane (Flash Medium).
  - `flash-low-worker.md`: Ultra-lightweight worker for docs, formatting, and trivial fixes (Flash Low).
  - `flash-medium-worker.md`: Standard implementation worker (Flash Medium).
  - `flash-worker.md`: High-complexity worker and investigation specialist (Flash High).
  - `flash-reviewer.md`: Independent reviewer for Two-Key reviews (Flash High).
- `.agents/skills/orchestra/` — Pure deterministic routing policy and state machine governance.
- `.agents/skills/{critical-review,evidence-validation,implementation-contract,integration,progressive-testing}/` — Specialized modular runbooks.
- `.agents/dream/` — Dream Layer Foundation components (canonicalization, deterministic snapshots, record-only decision/outcome instrumentation, world sealing, discovery trees, prefix-only exact replay, 8-tier lexicographic evaluation).

### State & Telemetry Generated at Execution (DO NOT COMMIT / Ignored)
- `.agents/state/` — Ephemeral run state (`active-state.json`, `active-contract.json`, execution records).
- `.agents/state/dream/` — Ephemeral dream correlation files (`pending-decisions/`) and workspace hash cache (`workspace-hash-cache.json`).
- `.agents/telemetry/` — Telemetry events (`events.jsonl`).
- `.agents/artifacts/outputs/` — Truncated command outputs (`output-*.log`).
- `.agents/dream-data/` — Durable offline sealed worlds (`sealed-worlds/*.json`).

---

## 3. ALL-GEMINI Model Routing Matrix

| Role | Profile / Model | Reasoning Effort | Duties |
| :--- | :--- | :--- | :--- |
| **Global Orchestrator** | `gemini-3.8-flash-medium` | `medium` (Main Agent) | Intake, state transitions, scope contracts, acceptance |
| **Worker (Low)** | `gemini-3.8-flash-low` | `low` (`flash_lite`) | Minor docs, typos, formatting, simple deterministic fixes |
| **Worker (Medium)** | `gemini-3.8-flash-medium` | `medium` (`flash`) | Normal feature work, bug fixes, routine testing |
| **Worker (High)** | `gemini-3.8-flash-high` | `high` (`pro`) | Complex algorithms, multi-file refactoring, integration |
| **Investigation Specialist** | `gemini-3.8-flash-high` | `high` (`pro`) | Falsifiable hypothesis testing (strictly read-only) |
| **Two-Key Reviewers** | `gemini-3.8-flash-high` | `high` (`pro`) | Independent correctness and adversarial review |

---

## 4. Key Runtime Mechanisms (Efficiency Passes v1–v5)

1. **Output Gate & Large File Guard**:
   - Commands producing >64 KB or >300 lines are intercepted before entering context. Full outputs are saved to disk artifacts, while context receives a compact preview.
   - Large file dumps (`cat file.bin`, `jq '.' huge.json`) on files >200 KB are blocked by `pre-tool-enforce.mjs`.

2. **Reactive Wakeup & Polling Discipline**:
   - Long commands run as background tasks. The agent yields control instead of polling `manage_task(Action='status')` in a loop.
   - Polling is capped to prevent coordination overhead.

3. **Evidence Ledger & Evidence Freshness**:
   - Tool execution facts (exit code, test counts, duration) are automatically recorded by `post-tool-telemetry.mjs`.
   - Each mutation increments `mutationSeq`. Test evidence is marked stale if subsequent mutations touch affected code paths.

4. **Two-Key Critical Review**:
   - High-risk changes (`criticality == CRITICAL`) require approval from two independent Flash High reviewers (`flash-reviewer` A and B). Any disagreement halts to `HUMAN_GATE`.

5. **Direct Action Fast Path**:
   - Operational intents ("status", "diff", "test", "commit", "push") transition directly to `DIRECT_ACTION` with zero subagents and strict side-quest prevention.

---

## 5. Dream Layer Foundation & Declarative Static Policy (Milestones A–D)

The Antigravity runtime incorporates the Orchestra Dream Layer (Milestones A–D) for offline, model-free recursive policy evaluation and deterministic declarative policy execution:

- **Declarative Static Policy Engine (Milestone D)**: Evaluates `static-policy-v1.json` via pure policy engine [`policy-engine.mjs`](file:///root/projects/Orchestra/runtimes/antigravity/.agents/dream/policy-engine.mjs) for eligible decisions (`WORKER_TIER`, `INVESTIGATION_STRATEGY`, `RETRY_ACTION`).
- **100% Shadow Parity & Coverage**: Evaluated across 688 eligible state combinations with 100% explicit policy coverage and 100% action parity.
- **Fail-Safe Fallback**: Any policy conflict, invalid action, or parsing error falls back immediately to `STATIC_ROUTING_FALLBACK` without interrupting task execution.
- **Zero Online Turn Overhead**: Telemetry and declarative policy evaluation run synchronously in hooks (<0.2 ms overhead) with zero online model turns and zero tokens consumed.
- **Fail-Open Telemetry**: Telemetry capture errors record diagnostic markers in ephemeral state and fall back safely to static routing without blocking user tasks.
- **World Sealing & Exact Replay**: Sealed execution worlds are verified against workspace hashes and Evidence Ledger provenance. Exact replay executes strictly offline with zero model calls and returns `UNKNOWN_BRANCH` for unobserved paths.
- **No Context Contamination**: Historical discovery trajectories never enter online prompt context.

For architecture and specification details, see [docs/dream-layer.md](../../docs/dream-layer.md).

---

## 6. Verification & Tests

Run the Antigravity test suites:

```bash
# Deterministic routing policy test
node --test runtimes/antigravity/tests/routing-policy.test.mjs

# Deterministic hook lifecycle test (run with concurrency 1)
node --test --test-concurrency=1 runtimes/antigravity/tests/hooks.test.mjs

# Dream Layer Foundation unit and integration tests (63 tests)
npm run test:dream
# or directly:
node --test runtimes/antigravity/.agents/dream/dream.test.mjs
```

---

## 7. Limitations

- Requires Google Antigravity environment with support for tool hooks (`PreToolUse`, `PostToolUse`, `PreInvocation`, `Stop`).
- Does not permit external model fallbacks (Claude, GPT, or Sonnet).
