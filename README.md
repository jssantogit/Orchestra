# Orchestra

> **A local multi-agent orchestration framework for coding agents.**

Orchestra structures autonomous software development through deterministic routing, strict separation of duties, progressive verification, and evidence-driven acceptance.

It is **not** a collection of prompts. Orchestra is a complete architectural framework comprising:
- Executable deterministic policies;
- Machine-enforceable scope contracts;
- Runtime hooks and context guards;
- Offline test suites;
- Two independent, production-tested runtime implementations.

---

## The Dual-Runtime Architecture

Orchestra preserves two independent provider runtimes. They share core principles, contracts, and safety invariants, but maintain completely separate control planes and zero cross-provider contamination:

```text
┌─────────────────────────────────────────────────────────────────────────┐
│                           ORCHESTRA FRAMEWORK                           │
└────────────────────────────────────┬────────────────────────────────────┘
                                     │
                 ┌───────────────────┴───────────────────┐
                 │                                       │
                 ▼                                       ▼
   ┌───────────────────────────┐           ┌───────────────────────────┐
   │       CODEX RUNTIME       │           │    ANTIGRAVITY RUNTIME    │
   │   (OpenAI Ecosystem)      │           │    (Gemini Ecosystem)     │
   ├───────────────────────────┤           ├───────────────────────────┤
   │ Terra Medium              │           │ Gemini 3.8 Flash Medium   │
   │  └─ Global Control Plane  │           │  └─ Global Orchestrator   │
   │                           │           │                           │
   │ Luna High / Luna Max      │           │ Flash Low / Med / High    │
   │  └─ Implementation Workers│           │  └─ Implementation Workers│
   │                           │           │                           │
   │ Terra High / XHigh / Max  │           │ Flash High Specialists    │
   │  └─ Investigation Ladder  │           │  └─ Deep Investigation   │
   │                           │           │                           │
   │ Sol Low / Sol Medium      │           │ Two-Key Flash Reviewers   │
   │  └─ Critical Review       │           │  └─ Dual-Key Consensus   │
   │                           │           │                           │
   │ Astra Manual Only         │           │ Engine Tool Hooks         │
   │  └─ Explicit User Packet  │           │  └─ Lifecycle Enforcement │
   └───────────────────────────┘           └───────────────────────────┘
```

### 1. Codex Runtime (`runtimes/codex/`)
- Powered by OpenAI models: **Terra Medium** (control plane), **Luna High / Max** (workers), **Luna Medium** (support), **Terra High / Max** (investigation), and **Sol Low / Medium** (critical review).
- **Astra Manual Only**: GPT-6 Astra is strictly manual-only upon explicit approval of an escalation packet. Automatic fallback or routing to Astra fails closed.
- Integrates via native Codex project configuration (`.codex/config.toml`) and custom agent profiles (`.codex/agents/*.toml`).
- **0.8 Runtime Parity** adds Codex-native factual Evidence Contracts/Federation, Feedback Plane, side-effect Trust Boundary, bounded context packets, Mechanical Fast Path, isolated Dream replay/shadow, and first-class `.codex` lifecycle management.

### 2. Antigravity Runtime (`runtimes/antigravity/`)
- Powered by Google Gemini models under a 100% **ALL-GEMINI** architecture.
- Uses **Gemini 3.8 Flash Medium** as orchestrator, with **Flash Low / Medium / High** workers and specialists.
- **Two-Key Critical Review**: High-risk changes require independent consensus from two Flash High reviewers. Disagreement halts to `HUMAN_GATE`.
- Deep lifecycle integration via Antigravity tool hooks (`PreToolUse`, `PostToolUse`, `PreInvocation`, `Stop`).

---

## Core Invariants

1. **Separation of Duties**:
   - The Orchestrator plans, scopes, and accepts work, but **never** writes product code directly.
   - Workers implement bounded scopes, but **never** spawn subagents or accept their own work (`IMPLEMENTATION_COMPLETE` is an evidence claim, never `TASK_ACCEPTED`).
2. **Tool Truthfulness ("FAILED TOOL IS NOT EVIDENCE")**:
   - Every claim requires a command exit code of `0` and verified output semantics.
   - Nonzero exits, timeouts, and sandbox denials are strictly `UNKNOWN` or `BLOCKED`. Empty output from a failing command is never "clean" or "passing".
3. **References Over Replication (Context Diet)**:
   - Workers receive file paths, line ranges, and symbols, not raw file dumps or full diffs.
   - The **Output Gate** truncates outputs >64 KB / >300 lines before they enter context, saving raw logs to disk.
   - The **Large File Guard** blocks dumping files >200 KB into context.
4. **Bounded Delta Retries**:
   - Retries are capped (default 2 attempts).
   - Blind retries are forbidden: each retry packet provides the exact failing assertion, root cause, targeted fix, and preserved work.
   - Budget exhaustion halts safely to a `HUMAN_GATE`.
5. **Direct Action Fast Path**:
   - Routine operational tasks (git status, diff, run a specific test, commit, push) execute in 1-3 tool calls with zero subagents and strict side-quest prevention.
6. **Cross-Runtime Firewall**:
   - Codex active runtime strictly rejects routes or dependencies on Gemini/Flash.
   - Antigravity active routing strictly rejects routes to GPT models.
   - Validated continuously via automated firewall test suites.
7. **Attributable Feedback & Context Trust**:
   - Hypotheses and experiments remain model claims until bound to factual runtime evidence.
   - Both runtimes reconstruct bounded authority from factual runtime state rather than trusting summaries or handoff prose; Codex uses its native continuation/trust modules while Antigravity enforces the same property through hooks.
   - Remote/public writes are capability-gated and default-deny unless factual authority explicitly permits them.
8. **Governed Recursive Exploration**:
   - Antigravity Dream can optimize isolated branching, bounded parallelism, pruning, and stopping only inside static runtime ceilings; Codex Dream remains an isolated offline/shadow lab with one active exploration branch and human-only Canary approval.
   - Full exploration composes sandboxed sibling workspaces; it never turns the primary project into a multi-writer free-for-all.
   - Learned exploration changes still pass Exact Replay, Shadow, progressive human-approved Canary, and explicit human promotion.

---

## Repository Structure

```text
Orchestra/
├── README.md                 # Public documentation & architecture overview
├── LICENSE                   # Apache 2.0 License
├── SECURITY.md               # Tool execution & security considerations
├── CONTRIBUTING.md           # Contribution guidelines & runtime isolation rules
├── AGENTS.md                 # Durable repository rules for Orchestra itself
│
├── runtimes/
│   ├── codex/                # OpenAI/Codex runtime (.codex/, instructions, 9 agents, tests)
│   └── antigravity/          # Gemini/Antigravity runtime (.agents/, hooks, agents, skills, tests)
│
├── shared/
│   ├── principles.md         # Universal architectural principles
│   ├── contracts/            # Scope contract and handoff packet specifications
│   └── templates/            # Generic AGENTS.md template and task domain taxonomy
│
├── docs/                     # Comprehensive engineering guides
│   ├── architecture.md       # High-level architecture
│   ├── codex.md              # Codex operational guide
│   ├── antigravity.md        # Antigravity operational guide
│   ├── routing.md            # Action & domain routing matrix
│   ├── efficiency.md         # Context diet, output gates, and search-to-window
│   ├── reliability.md        # Tool truthfulness and evidence ledger
│   └── isolation.md          # Cross-runtime firewall & privacy guarantees
│
├── examples/
│   └── autoeq-workbench/     # Real-world DSP/numerical example with custom domains
│
├── scripts/
│   ├── install-codex.sh       # Installs Codex runtime into target project
│   ├── install-antigravity.sh # Clean Antigravity install
│   ├── orchestra-project.mjs  # Antigravity install/update/doctor/version/diff/rollback manager
│   ├── orchestra-codex-project.mjs # Codex install/update/doctor/version/diff/rollback manager
│   ├── doctor.sh              # Validates Orchestra repository health
│   └── contamination-check.mjs # Cross-runtime firewall scan
│
└── tests/
    ├── cross-runtime/        # Cross-runtime isolation firewall test suite
    └── installers/           # Fixture-based installation & conflict tests
```

---

## Quick Start & Installation

Install Orchestra into any existing code repository:

### For Codex (OpenAI):
```bash
./scripts/install-codex.sh /path/to/your/project
```
This performs a clean install of `.codex/` with config, instructions, 9 custom
agents, and the native parity modules.

For an existing Codex project, use the managed updater instead of replacing
`.codex` manually:

```bash
node scripts/orchestra-codex-project.mjs update /path/to/project --dry-run
node scripts/orchestra-codex-project.mjs update /path/to/project
node scripts/orchestra-codex-project.mjs doctor /path/to/project
node scripts/orchestra-codex-project.mjs version /path/to/project
node scripts/orchestra-codex-project.mjs diff-runtime /path/to/project
```

The Codex manager replaces only `.codex/config.toml`, `.codex/hooks.json`, `.codex/agents/`, and
`.codex/astra-orchestra/`; project-owned Codex state is preserved.

### For Antigravity (Gemini):
```bash
./scripts/install-antigravity.sh /path/to/your/project
```
This installs `.agents/` with engine hooks, 5 custom agents, and specialized skills.

### Existing Antigravity Projects

Do not reinstall or manually replace `.agents`. Use the project runtime manager:

```bash
# Preview
node scripts/orchestra-project.mjs update /path/to/project --dry-run

# Update with automatic backup
node scripts/orchestra-project.mjs update /path/to/project

# Verify installed runtime
node scripts/orchestra-project.mjs doctor /path/to/project

# Inspect version / drift
node scripts/orchestra-project.mjs version /path/to/project
node scripts/orchestra-project.mjs diff-runtime /path/to/project

# Roll back Orchestra runtime without rewinding project/Dream state
node scripts/orchestra-project.mjs rollback-runtime /path/to/project --backup latest
```

Updates replace only Orchestra-owned runtime paths and preserve project rules, active/history state, telemetry, Dream data, and artifacts. See [Project Runtime Management](docs/project-runtime.md).

### Non-Destructive Guarantee:
Clean installers still refuse existing configurations. Existing Antigravity runtimes must use the updater, which creates a backup before replacing any managed runtime path.

---

## Running Verification & Tests

All test suites are 100% deterministic, offline, and require **no API keys**:

```bash
# Run all deterministic tests
npm run test:codex
node --test runtimes/antigravity/tests/routing-policy.test.mjs
node --test --test-concurrency=1 runtimes/antigravity/tests/hooks.test.mjs
node --test tests/cross-runtime/cross-runtime-firewall.test.mjs
npm run test:installers

# Run cross-runtime firewall scan
node scripts/contamination-check.mjs

# Run the comprehensive doctor
./scripts/doctor.sh
```

---

## License

Licensed under the [Apache License, Version 2.0](LICENSE).

### Semantic Memory Shadow Lab (0.7)

Orchestra includes an optional TypeSafe AI Jev experiment for **semantic priority with zero authority**.

- provider transcripts remain under Claude/Codex/Gemini native context management;
- deterministic candidate generation narrows factual Orchestra memory before Jev;
- outbound projections are bounded, secret-redacted and exclude raw transcripts/stdout/reasoning;
- Jev scores are `authority=NONE` and never satisfy Evidence Contracts, routing, acceptance or Human Gates;
- Dream analysis writes immutable sidecars rather than changing sealed worlds;
- Retrieval Assist is implemented but fail-closed until factual evaluation + matching human approval + local feature flag;
- active Codex/Antigravity runtime files are firewall-tested to reject Jev routing/imports.

See `experiments/jev/README.md` and `docs/superpowers/specs/2026-09-18-orchestra-jev-semantic-memory.md`.


### Codex Runtime Parity (0.8)

Milestone M closes the architectural gap between the two runtimes while
preserving strict provider isolation.

Codex now has native modules for first-class factual evidence, delegated
evidence federation, explicit remote-CI watches, attributable feedback,
side-effect/context trust, bounded mechanical support, reference-oriented
worker packets, zero-authority Dream replay/shadow, and managed `.codex`
updates/backups/rollback.

Parity means equivalent governance guarantees, not identical engine hooks.
Codex does not import Antigravity operational code and does not emulate
Antigravity's hook runtime. See
`docs/superpowers/specs/2026-09-18-codex-runtime-parity.md`.


### Orchestrator Session Handoff (0.9)

Antigravity can now transfer factual root-orchestrator authority between fresh
conversations without manual role-binding edits.

When the user explicitly closes a milestone and chooses to continue in a new
chat, the current root arms a single-use project lease. The next root
conversation claims it automatically on first PreInvocation. The predecessor
is demoted to `FORMER_ORCHESTRATOR` and loses project-tool authority.

The default `MILESTONE_BOUNDARY` mode is a true context boundary: prior active
task ID, Scope Contract, Evidence Ledger and provider transcript are not active
authority in the new conversation; the runtime re-enters `INTAKE`. An
explicit `LIVE_CONTINUATION` mode exists for bounded mid-task context resets.

See
`docs/superpowers/specs/2026-09-19-orchestrator-session-handoff.md`.

### Codex Root Session Authority (0.10)

Milestone O adds the corresponding provider-native root authority boundary to
Codex without inventing a synthetic conversation identity. Orchestra binds
authority to Codex's factual hook `session_id`, manages project hooks through
`.codex/hooks.json`, and preserves the authority/lease records under
project-owned `.codex/orchestra-state/`.

At an explicit completed-milestone boundary, the current Terra root arms a
single-use lease. A fresh root claims it automatically on `SessionStart`,
returns task authority to `INTAKE`, and leaves prior Scope Contract, Evidence
Ledger, workers, retries, transcript, prompts, and hidden reasoning behind.
The former root is blocked before future prompts and denied supported project
tools.

The transfer is workspace/state-bound and fail-closed through
`ACTIVE -> TRANSFERRING -> ACTIVE`. Codex project hooks remain subject to the
provider's normal hook-trust review. Orchestra 0.10 intentionally does not add
a Codex `LIVE_CONTINUATION` mode.
