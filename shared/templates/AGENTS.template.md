# Repository Guidance Template

> **Note for Consumer Projects**:
> Place this file as `AGENTS.md` at the root of your project.
> It should define the durable architecture, boundaries, and verification rules **of your own project**.
> Do not put provider-specific routing instructions here; routing is managed by Orchestra in `.codex/` or `.agents/`.

## Scope & Non-Destruction

- Make the smallest coherent project change that satisfies the approved task.
- Preserve unrelated local WIP, untracked scratch files, and experiment outputs.
- Never run destructive git operations (`git clean`, `git reset --hard`, destructive checkouts).
- Never commit secrets, credentials, or environment files (`.env`).

## Architecture & Code Boundaries

<!-- Customize these boundaries for your project -->
- Keep core domain and business logic in your core module (e.g. `src/core/`), isolated from UI frameworks.
- Do not import UI libraries or framework-specific state managers into framework-agnostic packages.
- Protected reference material (e.g. `vendor/`, `fixtures/`) must remain immutable unless an approved task explicitly alters it.

## Verification

- Start with focused unit tests for changed behavior.
- Run project-level linters, typechecks, and test suites after changes stabilize:
  ```bash
  # Example verification commands for your project:
  npm test
  npm run typecheck
  npm run lint
  ```
- Inspect your git diff (`git diff`) and run `git diff --check` before requesting commit or push.

## Delivery Safety

- Do not commit, push, deploy, or publish without explicit human approval.
