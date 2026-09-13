---
name: integration
description: >-
  Use this skill to manage multi-deliverable integration gates, author integration contracts for Gemini 3.8 Flash High, and verify integration completion.
---

# Multi-Deliverable Integration Protocol

## When Integration is Required
Integration is triggered ONLY when:
1. Multiple deliverables have passed individual acceptance; or
2. Changes span multiple domains (`taskDomains.length > 1`); or
3. Explicit integration requirements are declared in the task facts.
*Never create fake integration contracts for single, isolated deliverables.*

## Integration Contract Creation
When integration criteria are met:
1. The Orchestrator authors an **Integration Contract**:
   - `taskAction`: `IMPLEMENT`
   - `operation`: `INTEGRATE`
   - `executor`: `flash`
   - `worker`: `flash-worker` (`gemini-3.8-flash-high`)
   - `allowedPaths`: Union of deliverable touchpoints
   - `testsRequired`: Stage 3 integration suite + Stage 2 domain suites
2. Flash High executes the integration subtask in an isolated execution context.
3. Verification follows Stage 3 integration testing. Once verified, the subtask returns `EVIDENCE_READY` for acceptance.
