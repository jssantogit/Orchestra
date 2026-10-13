# Orchestra Cross-Provider Delegation Architecture

**Date:** 2026-10-13  
**Status:** Design approved in chat; written spec pending review  
**Target:** Orchestra 1.x follow-up after 1.0.1  
**Baseline:** `main` at Orchestra 1.0.1  
**Scope:** Provider-neutral cross-provider delegation between Codex and Antigravity (AGY), initially read/process-exec only

## 1. Problem

Orchestra 1.x cleanly separates provider-neutral Core policy from Codex and Antigravity provider runtimes, preserves Work Lease authority across fresh chats, and defaults normal implementation to the local provider/runtime. The next useful extension is to let a CONTROL actor use the *other* provider as an external worker without collapsing that isolation.

The desired behavior is not "Codex imports Antigravity" or "Antigravity imports Codex". Instead, an Orchestra CONTROL actor should be able to delegate a bounded packet to an external provider worker, receive a normalized result, and decide what to do with it while preserving existing authority, evidence, and acceptance invariants.

The first production use case is independent critical review. A second use case is an explicit second opinion during investigation. Normal implementation remains same-provider by default.

## 2. Goals

1. Add provider-neutral cross-provider delegation without weakening the current Core/provider firewall.
2. Support Codex -> AGY and AGY -> Codex through one contract and lifecycle.
3. Preserve CONTROL ownership of authority, acceptance, evidence promotion, and candidate transitions.
4. Require isolated ephemeral worktrees for every cross-provider delegation.
5. Start with `LOCAL_READ + PROCESS_EXEC`; external workers do not receive mutation authority.
6. Keep provider installation and authentication outside Orchestra. Providers are assumed already installed and authenticated.
7. Keep cross-provider routing conservative so token/turn economy is not degraded by opportunistic fan-out.
8. Make the transport replaceable so CLI execution can later coexist with MCP or other transports without changing Core semantics.
9. Keep CI deterministic and independent of real provider accounts, network access, or credentials.

## 3. Non-goals

The initial design explicitly excludes:

- external-worker mutation authority;
- child Work Leases with write authority;
- automatic cross-provider implementation;
- recursive worker delegation;
- automatic provider fallback;
- provider installation, login, OAuth, or credential management;
- MCP transport;
- remote workers;
- automatic cross-provider investigation escalation based only on model failure;
- promotion of worker output directly into Evidence, Candidate, or Acceptance.

These may be considered in later designs after the read/process-exec foundation has field evidence.

## 4. Architectural invariants

The following invariants are normative.

### 4.1 Core remains provider-neutral

`core/**` MUST NOT import Codex- or Antigravity-specific runtime APIs, CLI flags, concrete model identifiers, hook payloads, session fields, or executor implementations.

### 4.2 Provider runtimes remain isolated

`runtimes/codex/**` MUST NOT import `runtimes/antigravity/**` or `providers/antigravity/**`.

`runtimes/antigravity/**` MUST NOT import `runtimes/codex/**` or `providers/codex/**`.

Cross-provider composition happens only in a neutral composition root above the provider runtimes.

### 4.3 Delegation is not authority transfer

Delegating execution MUST NOT transfer CONTROL authority, Work Lease ownership, acceptance authority, or candidate-promotion authority.

The root CONTROL actor remains authoritative for the task. A delegated worker receives only the capabilities explicitly encoded in the delegation request.

### 4.4 Role does not imply capability

A logical role such as `INVESTIGATOR`, `QUICK_AUDITOR`, or `CRITICAL_REVIEWER` MUST NOT implicitly grant write, network, publication, or remote-repository capability.

Capabilities are explicit facts and are validated independently of logical role.

### 4.5 Cross-provider workers do not self-accept

A `DelegationResult` is a worker claim. It is not canonical Evidence, a Candidate, or an Acceptance decision.

Only CONTROL or an independent acceptance owner may promote information from a result into the canonical workflow.

### 4.6 No recursive delegation

Initial cross-provider workers MUST receive:

- `mayDelegate = false`;
- `delegationDepth = 1` maximum.

Workers cannot call another provider worker.

### 4.7 Canonical workspace is never used directly

Every cross-provider execution MUST run in an ephemeral isolated worktree derived from a factual source revision/fingerprint. The canonical CONTROL workspace MUST NOT be the worker execution directory.

## 5. High-level architecture

```text
CONTROL
   |
   | DelegationRequest
   v
core/delegation/
   |- contract
   |- policy
   |- lifecycle
   |- routing decision
   `- workspace semantics
        |
        v
runtime/delegation/
   |- broker.mjs
   `- cli.mjs             <- neutral composition root
        |
        +--> providers/codex/delegation-executor.mjs
        |
        `--> providers/antigravity/delegation-executor.mjs
                  |
                  v
            provider CLI
                  |
                  v
          normalized result
                  |
                  v
              CONTROL
```

The broker is provider-neutral in behavior but is allowed to compose provider executors. Core never imports the executors.

Provider executors know only their own CLI surface.

## 6. Delegation contracts

### 6.1 `DelegationRequest.v1`

`ImplementationPacket` remains the canonical description of the work. Cross-provider delegation wraps that packet in a separate authority/execution envelope.

Illustrative shape:

```ts
DelegationRequest {
  schema: "orchestra.delegation-request.v1"

  delegationId
  taskId

  source: {
    provider
    actorIdHash
  }

  target: {
    provider
    logicalRole
  }

  purpose:
    "INDEPENDENT_REVIEW" |
    "SECOND_OPINION" |
    "SPECIALIST_EXECUTION" |
    "MANUAL"

  packet: ImplementationPacket

  authority: {
    capabilities: [
      "LOCAL_READ",
      "PROCESS_EXEC"
    ]
    mutation: "FORBIDDEN"
    network: "FORBIDDEN"
    mayDelegate: false
  }

  workspace: {
    sourceFingerprint
    sourceRevision
    isolation: "EPHEMERAL_WORKTREE"
  }

  limits: {
    timeoutMs
    maxOutputBytes
    delegationDepth: 1
  }
}
```

The initial production policy allows only the read/process-exec subset. `SPECIALIST_EXECUTION` is reserved in the contract but does not receive automatic routing in v1.

### 6.2 `DelegationResult.v1`

Illustrative shape:

```ts
DelegationResult {
  schema: "orchestra.delegation-result.v1"

  delegationId
  provider
  logicalRole
  purpose

  status:
    "COMPLETED" |
    "FAILED" |
    "TIMED_OUT" |
    "DENIED"

  reason?
  summary
  findings[]
  evidenceRefs[]

  execution: {
    exitCode
    durationMs
  }

  workspace: {
    initialFingerprint
    finalFingerprint
    dirty
  }
}
```

The result MUST remain bounded. Raw transcripts, unbounded stdout/stderr, full prompts, hidden reasoning, credentials, or provider-local session dumps MUST NOT be persisted in the canonical result.

### 6.3 Result semantics

The following equivalences are forbidden:

```text
DelegationResult != Evidence
DelegationResult != Candidate
DelegationResult != Acceptance
```

CONTROL may derive bounded Evidence from verified factual references in the result, but promotion is a separate explicit transition.

## 7. Worker Envelope

The external provider MUST NOT receive the full `DelegationRequest` as free-form prompt text.

The broker derives a minimal Worker Envelope containing only information needed to perform the delegated job, such as:

- objective;
- logical role;
- bounded task context from `ImplementationPacket`;
- allowed paths/reference set;
- acceptance/evidence requirements;
- explicit capabilities;
- explicit prohibitions;
- output contract;
- timeout/budget hints that are safe for the worker to know.

CONTROL/lease internals that are not required for worker execution are omitted.

This preserves the trust boundary between runtime authority and model claims.

## 8. Executor interface and transport boundary

Core semantics MUST NOT depend on CLI transport.

A provider executor conceptually implements:

```ts
executeDelegation(request, workspaceContext) -> DelegationResult
```

Provider-specific execution details are encapsulated in:

- `providers/codex/delegation-executor.mjs`;
- `providers/antigravity/delegation-executor.mjs`.

The initial transport is CLI-based because both providers expose non-interactive automation surfaces. Exact flags are provider implementation details and MUST be detected/validated by provider-local tests rather than encoded in Core.

The transport boundary should permit future implementations such as:

```text
CliTransport
McpTransport
SdkTransport
```

without changing `DelegationRequest`, authority semantics, routing semantics, or result semantics.

## 9. Provider discovery

Orchestra assumes provider CLIs are already installed and authenticated.

The broker performs bounded capability discovery before execution:

- CLI present/missing;
- factual version;
- required non-interactive capability available;
- required sandbox/output capability available where applicable.

Provider absence MUST return `PROVIDER_UNAVAILABLE`.

The broker MUST NOT silently substitute another provider.

## 10. Ephemeral workspace lifecycle

Every cross-provider delegation follows this lifecycle.

### 10.1 Validate request

Before any external process or worktree is created:

- schema validates;
- requested logical role is valid;
- purpose is valid;
- `delegationDepth <= 1`;
- `mayDelegate == false`;
- mutation is forbidden for the initial design;
- capabilities are a permitted subset;
- target provider is explicit;
- source revision/fingerprint is factual and available.

### 10.2 Discover target provider

The broker verifies target-provider capability. Failure is factual and returned to CONTROL.

### 10.3 Snapshot source identity

The broker records source revision and canonical workspace fingerprint using the existing Orchestra workspace fingerprint semantics.

### 10.4 Create ephemeral worktree

An isolated worktree is created for the factual source revision, for example under a project-owned ignored location such as:

```text
.orchestra-worktrees/delegation-<id>/
```

The exact storage path is an implementation choice, but it MUST be outside the canonical working tree mutation surface and MUST be ignored from product ownership/fingerprints as appropriate.

### 10.5 Execute provider

The provider executor runs in the ephemeral worktree with the Worker Envelope and bounded output contract.

Although the logical authority is read/process-exec only, tests and tools may physically create temporary files. Such changes are confined to the ephemeral worktree and never promoted automatically.

### 10.6 Normalize and validate result

Provider output is treated as untrusted model output until the provider executor converts it into a bounded result candidate and the canonical `DelegationResult` schema validates.

Malformed output returns `INVALID_RESULT`; permissive free-form parsing MUST NOT silently invent canonical fields.

### 10.7 Record final workspace state

Before cleanup, record:

- final fingerprint;
- dirty state;
- bounded mutation summary if useful for diagnostics.

Dirty state is diagnostic only in the read/process-exec milestone and MUST NOT be promoted into the canonical workspace.

### 10.8 Cleanup

Cleanup is attempted for success, failure, timeout, denial after workspace creation, and invalid result.

If cleanup fails:

- the delegated result reports `WORKSPACE_CLEANUP_FAILED` or equivalent bounded failure data;
- the path remains identifiable for Doctor/recovery;
- Orchestra MUST NOT use destructive broad cleanup commands.

## 11. Failure taxonomy

The initial bounded failure taxonomy is:

```text
PROVIDER_UNAVAILABLE
CAPABILITY_DENIED
WORKSPACE_PREP_FAILED
EXECUTION_FAILED
EXECUTION_TIMED_OUT
INVALID_RESULT
WORKSPACE_CLEANUP_FAILED
```

Provider-local failures may carry bounded factual references, but the canonical taxonomy should stay small and stable.

Failure of a delegated worker MUST NOT advance Work Lease generation or transfer CONTROL authority.

## 12. Routing policy

### 12.1 Same-provider remains default

Cross-provider execution is an exception that requires a factual purpose. Provider availability alone is never a routing reason.

Task classification remains provider-neutral and continues to determine:

- logical role;
- intensity;
- Direct/Guided/Orchestrated Work mode.

A separate delegation-target decision determines local vs cross-provider execution.

Conceptual interface:

```ts
selectDelegationTarget({
  sourceProvider,
  logicalRole,
  intensity,
  criticality,
  executionMode,
  purpose,
  previousAttempts,
  providerCapabilities,
  independenceRequired,
}) -> {
  mode: "LOCAL" | "CROSS_PROVIDER" | "NONE",
  targetProvider,
  reason,
}
```

### 12.2 V1 automatic routing

The first production routing policy is intentionally conservative:

```text
NORMAL IMPLEMENTATION
-> local provider

QUICK_AUDIT
-> local provider by default

CRITICAL_REVIEW
+ independent provider healthy
-> cross-provider

INVESTIGATION
-> local provider

SECOND_OPINION explicitly requested by CONTROL
-> cross-provider
```

Only `CRITICAL_REVIEWER` receives automatic cross-provider routing in v1.

### 12.3 Independent review

The primary automatic use case is diversity of the review chain:

```text
provider A produces candidate
        |
        v
CRITICAL_REVIEWER
        |
        v
provider B
```

The benefit is a factual independence property, not an assumption that one provider is globally better than another.

### 12.4 Explicit second opinion

CONTROL may explicitly request `SECOND_OPINION` when another provider perspective is useful. This is not auto-triggered by v1 investigation escalation.

Later releases may evaluate automatic second-opinion routing using field telemetry, but only after evidence shows it improves outcomes without harming turn/token economy.

### 12.5 No automatic provider fallback

If routing chooses Antigravity and Antigravity is unavailable, the result is `PROVIDER_UNAVAILABLE`.

The broker does not silently reroute to Codex, and vice versa.

CONTROL may make a new explicit decision after receiving the failure.

## 13. Delegation budget

The initial policy uses a bounded cross-provider budget:

```text
crossProviderBudget = 1 per logical stage
```

The budget exists to prevent cross-provider fan-out from eroding Direct Work and turn-economy gains.

A worker cannot delegate. CONTROL may create a subsequent delegation only through a new explicit routing decision with a factual purpose.

## 14. Persistent state and observability

Delegation execution is ephemeral, but Orchestra persists a small factual record under project-owned state, conceptually:

```text
.orchestra/state/delegations/<delegationId>.json
```

A record may include:

- delegation ID;
- task ID;
- source/target provider;
- purpose;
- logical role;
- status/reason;
- timestamps/duration;
- source/final fingerprints;
- exit code;
- bounded evidence references;
- cleanup status.

It MUST NOT persist full transcripts, raw prompts, hidden reasoning, secrets, or unbounded provider output.

### 14.1 Runtime events

Existing bounded runtime-event semantics should be reused for coarse lifecycle events such as:

```text
DELEGATION_STARTED
DELEGATION_COMPLETED
DELEGATION_FAILED
DELEGATION_TIMED_OUT
DELEGATION_CLEANUP_FAILED
```

Detailed metrics belong in the delegation record rather than expanding canonical runtime events into unbounded payloads.

### 14.2 Metrics

When factually available, instrumentation may record:

- delegation count;
- purpose;
- source/target provider;
- duration;
- status;
- token usage reported by the provider;
- whether the result changed CONTROL's next decision.

Missing token/cost data MUST remain missing; Orchestra MUST NOT synthesize usage numbers.

## 15. Doctor behavior

Doctor gains a non-mutating Cross-provider Delegation section.

It checks capability only; it MUST NOT automatically log in, install providers, or execute a paid/model inference request.

Conceptual output:

```text
Codex CLI       detected / missing
AGY CLI         detected / missing
Codex version   supported / unsupported
AGY version     supported / unsupported
Git worktree    available / unavailable
Delegation      ready / degraded / unavailable
```

The absence of the second provider does not make normal single-provider Orchestra unhealthy. It only marks cross-provider delegation unavailable/degraded.

## 16. Testing strategy

### 16.1 Contract tests

Deterministic tests cover:

- request/result schema validation;
- authority/capability subset validation;
- mutation forbidden;
- depth limit;
- `mayDelegate=false`;
- provider target required;
- purpose validation;
- result is not auto-promoted to Evidence/Candidate/Acceptance;
- no silent fallback.

### 16.2 Executor tests with fake CLIs

Provider executors use fake/stub CLIs in CI to cover:

- command construction;
- capability discovery;
- supported/unsupported versions;
- successful structured output;
- malformed output;
- bounded output truncation/rejection;
- process failure;
- timeout;
- non-zero exit;
- cleanup behavior.

No real provider account or credential is required in CI.

### 16.3 Git lifecycle tests

Temporary fixture repositories verify:

- source revision is exact;
- source fingerprint is recorded;
- ephemeral worktree is isolated;
- generated files remain confined;
- canonical workspace is unchanged;
- final fingerprint/dirty state is recorded;
- cleanup succeeds on success/failure/timeout;
- cleanup failure remains recoverable and non-destructive.

### 16.4 Routing tests

Tests pin the conservative v1 policy:

- normal implementation stays local;
- quick audit stays local by default;
- critical review chooses the other healthy provider when independence is available;
- explicit second opinion may cross provider;
- investigation does not auto-cross in v1;
- unavailable requested target returns factual failure;
- cross-provider budget is enforced.

### 16.5 Architecture/firewall tests

Tests MUST assert:

```text
providers/codex/**
  never imports providers/antigravity/**

providers/antigravity/**
  never imports providers/codex/**

core/**
  never imports either provider executor

runtime/delegation/**
  may compose both provider executors
```

Existing cross-runtime and contamination checks remain green.

### 16.6 Optional real-provider smoke

A manual/opt-in smoke path may use real authenticated CLIs when present. It is never a required CI gate.

## 17. Rollout milestones

### Milestone 1 — Foundation + Codex -> AGY PoC

Deliver:

- `DelegationRequest/Result` schemas/domain objects;
- delegation policy and capability guard;
- neutral broker/composition root;
- ephemeral-worktree lifecycle;
- provider discovery;
- `AgyCliExecutor`;
- bounded persistence/events;
- explicit CLI/manual entrypoint for a read/process-exec delegation;
- deterministic CI coverage.

Target proof:

```text
Codex CONTROL
   -> ImplementationPacket
   -> AGY external worker
   -> DelegationResult
   -> CONTROL
```

No automatic routing is required in Milestone 1.

### Milestone 2 — Governed routing + critical review

Deliver:

- `selectDelegationTarget`;
- automatic cross-provider `CRITICAL_REVIEWER` path;
- explicit `SECOND_OPINION` purpose;
- delegation budget;
- Doctor capability surface;
- turn-economy/telemetry instrumentation.

At this point cross-provider delegation becomes governed production behavior.

### Milestone 3 — AGY -> Codex symmetry

Deliver:

- `CodexCliExecutor`;
- reverse-path tests and smoke;
- parity checks proving both directions use the same request/result/lifecycle/authority semantics.

Target proof:

```text
AGY CONTROL
   -> ImplementationPacket
   -> Codex external worker
   -> DelegationResult
   -> CONTROL
```

**Abstraction gate:** if adding the reverse path requires provider-specific changes to `DelegationRequest`, authority semantics, or lifecycle semantics, the foundation is considered incorrectly abstracted and must be repaired before completion.

## 18. Compatibility and migration

Cross-provider delegation is additive.

When unavailable or disabled:

- existing Direct Work behavior remains unchanged;
- existing Work Lease authority remains unchanged;
- existing provider-local routing remains unchanged;
- normal implementation remains local;
- release/runtime installation remains functional with only one provider.

No historical handoff/session authority behavior is reintroduced.

## 19. Security and trust considerations

1. Provider output is untrusted until normalized and schema-validated.
2. Raw model output cannot grant capabilities.
3. Narrative prompt text cannot grant mutation/network/publication authority.
4. Worker execution is isolated from the canonical workspace.
5. Provider-local credentials remain provider-owned and are never copied into Orchestra state.
6. Persisted delegation records are bounded and exclude transcripts/secrets.
7. Unknown provider capability or output semantics fail closed.
8. Cleanup is non-destructive and recoverable.
9. No silent provider substitution occurs.
10. No worker-to-worker delegation occurs in v1.

## 20. Acceptance criteria for the complete design

The three-milestone implementation is complete only when all of the following are true:

- Codex can delegate a bounded read/process-exec task to AGY and receive a validated result.
- AGY can delegate the same class of task to Codex through the same canonical contract.
- Every cross-provider delegation uses an ephemeral worktree.
- The canonical workspace remains unchanged by delegated execution.
- External workers cannot obtain mutation, remote-write, publication, or delegation capability through role or prompt text.
- `DelegationResult` is not automatically treated as Evidence, Candidate, or Acceptance.
- Critical review can route automatically to the other healthy provider.
- Normal implementation remains same-provider by default.
- Explicit second opinion is supported without enabling automatic investigation fan-out.
- Missing/unavailable provider fails factually without silent fallback.
- Doctor reports cross-provider capability without requiring model execution.
- Deterministic CI requires no external provider login/account/network inference.
- Firewall/contamination/runtime-isolation suites remain green.
- Turn-economy instrumentation can distinguish local vs cross-provider use without inventing token/cost metrics.

## 21. Future extensions explicitly deferred

Potential follow-up designs include:

- mutation-capable external implementers in isolated worktrees;
- child/delegated Work Leases;
- governed promotion of patches from delegated worktrees;
- MCP transport;
- remote worker execution;
- evidence-based automatic second-opinion routing;
- provider capability catalogs richer than simple CLI discovery.

Each requires a separate design review because it changes authority, mutation, or operational risk beyond the initial read/process-exec boundary.
