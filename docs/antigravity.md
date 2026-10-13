# Antigravity (AGY) Runtime Guide

The Antigravity runtime provides a 100% **ALL-GEMINI** local multi-agent architecture integrated directly with the Antigravity CLI and IDE engine. Optional cross-provider delegation is executed outside that provider-native tree through Orchestra's neutral delegation runtime, so the AGY control plane itself remains provider-pure.

---

## 1. Architecture & Model Roles

```text
GEMINI 3.8 FLASH MEDIUM (Global Orchestrator)
  ├─ Intake & classification
  ├─ Investigation → FLASH HIGH (isolated subagent, read-only)
  ├─ Implementation → FLASH LOW | MEDIUM | HIGH
  ├─ Critical review → TWO-KEY REVIEW (Two independent Flash High reviewers)
  └─ Fast path → DIRECT_ACTION (single command, zero subagents)
```

- **Global Orchestrator (`gemini-3.8-flash-medium`)**: Control plane, intent decomposition, scope contracts, state machine transitions, and evidence acceptance.
- **Worker Low (`gemini-3.8-flash-low`)**: Ultra-lightweight worker for documentation, mechanical formatting, and minor fixes.
- **Worker Medium (`gemini-3.8-flash-medium`)**: Primary worker for standard feature implementations and routine bug fixes.
- **Worker High (`gemini-3.8-flash-high`)**: High-complexity implementation worker, algorithm specialist, and deep investigator.
- **Reviewer (`gemini-3.8-flash-high`)**: Independent critical reviewer. In Two-Key reviews, Reviewer A verifies correctness and Reviewer B performs adversarial edge-case analysis.

---

## 2. Tool Lifecycle Hooks (`.agents/hooks/`)

The Antigravity runtime registers lifecycle hooks in `.agents/hooks.json`. The
Work Lease wrappers are the normal root entry points; after applying lease
authority they delegate into the existing governance hooks so provider-neutral
authority does not bypass Antigravity's established enforcement.

1. **`work-lease-pre-tool.mjs` (`PreToolUse`)**:
   - Fences root tool authority by Work Lease generation/capability.
   - Delegated children remain governed by the legacy Antigravity role/scope path.
   - Delegates allowed calls to `pre-tool-enforce.mjs`, which validates Scope Contracts, blocks worker subagent spawning, prevents orchestrator product edits, and enforces file/output/polling guardrails.

2. **`post-tool-telemetry.mjs` (`PostToolUse`)**:
   - Captures command exit codes, test counts, and execution duration automatically into the Evidence Ledger.
   - Increments `mutationSeq` on file modifications and records modified paths.
   - Tracks tool mix, shell overuse, and exploration overhead.

3. **`work-lease-pre-invocation.mjs` (`PreInvocation`)**:
   - Establishes or advances factual root Work Lease authority before model invocation.
   - Projects the current lease root into legacy `mainConversationId` state only for provider compatibility.
   - Delegates normal governance to `pre-invocation-guard.mjs`, including advisory notices, circuit breakers, trust-boundary capsules, and recovery handoff behavior when explicitly requested.

4. **`stop-guard.mjs` (`Stop`)**:
   - Prevents the agent from declaring a task complete unless required verification evidence is fresh and recorded in the Evidence Ledger.

5. **`output-gate-runner.mjs`**:
   - Intercepts large command outputs (>64 KB or >300 lines), saves full logs to `.agents/artifacts/outputs/`, and returns a compact truncated preview packet to the model context.

6. **`verify-batch.mjs`**:
   - Sequenced verification runner that short-circuits on prerequisite failures.

7. **`git-operation.mjs`**:
   - Safe, atomic git transactions (`status`, `diff_summary`, `commit`, `push`, `commit_push`) with sensitive file protection.

---

## 3. Evidence Freshness Invariant

Every validation evidence record carries the `mutationSeq` at the time of execution.
- If subsequent code mutations occur, earlier test evidence is marked **STALE**.
- Scope-aware invalidation ensures that modifying documentation preserves code test freshness, while modifying core logic invalidates dependent integration tests.

---

## 4. Work Lease authority and handoff recovery

Orchestra 1.x no longer treats `mainConversationId` as permanent project
ownership. The factual Antigravity conversation identity is actor provenance;
primary project authority is the provider-neutral, generation-fenced Work Lease
under `.orchestra/state/work-lease.json`.

With `ORCHESTRA_AUTHORITY_MODE` unset or empty, Antigravity resolves to `lease`.
Explicit modes remain available for migration and rollback:

- `lease` — primary 1.x mode. A fresh **root** conversation may continue
  compatible factual work whenever no incompatible writer is active.
- `dual` — migration mode retaining legacy conversation state as provenance and
  compatibility projection while Work Lease authority is evaluated.
- `session` — temporary rollback to the 0.9 handoff/session authority behavior.

Invalid explicit values fail safe to `session`.

Only factual root identities may claim control. Child workers, reviewers, and
investigators cannot acquire root authority merely by possessing a conversation
ID. The neutral lease stores only provider plus a stable conversation-ID hash,
never the raw transcript or conversation content.

Generation is the mutation fence. A stale former root is denied with
`STALE_WORK_LEASE`. An active `WORKSPACE_EDIT` holder protects the workspace and
causes an incompatible fresh root to receive `WRITE_LEASE_ACTIVE`. Once mutation
authority returns to `CONTROL`, a fresh root can atomically advance the lease
generation and continue the factual candidate/evidence lineage without any
prepared chat transfer.

Continuation authority is bounded to factual work state: task identity,
candidate, evidence/audit references, lease generation, blockers, and approved
direction. Transcript, prompts, summaries, arbitrary prior chat text, and hidden
reasoning are never migrated as authority.

The older handoff CLI remains available for explicit recovery/debug and for
`session` rollback mode:

```bash
node .agents/skills/orchestra/orchestrator-handoff-cli.mjs prepare --boundary
node .agents/skills/orchestra/orchestrator-handoff-cli.mjs prepare --live
```

These commands are no longer the normal fresh-chat UX in `lease` mode. Boundary
handoff still resets to `INTAKE` without carrying the prior Scope Contract,
Evidence Ledger, or transcript; live continuation remains a bounded recovery
mechanism and is rejected while incompatible delegated work is active.

Neutral governance state is preserved across runtime updates and locally hidden
using managed `.git/info/exclude`; Orchestra does not add `.orchestra/state/**`
to the project's tracked `.gitignore`.

---

## 5. Verification & Tests

Run the Antigravity and authority suites:

```bash
node --test runtimes/antigravity/tests/routing-policy.test.mjs
node --test --test-concurrency=1 runtimes/antigravity/tests/hooks.test.mjs
npm run test:delegation
npm run test:leases
npm run test:handoff
npm run test:architecture-invariants
```

---

## 6. Cross-Provider Delegation

Antigravity CONTROL may delegate a bounded independent review or an explicitly requested second opinion to Codex through `.orchestra/runtime/delegation/**`. The provider-native `.agents/**` tree remains ALL-GEMINI: it never imports Codex runtime code and never launches the `codex` CLI directly. Its helper crosses only into the neutral Orchestra composition root, which owns the external executor.

The AGY root keeps its Work Lease generation, candidate/evidence authority, acceptance decision, and retry/finish authority. The Codex worker receives a reduced envelope with at most `LOCAL_READ + PROCESS_EXEC` and runs in an ephemeral Git worktree. Recursive delegation and external workspace mutation are forbidden; a dirty delegated worktree fails closed rather than becoming a candidate.

Normal AGY work remains local. Automatic cross-provider routing is reserved for an independent CRITICAL review slot; a user-explicit `SECOND_OPINION` may also cross. A missing or failed Codex target returns a normalized failure to AGY CONTROL. Orchestra does not silently fall back to another provider or treat provider failure as review approval.

Prerequisites are Git worktree support plus an already installed/authenticated `codex` CLI. Discovery uses only version/help surfaces and never installs Codex, authenticates an account, or performs inference. `npm run doctor` reports this optional readiness separately, so an AGY-only project remains structurally healthy when Codex is unavailable.
