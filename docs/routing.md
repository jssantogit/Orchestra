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

The implementer receives only `NONE` or `DIRECTED` discovery. It cannot reinterpret the request, perform broad repository exploration, mutate tests without explicit packet authorization, investigate unrelated/uncertain failures, spawn workers, or self-accept.

After a candidate exists, required evidence and an independent cheap **Quick Audit** may start in parallel. Quick Audit is diff/task scoped and emits only `PASS` or a causal `BLOCKING_FINDING`. Sol/control confirms findings, issues bounded Delta Packets when necessary, and remains the sole acceptance authority.

---

## 4. Two-Key Critical Review

When a task involves `criticality == CRITICAL` (e.g. database schema migrations, authentication, public release packaging):
- The Orchestrator delegates to two independent reviewers.
- **Reviewer A** checks requirement satisfaction and correctness.
- **Reviewer B** performs adversarial analysis (security, regressions, edge cases).
- Both must return `ACCEPT`. Any disagreement or `BLOCK` transitions immediately to `HUMAN_GATE`.