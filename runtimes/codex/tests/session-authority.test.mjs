import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";

import {
  authorizeCodexSession,
  bootstrapCodexSessionAuthority,
  claimCodexSessionHandoff,
  CODEX_SESSION_AUTHORITY_STATUSES,
  enterCodexSession,
  prepareCodexSessionHandoff,
  readCodexSessionAuthority,
  readCodexSessionHandoff,
} from "../.codex/astra-orchestra/session-authority.mjs";

function git(root, ...args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function project() {
  const root = mkdtempSync(join(tmpdir(), "orch-codex-handoff-"));
  git(root, "init", "-q");
  git(root, "config", "user.name", "Test");
  git(root, "config", "user.email", "test@example.invalid");
  writeFileSync(join(root, "product.txt"), "v1\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "init");
  mkdirSync(join(root, ".codex", "orchestra-state"), { recursive: true });
  return root;
}

function state(root, value) {
  writeFileSync(join(root, ".codex", "orchestra-state", "active-state.json"), JSON.stringify(value, null, 2) + "\n");
}

function contract(root, value = { allowedPaths: ["product.txt"] }) {
  writeFileSync(join(root, ".codex", "orchestra-state", "active-contract.json"), JSON.stringify(value, null, 2) + "\n");
}

test("Codex factual session bootstraps authority and rejects a second unleased root", () => {
  const root = project();
  try {
    const boot = bootstrapCodexSessionAuthority(root, { sessionId: "root-a" });
    assert.equal(boot.bootstrapped, true);
    assert.equal(authorizeCodexSession(root, "root-a").allowed, true);
    assert.equal(authorizeCodexSession(root, "root-b").allowed, false);
    const entered = enterCodexSession(root, { sessionId: "root-b", source: "startup" });
    assert.equal(entered.authoritative, false);
    assert.equal(readCodexSessionAuthority(root).record.main_session_id, "root-a");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Codex boundary handoff resets task authority to INTAKE and revokes former root", () => {
  const root = project();
  try {
    bootstrapCodexSessionAuthority(root, { sessionId: "root-a" });
    state(root, {
      taskId: "milestone-a",
      taskAction: "IMPLEMENT",
      taskDomain: "CODE",
      state: "DONE",
      acceptanceState: "ACCEPTED",
      attempt: 1,
      mutationSeq: 4,
      evidenceLedger: [{ evidenceId: "old-proof", result: "PASS" }],
      scopeContract: { allowedPaths: ["product.txt"] },
    });
    contract(root);

    const prepared = prepareCodexSessionHandoff(root, { reason: "next milestone" });
    assert.equal(prepared.record.status, "ARMED");
    const claimed = claimCodexSessionHandoff(root, { candidateSessionId: "root-b" });
    assert.equal(claimed.claimed, true);
    assert.equal(claimed.authority.main_session_id, "root-b");
    assert.equal(claimed.authority.generation, 1);
    assert.equal(authorizeCodexSession(root, "root-a").allowed, false);
    assert.equal(authorizeCodexSession(root, "root-b").allowed, true);

    const next = JSON.parse(readFileSync(join(root, ".codex", "orchestra-state", "active-state.json"), "utf8"));
    assert.equal(next.state, "INTAKE");
    assert.equal(next.taskId, undefined);
    assert.equal(next.evidenceLedger, undefined);
    assert.equal(next.scopeContract, undefined);
    assert.equal(next.mutationSeq, 0);
    assert.equal(existsSync(join(root, ".codex", "orchestra-state", "active-contract.json")), false);
    assert.equal(readCodexSessionHandoff(root).record.status, "CLAIMED");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Codex handoff rejects active task and pending CI/evidence watches", () => {
  const root = project();
  try {
    bootstrapCodexSessionAuthority(root, { sessionId: "root-a" });
    state(root, { taskId: "x", state: "EXECUTING" });
    assert.throws(() => prepareCodexSessionHandoff(root), /BOUNDARY_NOT_QUIESCENT/);
    state(root, { taskId: "x", state: "DONE", evidenceWatches: { ci: { status: "PENDING" } } });
    assert.throws(() => prepareCodexSessionHandoff(root), /BOUNDARY_NOT_QUIESCENT/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Codex handoff binds actual dirty file bytes, not only porcelain status", () => {
  const root = project();
  try {
    bootstrapCodexSessionAuthority(root, { sessionId: "root-a" });
    state(root, { taskId: "done", state: "DONE" });
    writeFileSync(join(root, "product.txt"), "dirty-A\n");
    prepareCodexSessionHandoff(root);
    // Porcelain remains M, but content identity changes A -> B.
    writeFileSync(join(root, "product.txt"), "dirty-B\n");
    const claim = claimCodexSessionHandoff(root, { candidateSessionId: "root-b" });
    assert.equal(claim.claimed, false);
    assert.equal(claim.reason, "CODEX_SESSION_HANDOFF_WORKSPACE_STALE");
    assert.equal(readCodexSessionAuthority(root).record.main_session_id, "root-a");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Codex handoff is single-use and cannot be replayed by a third root", () => {
  const root = project();
  try {
    bootstrapCodexSessionAuthority(root, { sessionId: "root-a" });
    state(root, { taskId: "done", state: "DONE" });
    prepareCodexSessionHandoff(root);
    assert.equal(claimCodexSessionHandoff(root, { candidateSessionId: "root-b" }).claimed, true);
    const replay = claimCodexSessionHandoff(root, { candidateSessionId: "root-c" });
    assert.equal(replay.claimed, false);
    assert.equal(replay.reason, "CODEX_SESSION_HANDOFF_NOT_ARMED");
    assert.equal(readCodexSessionAuthority(root).record.main_session_id, "root-b");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Codex claim lock serializes simultaneous candidates", () => {
  const root = project();
  try {
    bootstrapCodexSessionAuthority(root, { sessionId: "root-a" });
    state(root, { taskId: "done", state: "DONE" });
    prepareCodexSessionHandoff(root);
    const lock = join(root, ".codex", "orchestra-state", "session-handoff.claim.lock");
    writeFileSync(lock, "busy\n");
    const claim = claimCodexSessionHandoff(root, { candidateSessionId: "root-b" });
    assert.equal(claim.claimed, false);
    assert.equal(claim.reason, "CODEX_SESSION_HANDOFF_CLAIM_BUSY");
    rmSync(lock, { force: true });
    assert.equal(claimCodexSessionHandoff(root, { candidateSessionId: "root-b" }).claimed, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Codex TRANSFERRING state fails closed and resumes only for reserved candidate", () => {
  const root = project();
  try {
    bootstrapCodexSessionAuthority(root, { sessionId: "root-a" });
    state(root, { taskId: "done", state: "DONE" });
    const prepared = prepareCodexSessionHandoff(root);
    const authorityPath = join(root, ".codex", "orchestra-state", "session-authority.json");
    const active = readCodexSessionAuthority(root).record;
    const body = { ...active };
    delete body.record_hash;
    body.status = CODEX_SESSION_AUTHORITY_STATUSES.TRANSFERRING;
    body.pending_session_id = "root-b";
    body.pending_handoff_id = prepared.record.handoff_id;
    body.updated_at = new Date().toISOString();
    const stable = (value) => Array.isArray(value)
      ? value.map(stable)
      : (!value || typeof value !== "object")
        ? value
        : Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
    const record_hash = createHash("sha256").update(JSON.stringify(stable(body))).digest("hex");
    writeFileSync(authorityPath, JSON.stringify({ ...stable(body), record_hash }, null, 2) + "\n");

    assert.equal(authorizeCodexSession(root, "root-a").allowed, false);
    assert.equal(authorizeCodexSession(root, "root-b").allowed, false);
    const wrong = claimCodexSessionHandoff(root, { candidateSessionId: "root-c" });
    assert.equal(wrong.claimed, false);
    assert.equal(wrong.reason, "CODEX_SESSION_AUTHORITY_TRANSFERRING");
    const resumed = claimCodexSessionHandoff(root, { candidateSessionId: "root-b" });
    assert.equal(resumed.claimed, true);
    assert.equal(resumed.authority.status, "ACTIVE");
    assert.equal(resumed.authority.main_session_id, "root-b");
    assert.equal(authorizeCodexSession(root, "root-b").allowed, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
