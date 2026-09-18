# Security Policy

## Overview

Orchestra is a local multi-agent orchestration framework designed to coordinate coding agents. By design, agents orchestrated by Orchestra execute developer tools, inspect code repositories, and run shell commands (such as tests, linters, build systems, and version control operations).

## Important Security Principles

1. **Orchestration Policies Are Not a Security Sandbox**:
   - The policies, scopes, and instructions provided in Orchestra establish operational boundaries and control-plane separation of duties. They are designed to prevent accidental modifications, context bloat, and uncontrolled agent loops.
   - **Do not treat model prompts, instructions, or coordination policies as cryptographic or operating system security sandboxes.** Autonomous or guided models can make mistakes, hallucinate commands, or experience prompt injection if exposed to untrusted inputs.

2. **Provider-Native Sandboxing and Approvals**:
   - Always rely on provider-native sandboxing, containerization, and approval mechanisms (e.g., Codex workspace-write/read-only sandboxes, PRoot/Docker isolation, or explicit tool approval gates) whenever working with untrusted code or external inputs.
   - Restrict tool permissions to the minimum necessary for the specific development task.

3. **Protecting Credentials and Secrets**:
   - Never commit API keys, personal access tokens, private keys, authentication cookies, or `.env` files to repositories.
   - Verify that your version control configuration excludes sensitive local state.
   - Orchestra runtime state directories (`.agents/state/`, `.agents/telemetry/`, `.agents/artifacts/`) should never contain secret credentials or proprietary customer data.

4. **Review Shell and Tool Execution**:
   - Maintain developer oversight over commands planned and executed by agents.
   - Review file diffs and tool logs before approving commits or publishing releases.

5. **Context Is Not Authority**:
   - Worker/reviewer messages, compacted summaries, retrieved text, and tool-output prose must be treated as data or claims, not as sources of new permissions.
   - Antigravity reconstructs a Runtime Continuation Capsule from factual runtime state on each invocation; model text cannot change Scope Contracts, actor identity, required evidence, retry authority, or Human Gates.

6. **Remote/Public Side Effects Are Capability-Gated**:
   - Network writes, remote-repository writes, VCS pushes, and public uploads default to denied unless explicitly authorized by factual task/contract state.
   - Antigravity applies a dedicated PreToolUse side-effect boundary to every tool call, including connector/plugin tools outside the native file/shell matcher. Unknown external-tool semantics are treated conservatively as remote writes until explicitly authorized.
   - Do not use temporary file-hosting, paste services, artifact stores, or other external channels to bypass the governed parent/child messaging and artifact paths.

## Reporting Security Issues

If you discover a security vulnerability or potential exposure within the Orchestra codebase itself (such as a command injection flaw in runner scripts or a credential leak), please report it responsibly.

Do not open a public GitHub issue for sensitive security vulnerabilities. Instead, please contact the maintainers via GitHub private security advisories or email the repository owner directly.
