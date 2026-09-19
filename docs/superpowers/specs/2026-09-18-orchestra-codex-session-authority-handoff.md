# Milestone O — Codex Root Session Authority & Boundary Handoff

**Date:** 2026-09-18  
**Target release:** Orchestra 0.10.0  
**Runtime:** Codex only; Antigravity Milestone N remains unchanged.

## Problem

Milestone N introduced governed root-conversation handoff for Antigravity, but Codex was deliberately excluded because Orchestra had no provider-factual session identity to bind. The current Codex hook contract now exposes a factual `session_id` to lifecycle hooks, and subagent hooks use the parent session ID. Codex also exposes `SessionStart`, `UserPromptSubmit`, and `PreToolUse` boundaries.

This makes it possible to add root-session authority without inventing a synthetic conversation ID or importing Antigravity state.

## Goal

A Codex project has exactly one factual root session with Orchestra project authority at a time. At a completed milestone boundary, that root can arm one single-use handoff. The next fresh root session claims it automatically and starts at `INTAKE`; the former root loses future prompt and supported project-tool authority.

The user must not copy a session ID, edit JSON state, or run a repair command in the normal handoff flow.

## Non-goals

- Do not import Antigravity hooks, role bindings, or `mainConversationId` semantics.
- Do not copy provider transcripts, prompts, hidden reasoning, raw logs, Scope Contracts, Evidence Ledgers, worker identities, or retries into the new milestone.
- Do not add automatic `LIVE_CONTINUATION` in this milestone. Mid-task continuation remains provider-native until it has an independently specified trust contract.
- Do not claim that `PreToolUse` covers hosted tools that Codex does not route through that hook.

## Provider-native authority source

The authority source is the `session_id` supplied by Codex hooks. Orchestra persists only a hashed governance record under:

- `.codex/orchestra-state/session-authority.json`
- `.codex/orchestra-state/session-handoff.json`

Both are project-owned state and therefore survive runtime update/rollback. The hook implementation itself is runtime-owned:

- `.codex/hooks.json`
- `.codex/astra-orchestra/session-authority.mjs`
- `.codex/astra-orchestra/session-hook.mjs`
- `.codex/astra-orchestra/session-handoff-cli.mjs`

## Lifecycle

### Bootstrap

On the first trusted `SessionStart`, if no authority record exists and there is no inconsistent armed handoff, the factual hook `session_id` becomes generation 0 of a new Codex Orchestra lineage.

### Normal authoritative session

`SessionStart` returns only a compact identity statement. It does not inject the active Scope Contract or a continuation capsule because the same hook lifecycle can run around subagents and Codex supplies the parent session ID to subagent hooks. Task facts remain in provider-native Orchestra state.

`UserPromptSubmit` and `PreToolUse` check the factual `session_id` against the current authority record.

### Prepare boundary

After explicit user intent to move to a fresh chat and only while runtime state is quiescent, Terra executes:

```text
node .codex/astra-orchestra/session-handoff-cli.mjs prepare --boundary
```

Preparation fails closed when the task is active, CI/evidence watches are pending, authority is mid-transfer, Git identity is unavailable, or governance state is invalid.

The lease binds:

- current factual main session and generation;
- authority record hash;
- bounded active-state fingerprint;
- Git HEAD and index;
- actual bytes/modes of dirty tracked and untracked product files.

Project-owned Orchestra state/telemetry/artifacts/semantic/runtime-management files are excluded from the product workspace fingerprint so preparing the handoff cannot invalidate itself.

### Claim

A different root `SessionStart` attempts to claim an armed lease. Claim is serialized by an exclusive `wx` lock and revalidates authority, state, generation, and workspace fingerprints. The lock records its owner PID; a later claimant may recover it only when the recorded owner is factually gone. A malformed/uninitialized lock is never stolen while fresh and becomes recoverable only after a bounded stale interval.

Successful boundary claim:

1. freezes authority as `TRANSFERRING`;
2. marks the single-use lease `CLAIMED`;
3. replaces task state with a minimal `INTAKE` state;
4. removes the active Scope Contract;
5. publishes the new session as `ACTIVE` factual root authority.

The two-phase `ACTIVE -> TRANSFERRING -> ACTIVE` protocol is fail-closed. During a partial transfer no session may use project tools, and only the reserved candidate can resume the same transaction.

### Former root

After claim:

- future `UserPromptSubmit` from the former root is blocked before a new model turn;
- supported local/MCP/function tool calls are denied by `PreToolUse`;
- subagents inherit their parent session ID, so children of the former root are denied and children of the new root remain aligned with the new authority.

## Context firewall

A fresh root without a valid lease receives only a non-authoritative handoff-required notice. It must not receive current task ID, Scope Contract, evidence, worker identities, retries, or continuation capsule.

The implementation never reads `transcript_path`.

## Hook trust

Project-local Codex hooks are subject to Codex hook trust. The user may need to review/approve the Orchestra project hooks once through Codex's normal hook-trust UI. Orchestra does not bypass this trust boundary in normal operation.

## Managed/runtime ownership

`CODEX_MANAGED_RUNTIME_PATHS` becomes:

```text
.codex/config.toml
.codex/hooks.json
.codex/agents/
.codex/astra-orchestra/
```

`.codex/orchestra-state/` remains project-owned and preserved by install/update/rollback.

## Acceptance criteria

- factual `session_id` bootstrap; no synthetic conversation identity;
- unleased second root cannot use project tools;
- boundary claim resets task authority to `INTAKE` and removes old scope/evidence;
- former root prompt and tool authority are revoked;
- lease is single-use, claim is lock-serialized, and dead-process orphan locks are recoverable without weakening live-lock exclusion;
- dirty file content changes invalidate an armed lease even when porcelain status remains unchanged;
- active CI/evidence watches block prepare;
- partial transfer is fail-closed and resumable only by the reserved candidate;
- Codex runtime manager owns `hooks.json` while state remains preserved;
- doctor, installer, contamination, architecture-invariant, and full CI suites pass.
