# Scope Contract Specification

A Scope Contract is the formal authorization packet delivered by the Orchestrator to an execution Worker. It defines boundaries, permissions, goals, and validation requirements before any work begins.

## Contract Schema

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "OrchestraScopeContract",
  "type": "object",
  "required": [
    "taskId",
    "taskAction",
    "taskDomain",
    "allowedPaths",
    "forbiddenPaths",
    "acceptanceCriteria",
    "requiredValidation",
    "retryBudget"
  ],
  "properties": {
    "taskId": {
      "type": "string",
      "description": "Unique identifier for the delegation"
    },
    "taskAction": {
      "type": "string",
      "enum": ["IMPLEMENT", "INVESTIGATE", "TEST", "MECHANICAL_FIX", "INTEGRATE", "REVIEW"]
    },
    "taskDomain": {
      "type": "string",
      "description": "Canonical task domain (e.g. CODE, UI, DATA, INFRA, TESTING, DOCS, RESEARCH, GENERAL)"
    },
    "allowedPaths": {
      "type": "array",
      "items": { "type": "string" },
      "description": "Glob patterns of paths the worker is authorized to edit or inspect"
    },
    "forbiddenPaths": {
      "type": "array",
      "items": { "type": "string" },
      "description": "Glob patterns of protected paths that must never be edited"
    },
    "acceptanceCriteria": {
      "type": "array",
      "items": { "type": "string" },
      "description": "Explicit, verifiable conditions for task acceptance"
    },
    "requiredValidation": {
      "type": "array",
      "items": { "type": "string" },
      "description": "Deterministic test or validation commands that must exit 0"
    },
    "retryBudget": {
      "type": "integer",
      "minimum": 0,
      "maximum": 3,
      "default": 2,
      "description": "Maximum number of corrective attempts permitted"
    },
    "attempt": {
      "type": "integer",
      "default": 1
    }
  }
}
```

## Enforcement Rules

1. **Path Boundary**: Any write tool call (`write_to_file`, `replace_file_content`) to a file outside `allowedPaths` or matching `forbiddenPaths` is blocked immediately.
2. **Cross-Domain Barrier**: If a worker discovers that resolving the task requires editing files outside its assigned domain, it must not cross boundaries. It must halt and emit a `CROSS_DOMAIN_REQUEST` back to the Orchestrator.
3. **No Worker Spawning**: Workers are blocked from invoking `invoke_subagent` or `define_subagent`.
