import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  diagnoseCodexWorkLease,
  enterCodexWorkLease,
} from "../../runtimes/codex/.codex/astra-orchestra/work-lease-authority.mjs";

function project() {
  const root = mkdtempSync(join(tmpdir(), "orch-codex-diagnostic-identity-"));
  mkdirSync(join(root, ".codex", "orchestra-state"), { recursive: true });
  writeFileSync(
    join(root, ".codex", "orchestra-state", "active-state.json"),
    JSON.stringify({ taskId: "task-1" }, null, 2) + "\n",
  );
  return root;
}

test("actor-specific diagnostic labels caller-supplied identity as unverified current-session provenance", () => {
  const root = project();
  try {
    const entered = enterCodexWorkLease(root, { sessionId: "factual-hook-session" });
    assert.equal(entered.authoritative, true);

    const result = diagnoseCodexWorkLease(root, { sessionId: "unsupported-env-derived-value" });

    assert.deepEqual(result.subject, {
      scope: "SUPPLIED_ACTOR",
      identitySource: "CALLER_SUPPLIED_SESSION_ID",
      currentSessionVerified: false,
      warning: "Authority applies only to the supplied factual Codex hook session_id; do not infer the current session id from environment variables.",
    });
    assert.equal(result.authority.status, "DENIED");
    assert.equal(result.authority.reason, "LEASE_BINDING_MISSING");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("lease-only diagnostic does not imply actor authority", () => {
  const root = project();
  try {
    enterCodexWorkLease(root, { sessionId: "factual-hook-session" });
    const result = diagnoseCodexWorkLease(root);

    assert.deepEqual(result.subject, {
      scope: "LEASE_ONLY",
      identitySource: "NONE",
      currentSessionVerified: false,
      warning: "No actor identity was supplied; authority for the current Codex session is not evaluated by this diagnostic.",
    });
    assert.equal(result.authority.status, "UNKNOWN");
    assert.equal(result.authority.reason, "CODEX_SESSION_ID_REQUIRED");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
