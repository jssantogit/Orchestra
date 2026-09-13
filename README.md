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
│   ├── install-codex.sh      # Installs Codex runtime into target project
│   ├── install-antigravity.sh# Installs Antigravity runtime into target project
│   ├── doctor.sh             # Validates repository health & dependencies
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
This installs `.codex/` with `config.toml`, instructions, 9 custom agents, and the deterministic routing policy.

### For Antigravity (Gemini):
```bash
./scripts/install-antigravity.sh /path/to/your/project
```
This installs `.agents/` with engine hooks, 5 custom agents, and specialized skills.

### Non-Destructive Guarantee:
Neither installer will overwrite existing configurations. If destination files conflict, installation halts immediately and reports the conflict.

---

## Running Verification & Tests

All test suites are 100% deterministic, offline, and require **no API keys**:

```bash
# Run all deterministic tests
node --test runtimes/codex/tests/routing-policy.test.mjs
node --test runtimes/antigravity/tests/routing-policy.test.mjs
node --test --test-concurrency=1 runtimes/antigravity/tests/hooks.test.mjs
node --test tests/cross-runtime/cross-runtime-firewall.test.mjs
node --test tests/installers/installers.test.mjs

# Run cross-runtime firewall scan
node scripts/contamination-check.mjs

# Run the comprehensive doctor
./scripts/doctor.sh
```

---

## License

Licensed under the [Apache License, Version 2.0](LICENSE).
