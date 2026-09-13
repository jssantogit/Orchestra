# Handoff Packets Specification

Handoff packets structure communication between the Orchestrator (control plane) and Workers (execution plane). Adhering to strict packet formats prevents context bloat and ensures reproducible decisions.

---

## 1. Delegation Handoff (Orchestrator -> Worker)

Delivered when transitioning from `PLANNED` to `DELEGATED`:

```markdown
### IMPLEMENTATION_HANDOFF
- **Task ID**: <unique-id>
- **Action**: IMPLEMENT | TEST | MECHANICAL_FIX | INVESTIGATE
- **Domain**: CODE | UI | DATA | INFRA | TESTING | DOCS | RESEARCH | GENERAL
- **Scope Contract**:
  - Allowed Paths: `["src/components/**"]`
  - Forbidden Paths: `["src/core/**", "docs/**"]`
  - Retry Budget: 2
- **Objective**: <concise 1-2 sentence description of goal>
- **Key References**:
  - File: `src/components/Panel.tsx#L40-L80`
  - Symbol: `renderPanelHeader`
- **Verification Commands**:
  - `npm test -- --grep "Panel"`
- **Stop Conditions**: Stop immediately upon passing verification.
```

---

## 2. Worker Completion Packet (Worker -> Orchestrator)

Returned when worker finishes execution:

```markdown
### IMPLEMENTATION_COMPLETE
- **Status**: SUCCESS | BLOCKED | PARTIAL
- **Changed Files**:
  - `src/components/Panel.tsx`
- **Change Summary**: <concise summary of code changes made>
- **Evidence**:
  - Command: `npm test -- --grep "Panel"`
  - Exit Code: 0
  - Output Summary: "4 tests passed"
- **Risks / Edge Cases**: <any potential concerns or side effects>
- **Scope Compliance**: Confirmed only `allowedPaths` were touched.
```

---

## 3. Delta Retry Packet (Orchestrator -> Worker)

Dispatched when verification fails and retry budget remains (`remainingAttempts > 0`):

```markdown
### DELTA_RETRY_PACKET
- **Task ID**: <task-id>
- **Attempt**: 2 of 2
- **Failed Assertion**: <exact failing test assertion or unmet criterion>
- **Observed Evidence**: <failing command output excerpt or error message>
- **Root Cause / Defect**: <specific flaw identified in previous attempt>
- **Targeted Correction**: <concrete instructions for the fix>
- **Preserved Code**: <functions/files that are already correct and must not be broken>
- **Remaining Budget**: 1
```

---

## 4. Cross-Domain Request Packet (Worker -> Orchestrator)

Emitted when a worker discovers that completion requires touching another domain:

```markdown
### CROSS_DOMAIN_REQUEST
- **Current Domain**: UI
- **Requested Domain**: CODE
- **Blocking Reason**: Component requires an export from `src/core/parser.ts` which does not yet exist.
- **Required Path**: `src/core/parser.ts`
- **Evidence**: TypeScript error TS2305: Module has no exported member.
- **Worker State**: Halted awaiting Orchestrator resolution.
```

---

## 5. Unresolved Decision Packet (Orchestrator -> Human Gate)

Emitted when retry budget is exhausted, reviewers disagree, or an unsafe ambiguity is encountered:

```markdown
### UNRESOLVED_DECISION_PACKET
- **Status**: HUMAN_GATE
- **Trigger**: RETRY_BUDGET_EXHAUSTED | TWO_KEY_DISAGREEMENT | CROSS_DOMAIN_CONFLICT
- **Summary of Problem**: <clear explanation of what could not be resolved automatically>
- **Approaches Attempted**:
  1. <Attempt 1 and failure reason>
  2. <Attempt 2 and failure reason>
- **Decisions Needed from Human**:
  - [Option A]: <Description>
  - [Option B]: <Description>
```
