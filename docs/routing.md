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

Cross-provider routing is intentionally conservative. Normal implementation, investigation, Quick Audit, and routine review stay on the current provider. The presence of another installed provider is a capability, not a reason to add a model handoff.

Automatic cross-provider use is limited to an **independent critical-review slot** where provider diversity materially increases independence. A user may also explicitly request a cross-provider `SECOND_OPINION`. These are execution routes only: the originating CONTROL keeps Work Lease authority and all acceptance decisions.

A cross-provider route must satisfy all of the following:

- the target provider differs from the origin provider;
- the logical purpose is an allowed bounded review/investigation purpose;
- the target capability has been discovered as available;
- the delegation remains `LOCAL_READ + PROCESS_EXEC` in V1;
- the worker may not delegate again;
- at most one cross-provider delegation is allowed for the same logical stage.

If the sibling provider is absent, unauthenticated at execution time, times out, returns malformed output, violates capability bounds, or otherwise fails, Orchestra returns the normalized result to CONTROL. It does **not** silently switch to another provider, reinterpret the route, or treat failure as approval. Provider unavailability therefore degrades an optional route rather than changing the authority model.

Critical review remains subject to the existing independent-review and Human Gate semantics. Cross-provider diversity can supply one reviewer, but it never weakens the requirement for factual evidence or grants the external worker self-acceptance authority.
