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
   │ Sol Medium                │           │ Gemini 3.8 Flash Medium   │
   │  └─ Global Control Plane  │           │  └─ Global Orchestrator   │
   │                           │           │                           │
   │ Luna High / Luna Max      │           │ Flash Low / Med / High    │
   │  └─ Implementation Workers│           │  └─ Implementation Workers│
   │                           │           │                           │
   │ Sol High / XHigh / Max    │           │ Flash High Specialists    │
   │  └─ Investigation Ladder  │           │  └─ Deep Investigation   │
   │                           │           │                           │
   │ Sol Review Low / Medium   │           │ Two-Key Flash Reviewers   │
   │  └─ Critical Review       │           │  └─ Dual-Key Consensus   │
   │                           │           │                           │
   │ Astra Manual Only         │           │ Engine Tool Hooks         │
   │  └─ Explicit User Packet  │           │  └─ Lifecycle Enforcement │
   └───────────────────────────┘           └───────────────────────────┘
```

### 1. Codex Runtime (`runtimes/codex/`)
- Powered by **GPT-6 Sol** for the control plane, investigation, and review, and **GPT-6 Luna** for implementation and support.
- **Astra Manual Only**: GPT-6 Astra is strictly manual-only upon explicit approval of an escalation packet. Automatic fallback or routing to Astra fails closed.
- Integrates via native Codex project configuration (`.codex/config.toml`) and custom agent profiles (`.codex/agents/*.toml`).
- Provider-native hooks bind factual session provenance while the provider-neutral Work Lease owns project authority.

### 2. Antigravity Runtime (`runtimes/antigravity/`)
- Powered by Google Gemini models under a 100% **ALL-GEMINI** architecture.
- Uses **Gemini 3.8 Flash Medium** as orchestrator, with **Flash Low / Medium / High** workers and specialists.
- **Two-Key Critical Review**: High-risk changes require independent consensus from two Flash High reviewers. Disagreement halts to `HUMAN_GATE`.
- Deep lifecycle integration via Antigravity tool hooks (`PreToolUse`, `PostToolUse`, `PreInvocation`, `Stop`).
- Work Lease wrappers fence root authority while preserving existing Antigravity scope/evidence governance for delegated work.

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
   - Both runtimes reconstruct bounded authority from factual runtime state rather than trusting summaries or handoff prose.
   - Remote/public writes are capability-gated and default-deny unless factual authority explicitly permits them.
8. **Governed Recursive Exploration**:
   - Dream can optimize only inside static runtime ceilings and never becomes an authority plane.
   - Full exploration uses isolated sibling workspaces; it never turns the primary project into a multi-writer free-for-all.
   - Learned changes still pass Exact Replay, Shadow, progressive human-approved Canary, and explicit human promotion.
9. **Work Lease Authority**:
   - Provider session/conversation identity is provenance, not permanent project ownership.
   - Work Lease generation is the mutation fence.
   - At most one incompatible `WORKSPACE_EDIT` holder may control a workspace at a time.
   - Fresh roots may continue compatible factual work without transcript migration when no incompatible writer is active.

---

## Work Lease Authority (1.x)

Orchestra 1.x makes the provider-neutral Work Lease the primary project authority across both runtimes.

```text
project lineage
  -> workspace
  -> work unit / candidate
  -> Work Lease generation
       |-> CONTROL
       `-> WORKSPACE_EDIT
```

The canonical lease is stored under `.orchestra/state/work-lease.json`. Claims are atomically serialized, and every mutation-capable actor is fenced by the current lease generation. Provider IDs are persisted only as stable hashes for provenance.

`ORCHESTRA_AUTHORITY_MODE` supports three explicit modes:

- `lease` — primary 1.x authority and the default when the variable is unset or empty;
- `dual` — migration/compatibility mode;
- `session` — temporary rollback to the legacy provider-specific handoff/session authority path.

Invalid explicit values fail safe to `session`.

A fresh root may continue the current factual candidate/evidence lineage without a prepared handoff when no incompatible writer is active. A live `WORKSPACE_EDIT` holder blocks takeover with `WRITE_LEASE_ACTIVE`; after another compatible root advances the lease generation, stale actors fail as `STALE_WORK_LEASE`.

Continuation is deliberately bounded to factual task/work state, candidate identity, evidence/audit references, blockers, approved direction, and lease generation. Transcript, prompt history, summaries, arbitrary previous-chat prose, and hidden reasoning are never authority inputs.

`.orchestra/state/**` is project-owned volatile governance state. Runtime updates preserve it; product workspace fingerprints exclude it; Orchestra hides it locally through a managed `.git/info/exclude` entry instead of changing the tracked `.gitignore`.

The older Antigravity and Codex session-handoff CLIs remain available as recovery/debug tools and for explicit `session` rollback mode. They are no longer the normal fresh-chat UX in `lease` mode.

---

## Repository Structure

```text
Orchestra/
├── README.md
├── LICENSE
├── SECURITY.md
├── CONTRIBUTING.md
├── AGENTS.md
├── core/                     # Provider-neutral contracts, acceptance and Work Lease authority
├── runtimes/
│   ├── codex/                # OpenAI/Codex runtime
│   └── antigravity/          # Gemini/Antigravity runtime
├── schemas/                  # Canonical schemas
├── shared/                   # Shared principles/contracts/templates
├── docs/                     # Engineering and architecture guides
├── scripts/                  # Install/update/doctor/contamination tooling
└── tests/                    # Core, lease, invariant, firewall and installer suites
```

---

## Quick Start & Installation

### Codex

```bash
./scripts/install-codex.sh /path/to/your/project
```

For an existing Codex project:

```bash
node scripts/orchestra-codex-project.mjs update /path/to/project --dry-run
node scripts/orchestra-codex-project.mjs update /path/to/project
node scripts/orchestra-codex-project.mjs doctor /path/to/project
node scripts/orchestra-codex-project.mjs version /path/to/project
node scripts/orchestra-codex-project.mjs diff-runtime /path/to/project
```

The Codex manager replaces only managed `.codex` runtime paths. Project-owned provider state and neutral `.orchestra/state/**` survive runtime updates.

### Antigravity

```bash
./scripts/install-antigravity.sh /path/to/your/project
```

For an existing Antigravity project:

```bash
node scripts/orchestra-project.mjs update /path/to/project --dry-run
node scripts/orchestra-project.mjs update /path/to/project
node scripts/orchestra-project.mjs doctor /path/to/project
node scripts/orchestra-project.mjs version /path/to/project
node scripts/orchestra-project.mjs diff-runtime /path/to/project
```

Updates replace only Orchestra-owned runtime paths and preserve project state, telemetry, Dream data, artifacts, semantic state, runtime-management history, and neutral Work Lease state.

---

## Running Verification & Tests

All deterministic suites are offline and require no model API keys:

```bash
npm test
npm run doctor
npm run check:contamination
```

Focused authority verification:

```bash
npm run test:leases
npm run test:architecture-invariants
npm run test:firewall
npm run test:installers
```

---

## Historical Authority Milestones

### Orchestrator Session Handoff (0.9)

Milestone 0.9 introduced factual Antigravity root-conversation transfer. Its single-use boundary/live handoff machinery remains supported for recovery/debug and explicit `session` rollback mode. Work Lease authority supersedes it as the normal 1.x fresh-root path.

### Codex Root Session Authority (0.10)

Milestone 0.10 introduced factual Codex `session_id` authority and a single-use milestone-boundary transfer. In 1.x, that session identity remains provenance and rollback compatibility state; Work Lease generation is the primary authority fence.

---

## License

Licensed under the [Apache License, Version 2.0](LICENSE).
