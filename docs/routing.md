# Routing & Governance

Routing in Orchestra maps high-level user intent and technical complexity to the most capable and cost-effective agent tier.

---

## 1. Canonical Actions & Domains

Every operational step is categorized into canonical actions and domains:

### Task Actions (`taskAction`)
- `ORCHESTRATE`: Control plane planning, evaluation, and scope management.
- `IMPLEMENT`: Writing code, implementing features, or fixing bugs.
- `INVESTIGATE`: Falsifiable hypothesis testing and root-cause isolation.
- `TEST`: Authoring or executing deterministic test suites.
- `REVIEW`: Independent verification of correctness and edge cases.
- `MECHANICAL_FIX`: Simple syntax updates, formatting, or trivial fixes.
- `INTEGRATE`: Coordinating multiple independently accepted deliverables.
- `DIRECT_ACTION`: Fast path for routine operational queries and commands.
- `ESCALATE`: Elevating an unresolved uncertainty to higher reasoning.

### Task Domains (`taskDomain`)
- `CODE`: Core logic, business rules, algorithms.
- `UI`: Visual components, user interface, layout, styling.
- `DATA`: Data schemas, database migrations, parsing.
- `INFRA`: CI/CD, scripts, Docker, build tools.
- `TESTING`: Test suites, fixtures, integration benches.
- `DOCS`: Documentation, specs, markdown guides.
- `RESEARCH`: Exploratory notebooks and prototypes.
- `ORCHESTRA`: Orchestra policies, hooks, and configurations.
- `GENERAL`: General repository housekeeping.

---

## 2. Fail-Closed Routing Invariant

- Any request containing an unknown action, unmapped domain, or unauthorized state transition immediately returns `UNKNOWN` or `BLOCKED`.
- It fails closed to the Orchestrator or a `HUMAN_GATE`.
- Under no circumstances does the router silently guess or fallback to an unauthorized model provider.

---

## 3. Direct Work Default Lane

Normal bounded `IMPLEMENT` and eligible `MECHANICAL_FIX` work uses **Direct Work by default**. The control plane resolves intent, cause/direction, scope, preservation requirements, and validation before delegating one canonical Implementation Packet to a cheap implementer.

Direct Work has three provider-neutral execution modes:

- `DIRECT_WORK`: bounded implementation is ready to execute without open-ended diagnosis.
- `GUIDED_WORK`: unresolved diagnosis or unbounded scope returns to the control plane for deeper reasoning.
- `ORCHESTRATED_WORK`: critical migrations or multiple independent workstreams require heavier coordination.

The migration gate is `ORCHESTRA_DIRECT_WORK_MODE=off|shadow|on`:

- unset or empty → `on`;
- `on` → Direct Work routing is authoritative;
- `shadow` → compute Direct Work policy while preserving the legacy route;
- `off` → preserve legacy routing exactly;
- an invalid explicit value fails safe to `shadow` rather than silently enabling a new behavior.

The implementer receives only `NONE` or semantic `DIRECTED` discovery. It cannot reinterpret the request, perform broad repository exploration, mutate tests without explicit packet authorization, investigate unrelated/uncertain failures, spawn workers, or self-accept.

After a candidate exists, required evidence and an independent cheap **Quick Audit** may start in parallel. Quick Audit is diff/task scoped and emits only `PASS` or a causal `BLOCKING_FINDING`. Sol/control confirms findings, issues bounded Delta Packets when necessary, and remains the sole acceptance authority.

---

## 4. Two-Key Critical Review

When a task involves `criticality == CRITICAL` (e.g. database schema migrations, authentication, public release packaging):
- The Orchestrator delegates to two independent reviewers.
- **Reviewer A** checks requirement satisfaction and correctness.
- **Reviewer B** performs adversarial analysis (security, regressions, edge cases).
- Both must return `ACCEPT`. Any disagreement or `BLOCK` transitions immediately to `HUMAN_GATE`.

---

## 5. Cross-Provider Delegation

Cross-provider routing is intentionally conservative. Normal implementation, investigation, Quick Audit, and routine review stay on the current provider unless CONTROL explicitly chooses an allowed external implementation route. The presence of another installed provider is a capability, not a reason to add a model handoff.

V1 remains the bounded read/process-exec contract used for independent critical review and explicit `SECOND_OPINION`. V2 is implementation-only: CONTROL may explicitly choose the sibling provider as an `IMPLEMENTER` with `LOCAL_READ + PROCESS_EXEC + WORKSPACE_EDIT`, `WORKSPACE_ONLY`, network forbidden, no recursive delegation, and `EPHEMERAL_CLONE` isolation. Standalone V2 remains strictly cross-provider.

Every cross-provider route preserves originating CONTROL authority. External workers do not receive Work Lease ownership, generation advance, Candidate/Evidence promotion, Acceptance, release/publication, or finish authority.

The read-only route still requires a distinct target provider, a supported purpose, factual provider readiness, and the stage-local delegation budget. Mutable V2 additionally requires hardened local clone support and a machine-valid mutation scope. The broker derives the actual mutation, seals a Mutation Artifact, and requires an explicit CONTROL inspect/promote/discard decision.

If the sibling provider is absent, unauthenticated at execution time, times out, returns malformed output, violates capability bounds, produces a stale/tampered artifact, or otherwise fails, Orchestra returns a bounded failure to CONTROL. It does **not** silently switch provider, mutate manually, reinterpret the route, or treat failure as approval.

Critical review remains subject to the existing independent-review and Human Gate semantics. Cross-provider diversity can supply one reviewer, but it never weakens the requirement for factual evidence or grants the external worker self-acceptance authority.

---

## 6. Parallel Implementation 2

`PARALLEL_2` is a distinct implementation-concurrency decision, not Milestone-K exploration parallelism and not an automatic consequence of two providers being installed.

CONTROL may select it only when all of these facts are already resolved:

- the task is bounded implementation work;
- there are exactly two independent workstreams;
- diagnosis is not unresolved or open-ended;
- each shard is resolved and bounded;
- each shard has an explicit mutation scope;
- Orchestra can prove those writable scopes are disjoint.

When those prerequisites are absent or ambiguous, routing returns to CONTROL with serial implementation semantics. Serial Direct Work remains the default.

A valid group has exactly two distinct target providers. One may match the CONTROL provider only inside this validated group; the second is the sibling provider. Both workers execute in separate hardened clones from the same immutable source snapshot. Their factual `changedPaths` must also be disjoint after execution.

The neutral broker never promotes member artifacts one by one. It composes the two sealed deltas in a fresh third clone and produces one Composite Mutation Artifact. CONTROL then performs one inspect/promote/discard lifecycle. Any member failure, overlap, tamper, composition conflict, stale baseline, Work Lease mismatch, or promotion failure closes the group without partial canonical product mutation.

Parallel group execution has its own exact two-member reservation and does not raise the ordinary cross-provider delegation budget globally. A failed parallel group never silently falls back to serial or manual implementation; CONTROL may choose a new explicit serial retry only after the failed group is closed.
