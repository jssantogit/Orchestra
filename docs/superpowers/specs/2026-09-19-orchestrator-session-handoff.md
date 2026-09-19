# Milestone N — Orchestrator Session Handoff

Date: 2026-09-19

## Problem

Antigravity binds orchestration authority to a factual root `conversationId`.
That protects the runtime from child/session impersonation, but it also makes a
healthy context reset awkward: after a milestone is completed, opening a fresh
root chat leaves the old conversation as `mainConversationId`. The new chat
cannot coordinate the project until an operator manually edits/rebinds state.

Manual role-binding edits are not an acceptable normal workflow.

## Goal

Make a fresh orchestrator chat a first-class governed transition.

The user should be able to finish a milestone, ask to continue in a new chat,
and have Orchestra transfer root orchestration authority without copying the
old transcript or requiring the user to run a Node command manually.

## Permanent principle

> Orchestrator authority belongs to the project lineage, not to the lifetime of
> one provider conversation.

Conversation identity remains factual and provider-specific. Authority may move
between root conversations only through a one-time factual handoff record.

## State

Antigravity persists:

`.agents/state/orchestrator-handoff.json`

Schema:

`orchestra.orchestrator-session-handoff.v1`

The record is project-owned state and is preserved by the runtime updater.

A handoff is a single-use lease with these states:

- `ARMED`
- `CLAIMED`
- `CANCELLED`

It binds:

- current authoritative root conversation;
- orchestrator lineage ID;
- current and target lineage generation;
- a fingerprint of authority-relevant runtime state;
- preparation mode;
- preparation timestamp;
- optional bounded operator reason/label;
- a bounded continuation capsule appropriate to the mode.

The record never contains provider transcript, prompts, hidden reasoning,
stdout/stderr dumps, secrets, environment values, or arbitrary chat history.

## Modes

### MILESTONE_BOUNDARY

Default and recommended.

Preparation requires a quiescent boundary:

- `DONE`
- `BLOCKED`
- `HUMAN_GATE`
- or factual `acceptanceState=ACCEPTED`

No unconsumed subagent delegation or in-flight delegated execution may exist.

The next root chat receives only a boundary capsule:

- lineage/generation;
- previous task ID;
- previous terminal state/acceptance state;
- mutation/attempt counters;
- factual candidate HEAD when available;
- reason/label.

Old Scope Contract, evidence ledger, model summaries, transcript and product
history are deliberately not injected into the fresh chat.

### LIVE_CONTINUATION

Explicit opt-in for a context reset before a task/milestone is terminal.

Still requires no pending/in-flight child execution. It carries the existing
bounded Runtime Continuation Capsule from the Trust Boundary. It remains
factual and reference-oriented, never transcript-based.

This mode must never be selected implicitly when the user asked for a clean
milestone boundary.

## Preparation

When the user explicitly says they are moving development to a fresh chat,
the current root orchestrator should prepare the lease before its final reply.

This is control-plane work. The agent performs the managed runtime operation;
the user must not be instructed to edit role bindings or run a manual Node
repair command during the normal flow.

Preparation is idempotent for the same authoritative root and unchanged state.

Preparation fails closed when:

- no factual main conversation exists;
- a different conversation is already authoritative;
- pending subagents exist;
- delegated/investigation/review/CI work is still in flight;
- boundary mode is requested from non-quiescent state.

## Automatic claim

On the first Antigravity `PreInvocation` of a different root conversation:

1. Load the armed handoff.
2. Verify record hash/schema/status.
3. Verify the old authoritative root still matches `fromConversationId`.
4. Verify the authority-state fingerprint has not changed since preparation.
5. Verify the candidate conversation is a root, not a child/reviewer/worker and
   is not correlated to a pending delegation.
6. Atomically:
   - set `roleBindings.mainConversationId` to the new conversation;
   - bind the new conversation as HIGH-confidence `ORCHESTRATOR` with source
     `ORCHESTRATOR_HANDOFF`;
   - mark the old binding `FORMER_ORCHESTRATOR` and
     `authorityStatus=TRANSFERRED`;
   - update `activeState.conversationId`;
   - advance lineage generation;
   - mark the lease `CLAIMED`;
   - append telemetry.
7. Inject a compact authoritative handoff message/capsule.

The handoff is single-use. A third conversation cannot replay a claimed lease.

## Old-chat behavior after claim

The former root conversation is no longer orchestration authority.

Its retained binding is historical only:

- role: `FORMER_ORCHESTRATOR`
- authority status: `TRANSFERRED`

It may not spawn agents, coordinate children, accept work, mutate workspace
state, or act as the main orchestrator.

All orchestrator-sensitive checks must require both:

- orchestrator role; and
- factual actor ID equal to the current `mainConversationId`.

## Stale lease protection

The handoff records a hash of authority-relevant state. If the old chat
continues development after arming the handoff and changes task identity,
state, acceptance state, attempt, mutation sequence, candidate HEAD, or
governed child/in-flight status, automatic claim fails closed as stale.

The operator/current main may cancel and prepare a new lease.

## Codex

Codex currently has no equivalent engine-level conversation-bound
`mainConversationId` lock, so it does not need an authority rebind to make a
fresh chat usable.

Milestone N therefore does not invent a fake Codex session ID. Codex keeps its
native fresh-chat behavior and existing bounded Context/Continuation Capsule.
If Codex later exposes a factual stable session identifier to the runtime, the
same handoff schema may be adopted without changing the authority model.

## User-facing policy

Normal workflow:

1. Finish milestone.
2. User says they will continue in a new chat.
3. Current orchestrator arms `MILESTONE_BOUNDARY`.
4. User opens a new root chat in the same project.
5. Orchestra claims automatically on first invocation.
6. New chat starts the next milestone from the user's new request without
   importing old milestone transcript/history.

Manual CLI remains recovery/debug tooling, not the primary UX.

## Verification

Milestone N requires tests for:

- preparation and idempotence;
- pending/in-flight rejection;
- boundary-mode quiescence;
- stale state fingerprint rejection;
- child conversation claim rejection;
- automatic root claim in PreInvocation;
- lineage generation advancement;
- old-root authority revocation;
- single-use/replay denial;
- transcript/reasoning exclusion;
- preservation across project runtime update;
- cross-runtime isolation;
- Doctor/CI integration.
