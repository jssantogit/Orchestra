# Orchestra V2-5 — Codex Global Adapter Design

Date: 2026-10-17
Status: design A approved; written specification awaiting user review
Base: V2-4 / `feat/v2-reconciler-recovery` at `a3002edb1493cc86e8e9f713477db3add31d1799`

## 1. Goal

V2-5 connects Codex Desktop to the Orchestra v2 global control plane without recreating a project-local Orchestra runtime or session-owned authority.

The selected topology is:

```text
Codex Desktop
    |
    | provider hook event
    v
project-local thin Codex shim
    |
    v
stable global Orchestra launcher
    |
    v
v2/providers/codex
    |
    +-- factual actor normalization
    +-- project resolution
    +-- session observation
    +-- tool-event normalization
    +-- Codex hook response translation
            |
            v
GLOBAL NEUTRAL CORE
    +-- WorkAuthority
    +-- Operation Registry
    +-- Liveness
    +-- Reconciler
```

The project-local surface exists only because Codex may require project-local hook configuration. It contains no governance state machine, no Work Lease, no durable session binding and no independently evolving copy of Orchestra logic.

## 2. Success criteria

V2-5 is complete when a registered project can use Codex through the global v2 control plane with these properties:

1. A fresh Codex root session can attach to current work without a prepared handoff from an older chat.
2. `session_id` is factual provenance only and never owns Project or Work authority.
3. Instruction-epoch staleness is detected on every relevant command, not only at SessionStart.
4. A project with no active Work Unit remains usable for intake and diagnosis rather than becoming permanently blocked.
5. Tool mutation authority is derived from the global WorkAuthority tuple: Project + Work identity + generation + observed instruction epoch + factual actor provenance.
6. Codex tool calls create provider-managed Operations whose lifecycle is correlated by factual tool-call identity rather than by the PID of the transient hook process.
7. Post-tool completion terminalizes only the matching Operation and cannot accidentally release another writer.
8. Missing, duplicated, reordered or contradictory provider events fail closed with structured diagnostics and are recoverable through the existing v2 Operation/Reconciler model.
9. Project-local Codex integration is a thin shim only; no `.codex/astra-orchestra/**` governance runtime is materialized for v2 projects.
10. Existing Orchestra 1.x Codex behavior remains unchanged for projects that have not migrated to v2.

## 3. Non-goals

V2-5 does not implement:

- Antigravity v2 integration;
- Runtime Image installation or project upgrade;
- migration of existing Tsuzuki v1 state into v2;
- a permanent Orchestra daemon;
- cross-project Experience/Dream promotion;
- full evidence acceptance migration;
- provider-specific orchestration policy inside the neutral core;
- silent conversion of old `.codex/astra-orchestra` runtime state into v2 authority.

## 4. Permanent authority boundary

Codex is an adapter, not an authority source.

The durable authorization tuple is:

```text
projectId
+ expectedWorkId
+ expectedGeneration
+ observedInstructionEpoch
+ factual ActorProvenance
```

`session_id` participates only through the normalized ActorProvenance hash. It is not a lock, lease owner, root owner or handoff token.

The adapter must call the existing neutral WorkAuthority APIs. It must not duplicate generation checks, Active Work selection, liveness classification, mutation exclusivity or stale-session semantics.

## 5. Project-local surface

The selected design is a minimal local shim.

Conceptual local files:

```text
.codex/hooks.json
.codex/orchestra-v2-hook.mjs     # generated thin transport shim if host requires a script path
```

The shim may:

- read the hook payload from stdin;
- identify the repository root / current working directory;
- invoke the stable user-global Orchestra v2 launcher;
- forward the provider payload without semantic reinterpretation;
- write the returned Codex-compatible JSON response to stdout;
- fail closed when the global launcher cannot be invoked or returns malformed output.

The shim may not:

- read or write Work Units, Operations, recovery journals or authority state directly;
- implement Work Lease/session authority;
- classify liveness itself;
- mutate `.orchestra`, `.codex/orchestra-state` or any project-local governance store;
- contain copied provider-neutral policy code.

No full `.codex/astra-orchestra/**` v2 runtime is allowed.

## 6. Stable global provider hook surface

The global launcher gains a provider-facing surface conceptually equivalent to:

```text
orchestra provider codex hook
```

It accepts exactly one Codex hook event payload on stdin and returns exactly one Codex-compatible hook response on stdout.

This surface is intentionally narrow. It is not a generic escape hatch into internal v2 modules.

The provider handler owns:

- factual Codex actor extraction;
- hook-event normalization;
- project resolution from factual workspace/cwd;
- lookup and persistence of session observations;
- translation between Codex hook contracts and neutral v2 decisions;
- provider-managed Operation correlation for tool calls.

It does not own neutral authority or liveness policy.

## 7. Codex ActorProvenance

The v1 normalization behavior is retained conceptually but moved into v2 provider code.

Root session:

```yaml
provider: codex
actorKind: ROOT
actorIdHash: sha256(session_id)
isRoot: true
```

Child/agent session when Codex supplies a factual child identity:

```yaml
provider: codex
actorKind: CHILD
actorIdHash: sha256(agent_id)
parentActorIdHash: sha256(session_id)
isRoot: false
```

Rules:

- missing required factual identity fails closed;
- environment variables must not be used as a substitute for factual hook payload identity;
- raw session IDs are not persisted outside provider-scoped transient handling unless explicitly required for transport and never become authority;
- actor hashes are provenance, not credentials.

## 8. Session Observation

V2-5 introduces a provider-scoped, global **Session Observation** record.

Purpose: record which authoritative work/runtime facts a specific Codex session was actually told, without making that session the owner of those facts.

Conceptual schema:

```yaml
schema: orchestra.codex-session-observation.v2
projectId: prj_...
actorIdHash: sha256:...
observedInstructionEpoch: 27
observedWorkId: work_... | null
observedGeneration: 18 | null
observedAt: ...
```

Session Observation is explicitly non-authoritative:

- it cannot grant mutation capability;
- it cannot select the active Work Unit;
- it cannot resurrect historical work;
- it cannot block another fresh session merely because it exists;
- it may be overwritten by a newer factual SessionStart/attach observation for the same actor/project;
- it must be project scoped.

Its purpose is freshness fencing and provider UX only.

## 9. SessionStart semantics

### 9.1 Registered project with active work

Flow:

```text
SessionStart
  -> normalize actor
  -> resolve registered Project from cwd
  -> read current Project instructionEpoch
  -> WorkAuthority.attach(projectId, actor, observedInstructionEpoch=current epoch)
  -> persist Session Observation
  -> return current Work identity/generation/continuation facts as Codex context
```

No durable ownership transfer occurs.

### 9.2 Registered project with no active work

`NO_ACTIVE_WORK` is not a blocked-session condition.

The adapter returns a successful intake context conceptually equivalent to:

```text
ORCHESTRA_V2_INTAKE
project registered
activeWork: none
mutationAuthority: unavailable until Work starts
```

The Session Observation stores the current instruction epoch with null work/generation.

Read-only project diagnosis and user interaction remain possible. Starting a new Work Unit is a control-plane lifecycle action, not an implicit effect of SessionStart.

### 9.3 Project not registered

The hook fails closed for v2 authority but returns a structured provider-facing diagnostic such as `PROJECT_NOT_REGISTERED`. It must not silently initialize global state or create a project registration.

## 10. Instruction epoch freshness

A Session Observation records the instruction epoch observed by the session.

Every provider action that depends on current Orchestra behavior carries that observed epoch into WorkAuthority.

Example:

```text
Session observed epoch 27
Project advances to epoch 28
next protected command -> SESSION_RUNTIME_STALE
```

The response must make continuation semantics explicit:

```yaml
reason: SESSION_RUNTIME_STALE
currentInstructionEpoch: 28
continuationAvailable: true
```

The stale session does not lose ownership because it never owned the project. A new/resumed SessionStart can refresh its observation and continue against current facts.

## 11. Tool-event normalization

Codex provider events are normalized before neutral authorization.

Required event classes:

```text
PreToolUse  -> TOOL_REQUEST
PostToolUse -> TOOL_RESULT
```

Required operation classes:

```text
READ
WRITE
COMMAND
UNKNOWN
```

Required side-effect classes:

```text
READ_ONLY
WORKSPACE_MUTATION
UNKNOWN
```

Unknown or malformed operations fail closed for protected execution. Provider-specific tool names may map to these neutral classes, but neutral WorkAuthority must never depend on Codex tool names.

## 12. PreToolUse authorization

Flow:

```text
PreToolUse
  -> validate factual hook payload
  -> normalize actor
  -> resolve registered Project
  -> load Session Observation
  -> normalize tool event
  -> require observation to match current Project/work identity semantics
  -> WorkAuthority.authorize(...)
  -> for mutation: create/correlate provider-managed Operation
  -> translate allow/deny to Codex hook response
```

The authorization call uses:

```text
projectId
expectedWorkId
expectedGeneration
observedInstructionEpoch
actor
capability
workspaceRef
```

For an intake session with no observed Work Unit, mutating project tools are denied with a structured `NO_ACTIVE_WORK`/intake reason. This does not block the conversation itself.

## 13. Provider-managed tool Operations

### 13.1 Why the hook PID cannot be the runtime owner

Codex executes the PreToolUse hook as a short-lived process. That process exits before the actual Codex tool finishes.

Therefore the hook process PID is not factual proof that the mutation tool remains alive.

V2-5 must not create a local-process RuntimeOwner for a Codex tool call using the hook PID.

### 13.2 Correlation identity

Where Codex supplies `tool_call_id`, it is the factual provider correlation key for the lifecycle:

```text
PreToolUse(tool_call_id=X)
        -> Operation begin
PostToolUse(tool_call_id=X)
        -> matching Operation terminalization
```

The adapter persists only a hashed/bounded provider correlation reference where appropriate.

A missing `tool_call_id` for a mutation-capable action is denied with `CODEX_TOOL_CORRELATION_REQUIRED`. V2-5 does not invent synthetic IDs and does not add a fallback correlation heuristic.

### 13.3 Neutral provider-event owner contract

V2-5 must extend the neutral liveness layer with a provider-managed owner class because Codex tool execution cannot factually use the existing local-process owner probe.

The neutral contract records only provider-independent facts such as:

```yaml
ownerKind: PROVIDER_EVENT
ownerRef: provider-owner:...
correlationRef: sha256:...
startedAt: ...
lastProviderEventAt: ...
deadlineAt: ...
```

The Codex adapter supplies provider event observations to that neutral contract. The neutral liveness layer owns classification semantics.

Required classifications:

- matching factual terminal event -> Operation may be terminalized by the tool-operation service;
- no terminal event while the provider-event deadline remains open -> `LIVE` only when the neutral provider-event policy has current positive event/lease evidence sufficient to prove it; otherwise `UNKNOWN`;
- deadline expired with no contradictory fresh provider evidence -> `STALE_RECOVERABLE` only under the explicit bounded provider-event stale rule;
- contradictory/reordered/unverifiable evidence -> `UNKNOWN`.

Timeout never means success. Missing PostToolUse never becomes a successful Candidate/Evidence fact.

The provider-event owner contract must remain generic enough for a later Antigravity adapter; no Codex event names or tool identifiers enter the neutral liveness module.

### 13.4 In-flight lifecycle

While the matching provider tool lifecycle has begun but no factual terminal event has arrived, the Operation remains in flight and mutation exclusivity remains enforced.

Every provider-managed Operation has a bounded deadline. If the provider terminal event is lost, the existing Reconciler consumes the neutral provider-event liveness assessment; it does not need a Codex-specific recovery algorithm.

No daemon is required by V2-5. Reconciliation occurs on existing lifecycle/status/recovery entry points.

## 14. PostToolUse semantics

For a mutation-capable tool call:

```text
PostToolUse
  -> validate payload
  -> normalize actor + tool_call_id
  -> resolve Project
  -> find exactly one matching in-flight Operation
  -> verify project/work/generation/actor correlation
  -> terminalize that Operation with factual provider result classification
  -> persist provider event reference if allowed
```

It must never implement a generic "release current writer" operation.

This is a permanent difference from the v1 pattern where PostToolUse released whichever session Work Lease happened to be active.

Duplicate PostToolUse for the same factual tool call must converge idempotently.

A mismatched actor, Project, Work Unit, generation or correlation key fails closed and cannot terminalize another Operation.

## 15. Commands and ambiguous side effects

Shell/command tools are not assumed read-only merely because their tool name is `bash`, `shell`, `exec` or equivalent.

The v1 command heuristic may be reused only as an explicitly tested provider classifier. Any command not proven read-only is treated as mutation-capable/unknown side effect and requires the stronger authorization path.

This design intentionally prefers conservative false negatives over silently mutating without a tracked Operation.

## 16. UserPromptSubmit

UserPromptSubmit must not be a session-ownership gate.

Its v2 responsibilities are limited to current runtime freshness/provider diagnostics that are meaningful before the model acts.

A healthy fresh session in a registered project must not be blocked merely because another session previously interacted with the same Work Unit.

No-active-work intake remains allowed.

## 17. Failure semantics

Provider hook failures must be structured and actionable.

Examples:

- `PROJECT_NOT_REGISTERED`
- `CODEX_PROVIDER_IDENTITY_INVALID`
- `CODEX_SESSION_OBSERVATION_MISSING`
- `SESSION_RUNTIME_STALE`
- `NO_ACTIVE_WORK`
- `STALE_ACTIVE_WORK`
- `STALE_GENERATION`
- `LIVE_OPERATION_EXISTS`
- `STALE_OPERATION_RECOVERY_REQUIRED`
- `OPERATION_LIVENESS_UNKNOWN`
- `CODEX_TOOL_CORRELATION_REQUIRED`
- `CODEX_TOOL_OPERATION_NOT_FOUND`
- `CODEX_TOOL_OPERATION_AMBIGUOUS`
- `CODEX_PROVIDER_EVENT_MISMATCH`
- `ORCHESTRA_V2_GLOBAL_UNAVAILABLE`

The adapter may translate these into Codex hook output, but must retain the neutral factual reason in diagnostics.

Fail-closed must not become fail-opaque. When recovery is possible, the message points to global `orchestra project status/recover/resolve-dirty` surfaces rather than asking users to edit state files.

## 18. Persistence boundaries

Provider-specific durable records live under Orchestra Home, not inside the project repository.

Conceptual placement:

```text
<ORCHESTRA_HOME>/
  providers/
    codex/
      session-observations/ or equivalent SQLite provider tables
      tool-correlations/    or equivalent provider-scoped indexes
```

The physical representation should use the existing v2 SQLite persistence model unless implementation evidence demonstrates a concrete incompatibility. Any deviation requires an explicit architecture review before implementation continues.

The architectural requirements are global ownership, project namespace isolation, integrity validation and restart-safe idempotency.

Raw provider payloads are not persisted wholesale by default.

## 19. Compatibility and migration boundary

V2-5 must not alter existing v1 Codex projects implicitly.

A project participates in the v2 adapter only when factual global registration/runtime selection says it is a v2-managed project.

The v1 project-local runtime remains a compatibility path until an explicit migration milestone removes it.

The V2-5 shim installer/configuration must therefore be additive and scoped. It must not delete existing v1 runtime files as part of this milestone.

## 20. Security and integrity requirements

1. Project resolution must use the global Project Registry; cwd alone is not authority.
2. Cross-project Session Observation or tool correlation is rejected.
3. Provider correlation IDs are never trusted as globally unique without project/provider scoping.
4. Actor/session raw identifiers are not authority and are hashed before durable storage.
5. Unknown hook event types fail closed when they could create side effects.
6. Project-local shim paths cannot redirect execution outside the expected global launcher through mutable project-controlled runtime copies.
7. Global launcher failure never falls back silently to v1 authority for a v2-managed project.
8. A stale/unknown Operation cannot be overwritten by a new mutation without neutral authorization/recovery.

## 21. Required TDD coverage

### Session / attach

- fresh Codex session attaches to active Work without handoff;
- two fresh sessions attach to the same Work without stealing authority;
- old session becomes stale after instruction epoch advance;
- stale epoch is enforced on protected tool commands, not only SessionStart;
- no active Work yields INTAKE rather than blocked chat;
- unregistered project does not self-register;
- child actor provenance remains distinct from root provenance.

### Tool authorization

- read-only tool authorized with current Work identity/generation;
- mutation uses current Work identity + generation + epoch + actor;
- old Work ID with same numeric generation fails `STALE_ACTIVE_WORK`;
- stale generation fails;
- stale/recoverable mutation Operation blocks with recovery guidance;
- unknown liveness blocks without guessing.

### Tool Operation lifecycle

- mutation PreToolUse with factual `tool_call_id` creates exactly one Operation;
- duplicate PreToolUse replays idempotently rather than creating a second writer;
- matching PostToolUse terminalizes exactly that Operation;
- duplicate PostToolUse is idempotent;
- mismatched actor/project/work/generation cannot terminalize another Operation;
- missing correlation for mutation fails `CODEX_TOOL_CORRELATION_REQUIRED`;
- hook PID is never persisted as factual owner of the provider tool;
- provider-event liveness is implemented through a neutral owner contract, not Codex-specific liveness logic;
- missing PostToolUse cannot become success;
- bounded deadline/recovery semantics produce `STALE_RECOVERABLE` only under the explicit provider-event rule and otherwise remain `UNKNOWN`;
- two concurrent mutation tool calls against the same workspace cannot both obtain mutation authority.

### Shim / global boundary

- v2 project shim contains no Work Lease/session-authority implementation;
- no v2 governance runtime is materialized under project `.codex/astra-orchestra`;
- global launcher unavailable -> structured fail-closed response;
- malformed global response -> fail closed;
- Windows and Unix shim invocation paths work;
- v1 generated runtime isolation remains green.

### Regression

- full Orchestra 1.x regression;
- V2 Persistence Ubuntu/Windows;
- existing V2-0 through V2-4 conformance/recovery suites;
- generated/runtime contamination checks.

## 22. Implementation boundaries

Expected new/changed v2 surfaces may include:

```text
v2/providers/codex/
  actor.mjs
  tool-event.mjs
  hook-handler.mjs
  session-observation-store.mjs
  tool-operation-service.mjs

v2/global/
  cli.mjs
  orchestra.mjs

v2/liveness/
  provider-event owner contract + assessment/probe support

provider/shim installation code
Codex v2 adapter tests
```

Exact filenames may change under implementation as long as these ownership boundaries remain intact.

## 23. Architectural laws introduced by V2-5

> A provider session is provenance, never durable project ownership.

> `NO_ACTIVE_WORK` means intake, not a broken session.

> The PID of a transient provider hook is not the owner of the provider tool it guards.

> Mutation completion terminalizes a specific correlated Operation; there is no generic "release whichever writer is current" action.

> Missing provider terminal events never become success by timeout alone.

> Provider-event liveness is neutral core policy; Codex only supplies factual provider observations.

> Project-local provider integration may be a shim, but governance remains global.

## 24. Milestone exit gate

V2-5 may be marked complete only when:

- the Codex adapter operates through the global v2 control plane on a registered fixture project;
- fresh-chat attach works without root handoff;
- instruction epoch staleness is factual and refreshable;
- tool mutation Operations are correlated and terminalized safely;
- provider-event loss is recoverable/diagnosable through the v2 lifecycle rather than by state-file edits;
- project-local v2 footprint is demonstrably thin;
- Windows and Ubuntu CI are green;
- full Orchestra 1.x compatibility remains green;
- no provider-specific authority logic has leaked into the neutral core.
