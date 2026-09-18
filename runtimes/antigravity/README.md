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
  - `pre-tool-exploration-guard.mjs`: Milestone E sibling-only wrapper. It blocks exploration-ineligible tools, then delegates allowed calls to the normal `pre-tool-enforce.mjs` governance firewall.
  - `post-tool-telemetry.mjs`: Captures tool telemetry, execution metrics, mutation sequences, and Evidence Ledger records.
  - `post-invocation-exploration-guard.mjs`: Sibling-only Milestone E model-call/timeout termination guard, activated by `prepare` rather than in the normal runtime hook topology.
  - `pre-invocation-guard.mjs`: Injects advisory notices, circuit breakers (loop, stall, coordination overhead), and native-tools-first guidance.
  - `stop-guard.mjs`: Blocks model completion claims unless verified evidence is recorded in the Evidence Ledger.
  - `output-gate-runner.mjs`: Truncates large stdout/stderr before entering context, redirecting to artifact files.
  - `verify-batch.mjs`: Executes sequenced verification commands with dependency short-circuiting.
  - `git-operation.mjs`: Atomic, deterministic git transaction runner for status, staging, committing, and pushing.
- `.agents/agents/` — 6 agent definitions:
  - `flash-orchestrator.md`: Global control plane (Flash Medium).
  - `flash-low-worker.md`: Ultra-lightweight worker for docs, formatting, and trivial fixes (Flash Low).
  - `flash-medium-worker.md`: Standard implementation worker (Flash Medium).
  - `flash-worker.md`: High-complexity worker and investigation specialist (Flash High).
  - `flash-reviewer.md`: Independent reviewer for Two-Key reviews (Flash High).
  - `flash-policy-designer.md`: Milestone F offline, tool-less candidate policy designer (Flash High).
- `.agents/skills/orchestra/` — Pure deterministic routing policy and state machine governance.
- `.agents/skills/{critical-review,evidence-validation,implementation-contract,integration,progressive-testing}/` — Specialized modular runbooks.
- `.agents/dream/` — Dream Layer components (canonicalization, deterministic snapshots, decision/outcome instrumentation, world sealing, discovery trees, prefix-only exact replay, lexicographic evaluation, Milestone E exploration, Milestone F offline policy development, Milestone G zero-impact Shadow observation, and Milestone H human-approved Canary/promotion).

### State & Telemetry Generated at Execution (DO NOT COMMIT / Ignored)
- `.agents/state/` — Ephemeral run state (`active-state.json`, `active-contract.json`, execution records).
- `.agents/state/dream/` — Ephemeral dream correlation files (`pending-decisions/`) and workspace hash cache (`workspace-hash-cache.json`).
- `.agents/telemetry/` — Telemetry events (`events.jsonl`).
- `.agents/artifacts/outputs/` — Truncated command outputs (`output-*.log`).
- `.agents/dream-data/` — Durable offline Dream data: sealed worlds, Milestone E BranchSeeds/exploration index, Milestone F datasets/cycles/candidates/evaluations, Milestone G Shadow sessions/support/observations/reports, and Milestone H Canary approvals/sessions/events/reports plus promoted policy versions.

---

## 2.5 Project Runtime Lifecycle

Antigravity installations are versioned and content-addressed. Managed projects receive `.agents/orchestra-runtime.json`.

From the Orchestra checkout:

```bash
node scripts/orchestra-project.mjs update /path/to/project --dry-run
node scripts/orchestra-project.mjs update /path/to/project
node scripts/orchestra-project.mjs doctor /path/to/project
node scripts/orchestra-project.mjs version /path/to/project
node scripts/orchestra-project.mjs diff-runtime /path/to/project
node scripts/orchestra-project.mjs backups /path/to/project
node scripts/orchestra-project.mjs rollback-runtime /path/to/project --backup latest
```

Updates replace only `.agents/{agents,hooks,skills,dream}`, `.agents/hooks.json`, and `GEMINI.md`. They preserve `.agents/{rules,state,telemetry,dream-data,artifacts,runtime-management}`.

The manager creates an automatic pre-update backup and refuses active states such as `EXECUTING`, `DELEGATED`, or `CI_WAIT`. `DONE`, `BLOCKED`, and `HUMAN_GATE` are quiescent so runtime defects can be repaired without resetting project state.

Inside an installed project:

```bash
node .agents/skills/orchestra/project-runtime-cli.mjs doctor
node .agents/skills/orchestra/project-runtime-cli.mjs version
node .agents/skills/orchestra/project-runtime-cli.mjs backups
node .agents/skills/orchestra/project-runtime-cli.mjs evidence
```

See [Project Runtime Management](../../docs/project-runtime.md).

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
| **Offline Policy Designer** | `gemini-3.8-flash-high` | `high` (`pro`) | Tool-less Milestone F candidate JSON policy proposals from sanitized datasets only |

---

## 4. Key Runtime Mechanisms (Efficiency Passes v1–v5)

1. **Output Gate & Large File Guard**:
   - Commands producing >64 KB or >300 lines are intercepted before entering context. Full outputs are saved to disk artifacts, while context receives a compact preview.
   - Large file dumps (`cat file.bin`, `jq '.' huge.json`) on files >200 KB are blocked by `pre-tool-enforce.mjs`.

2. **Reactive Wakeup & Polling Discipline**:
   - Long commands run as background tasks. The agent yields control instead of polling `manage_task(Action='status')` in a loop.
   - Polling is capped to prevent coordination overhead.

3. **Typed Evidence Ledger & Evidence Freshness**:
   - Scope Contracts support both legacy `testsRequired` and first-class `requiredEvidence`.
   - Local command facts remain factual worker evidence; optional Gradle test/build/lint commands are classified normally when a project chooses local validation.
   - Runtime-owned `LOCAL_FACT` evidence can verify mechanical facts such as `FILE_EXISTS`, `GIT_IGNORED`, `GIT_CLEAN`, and `EXPECTED_FILE_MODIFIED` without requiring ceremonial shell commands from a worker.
   - `REMOTE_CI` providers are selected through the Evidence Provider Registry. `GITHUB_ACTIONS` is the first built-in provider and must match the factual origin repository, workflow, current HEAD/ref, and every required job. A model saying "CI green" is never evidence.
   - Remote CI still running creates a persistent provider watch and enters `CI_WAIT`. The Stop Guard returns `stop` so the model does not poll. A detached Node runner follows provider backoff/deadline and may move the task only to `EVIDENCE_READY` when terminal evidence arrives.
   - If the background runner is unavailable or disabled, the persisted watch remains authoritative and later invocations poll only after `nextPollAt`.
   - Each mutation increments `mutationSeq`. Evidence bound to an older candidate is stale and cannot satisfy acceptance.
   - A WORK/VALIDATION child that owes a local command cannot terminate until the factual command result is present in the Ledger.
   - Delegated local evidence is promoted into parent acceptance only after factual `RUNTIME_IDENTITY` correlation. The federated record carries task, attempt, mutation, producer/role, parent conversation, and candidate-commit binding; reviewer claims and model text cannot satisfy this path.
   - Distinct factual executions remain distinct Ledger records even when they run the same command; command text is not an evidence identity.

4. **Two-Key Critical Review**:
   - High-risk changes (`criticality == CRITICAL`) require approval from two independent Flash High reviewers (`flash-reviewer` A and B). Any disagreement halts to `HUMAN_GATE`.

5. **Direct Action Fast Path**:
   - Operational intents ("status", "diff", "test", "commit", "push") transition directly to `DIRECT_ACTION` with zero subagents and strict side-quest prevention.

6. **Mechanical Fast Path**:
   - This is distinct from `DIRECT_ACTION`: the Orchestrator still never edits workspace/product files.
   - Eligibility is conservative: `MECHANICAL_FIX`, `NORMAL`, first attempt, at most four concrete nonsensitive target files, `flash-low-worker`, no required local shell/test command, and a structured `LOCAL_FACT` contract with at least one outcome fact (`FILE_EXISTS`, `FILE_NOT_EXISTS`, `EXPECTED_FILE_MODIFIED`, or `GIT_IGNORED`).
   - Runtime enforcement permits one implementation worker, reads only of declared targets, bounded native mutations, then handoff. Search, shell/status/test ceremony, extra validators/reviewers, and additional subagents are denied while active.
   - Acceptance is unchanged: Stop Guard collects the runtime facts and verifies the ordinary Evidence Contract before `DONE`. Failed/stale/unavailable evidence exits the fast path into normal retry/replan/fail-closed handling.
   - Sensitive mutation targets such as governance, workflows, security/auth, deployment/release, migrations/database, billing/payment, infrastructure, and lockfiles never enter this path.

---

## 5. Dream Layer Recursive Policy Lifecycle (Milestones A–H)

The Antigravity runtime incorporates the Orchestra Dream Layer (Milestones A–H) for factual history, deterministic replay, bounded exploration, offline policy development, zero-impact Shadow, human-approved Canary, and explicit policy promotion:

- **Real Online Policy Authority (Milestone D Corrective Closure)**: PreToolUse hook enforces `RECORDED_CHOSEN_ACTION == ACTUAL_EXECUTED_ACTION`. Invocations diverging from policy action are deterministically denied pre-execution without recording false DECISION events.
- **Three Decision Points**: Strict policy governance over `WORKER_TIER`, `INVESTIGATION_STRATEGY` (enforced gate before implementation), and `RETRY_ACTION` (governs retry path and enforces retry budget monotonicity).
- **Declarative Static Policy Engine & Two-Layer Verification**: Evaluates `static-policy-v1.json` via pure policy engine [`policy-engine.mjs`](.agents/dream/policy-engine.mjs). Combines standard Draft 2020-12 Structural Schema (`policy-v1.schema.json`) with Normative Semantic Validation (`validatePolicy()`) enforcing relational constraints (`min <= max`), rule ID uniqueness, content-addressed `policy_id`, and canonical size limits.
  *Note: Structural constraints are aligned with policy-v1.schema.json; validatePolicy additionally enforces normative semantic invariants that standard Draft 2020-12 cannot express directly.*
- **100% Shadow Parity & Coverage**: Verified across all eligible state combinations against the production router (`decideRoute` -> `classifyBaselineDecision`).
- **Factual Fallback & Self-Host Isolation**: Policy loads relative to `import.meta.url` isolating active self-host execution from repository edits. Fallback attributes `STATIC_ROUTING_FALLBACK` with exact diagnostics covering all 9 failure modes.
- **Zero Online Turn Overhead**: Telemetry and declarative policy evaluation run synchronously in hooks (<0.2 ms overhead) with zero online model turns and zero tokens consumed.
- **Fail-Open Telemetry**: Telemetry capture errors record diagnostic markers in ephemeral state and fall back safely to static routing without blocking user tasks.
- **World Sealing & Exact Replay**: Sealed execution worlds are verified against workspace hashes and Evidence Ledger provenance. Exact replay executes strictly offline with zero model calls and returns `UNKNOWN_BRANCH` for unobserved paths.
- **No Context Contamination**: Historical discovery trajectories never enter online prompt context.
- **Explicit Exploration Lab (Milestone E)**: An opt-in CLI can capture a prospective BranchSeed and materialize exactly one physical sibling for a deterministic `UNKNOWN_BRANCH`. The lab is isolated from the primary workspace, caps execution at one sibling / two model calls / five minutes, excludes CRITICAL and Human Gate states, requires explicit approval for MAJOR, blocks external side effects, regenerates ephemeral runtime identity, and never auto-promotes policy. The committed A-D hook topology remains unchanged while exploration is OFF; E hook overlays exist only in the prepared sibling.
- **Prospective Physical Seeds**: A-D historical snapshots remain valid for Exact Replay, but physical exploration requires a Milestone E BranchSeed because older DECISION records intentionally do not contain the complete workspace payload/Scope Contract.
- **Offline Policy Lab (Milestone F)**: Builds a deterministic sanitized `PolicyDevelopmentDataset`, freezes root lineages into an 80/20 TRAIN/HOLDOUT split, accepts at most two tool-less designer calls with up to four candidate JSON policies per call, and evaluates baseline/candidates through zero-model-call Exact Replay. Unsupported divergence is `NEEDS_EXPLORATION`; candidate artifacts never modify the active policy or online hooks.
- **Zero-Impact Shadow Mode (Milestone G)**: Explicitly selected F candidates compute a private action only after the factual DECISION is published. Baseline execution remains authoritative; candidate actions never enter telemetry/model context or Scope Contract. CRITICAL/HUMAN_GATE are excluded. Canary review requires >=50 eligible decisions and <=20% UNKNOWN divergences; G never executes the candidate.
- **Human-approved Progressive Canary (Milestone H+)**: A ready Shadow report may enter a 5% rollout only after explicit human confirmation. The same deterministic task-ID bucket expands through nested 5% → 20% → 50% → 100% cohorts; every stage advance requires a fresh Canary report and a separate human `--confirm`. Only NORMAL/local/reversible/noncritical tasks are eligible; Two-Key, external-side-effect and critical-path work is excluded. Policy/schema errors, illegal actions, governance attempts, evidence bypass, or exact proven regressions immediately roll Canary back to baseline routing.
- **Human-only Promotion**: Stage reports can only request the next human rollout approval; they never advance themselves. A healthy, fully observed 100% stage may produce `READY_FOR_HUMAN_PROMOTION_REVIEW`, not activation. A separate explicit human confirmation writes the content-addressed policy version and atomically replaces `.agents/dream-data/policies/active.json`; corruption falls back to static policy. Future Policy Lab cycles use the promoted active policy as baseline. Promoted-policy rollback is separately human-confirmed, restores the recorded predecessor, preserves all policy versions, and appends a `POLICY_ROLLBACK` history event.

For architecture and specification details, see [docs/dream-layer.md](../../docs/dream-layer.md).

---

## 6. Verification & Tests

Run the Antigravity test suites:

```bash
# Deterministic routing policy test
node --test runtimes/antigravity/tests/routing-policy.test.mjs

# Deterministic hook lifecycle test (run with concurrency 1)
node --test --test-concurrency=1 runtimes/antigravity/tests/hooks.test.mjs

# First-class local/remote evidence contract regressions
npm run test:evidence

# Dream Layer unit and integration tests, including Milestones E–H
npm run test:dream
# or directly:
node --test runtimes/antigravity/.agents/dream/dream.test.mjs runtimes/antigravity/.agents/dream/exploration.test.mjs runtimes/antigravity/.agents/dream/policy-lab.test.mjs runtimes/antigravity/.agents/dream/shadow-mode.test.mjs runtimes/antigravity/.agents/dream/canary-mode.test.mjs

# Build/evaluate an offline Milestone F policy-development cycle
npm run dream:policy-lab -- help

# Enable/report zero-impact Milestone G Shadow observation
npm run dream:shadow -- help

# Approve/report/advance/rollback/promote progressive Canary
npm run dream:canary -- help
```

---

## 7. Limitations

- Requires Google Antigravity environment with support for tool hooks (`PreToolUse`, `PostToolUse`, `PreInvocation`, `Stop`).
- Does not permit external model fallbacks (Claude, GPT, or Sonnet).
- Automatic Canary stage advancement and automatic promotion remain forbidden. The supported 5% → 20% → 50% → 100% rollout is human-gated at every transition.
