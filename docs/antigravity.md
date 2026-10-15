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

Antigravity CONTROL may use the neutral `.orchestra/runtime/delegation/**` plane for two distinct contracts. V1 remains read-only for independent review and explicit `SECOND_OPINION`. V2 permits **explicit CONTROL-selected implementation** by Codex; normal AGY implementation remains local unless that cross-provider intent is set. The provider-native `.agents/**` tree remains ALL-GEMINI and never imports Codex runtime code or launches `codex` directly.

The AGY root keeps its Work Lease generation, mutation fence, candidate/evidence authority, acceptance, retry, publication, and finish authority. A v2 Codex implementer receives exactly `LOCAL_READ + PROCESS_EXEC + WORKSPACE_EDIT`, limited to the broker-enforced mutation scope, with worker network authority and recursive delegation forbidden.

Read-only v1 runs continue in an external ephemeral Git worktree and fail closed on target-side mutation. Mutable v2 runs execute in an **independent hardened local clone** outside the canonical checkout with no hardlinks/alternates/remotes and isolated Git configuration. Orchestra derives the actual worker delta, validates scope and Git boundaries, seals it under `.orchestra/state/delegation/artifacts/**`, and returns a `READY_FOR_REVIEW` Mutation Artifact rather than Candidate/Evidence/Acceptance state.

AGY CONTROL may inspect and independently verify the retained clone before explicitly promoting or discarding the artifact. Promotion requires the original AGY CONTROL actor and Work Lease generation, checks canonical source/Git freshness and artifact integrity, and applies only the sealed worker delta while preserving any pre-existing canonical staged/unstaged/untracked baseline. A missing/failed Codex target, stale/tampered artifact, or promotion failure returns bounded failure; Orchestra never silently falls back or interprets failure as approval.

Prerequisites are an already installed/authenticated `codex` CLI plus Git worktree support for review and hardened local-clone support (`git clone --no-hardlinks`) for implementation. Discovery uses only version/help surfaces and performs no authentication or inference. AGY 1.3.5 emits its help surface on stderr; the neutral executor treats bounded stdout and stderr symmetrically while still failing closed on timeout, nonzero exit, or truncation. `npm run doctor` reports review and implementation readiness separately, so an unavailable cross-provider implementation lane does not make an otherwise healthy AGY-only project structurally unhealthy.

---

## 7. Parallel Implementation 2

Antigravity CONTROL may explicitly choose `PARALLEL_2` only after it has resolved exactly two bounded implementation shards with disjoint mutation scopes. Normal AGY Direct Work remains serial and provider-local by default; the mere presence of Codex does not cause fan-out.

The v1 parallel lane uses one AGY implementation worker plus one Codex implementation worker. Both are isolated execution-plane children against the same immutable source snapshot, each in its own hardened clone and each restricted to its own Implementation Packet and `WORKSPACE_ONLY` scope. Ordinary same-provider v2 delegation remains forbidden; the AGY same-provider child is legal only inside the validated two-member parallel group.

When both members succeed, Orchestra revalidates their sealed artifacts, proves factual changed paths are disjoint, composes the two patches inside a fresh third clone, and produces a single Composite Mutation Artifact. AGY CONTROL alone may inspect, promote, or discard that composite. Member artifacts are group-bound and cannot be promoted individually, and the operation never synthesizes Candidate, Evidence, Acceptance, publication, or finish authority.

Failure is atomic from the product workspace's perspective: unavailable provider, member failure, overlap, tamper, composition conflict, stale baseline, or failed promotion yields no partial canonical mutation and no silent serial/manual fallback. `npm run doctor` reports the `parallelImplementation` lane independently and requires both providers to advertise implementation plus hardened clone support. Project runtime updates fail closed while a parallel group is in flight.
