import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { claimWorkLease, releaseWorkLease } from "../../core/leases/work-lease-store.mjs";
import { buildWorkContinuation, validateContinuationForLease } from "../../core/leases/work-continuation.mjs";

const actorA = { provider: "codex", sessionIdHash: "sha256:session-a" };
const actorB = { provider: "codex", sessionIdHash: "sha256:session-b" };

function root() {
  return mkdtempSync(join(tmpdir(), "orchestra-session-continuation-"));
}

function candidate(overrides = {}) {
  return {
    schema: "orchestra.candidate.v1",
    taskId: "task-1",
    candidateId: "candidate-7",
    generation: 7,
    workspaceId: "primary",
    headSha: "abc123",
    ...overrides,
  };
}

function evidence(overrides = {}) {
  return {
    schema: "orchestra.evidence.v1",
    taskId: "task-1",
    candidateId: "candidate-7",
    candidateGeneration: 7,
    kind: "unit-tests",
    status: "RUNNING",
    source: { provider: "github-actions", reference: "run://619" },
    ...overrides,
  };
}

function task(overrides = {}) {
  return {
    taskId: "task-1",
    state: "VERIFYING",
    action: "implementation",
    domain: "runtime",
    implementationDirection: "Keep candidate abc123 and await authoritative CI.",
    ...overrides,
  };
}

test("fresh control generation preserves candidate and running evidence after writer releases mutation", () => {
  const repoRoot = root();
  const writer = claimWorkLease(repoRoot, {
    taskId: "task-1",
    actor: actorA,
    capabilities: ["WORKSPACE_EDIT"],
    candidate: "candidate-7",
  });
  assert.equal(writer.claimed, true);

  const continuation = buildWorkContinuation({
    task: task(),
    lease: writer.lease,
    candidate: candidate(),
    evidence: [evidence()],
    audit: null,
    blockers: [],
    workspaceFingerprint: "workspace-fingerprint-1",
  });

  const released = releaseWorkLease(repoRoot, { generation: 0, actor: actorA, terminalState: "DONE" });
  assert.equal(released.released, true);
  const next = claimWorkLease(repoRoot, {
    taskId: "task-1",
    actor: actorB,
    capabilities: ["CONTROL"],
    expectedGeneration: 0,
    candidate: "candidate-7",
  });
  assert.equal(next.claimed, true);
  assert.equal(next.lease.generation, 1);

  const result = validateContinuationForLease({
    continuation,
    lease: next.lease,
    workspaceFingerprint: "workspace-fingerprint-1",
  });
  assert.equal(result.valid, true);
  assert.equal(result.continuation.candidate.candidateId, "candidate-7");
  assert.equal(result.continuation.evidence[0].status, "RUNNING");
  assert.equal(result.continuation.leaseGeneration, 0);
  assert.equal(next.lease.generation, 1);
});

test("continuation is bounded and never carries transcript reasoning secrets or raw actor identity", () => {
  const repoRoot = root();
  const lease = claimWorkLease(repoRoot, {
    taskId: "task-1",
    actor: actorA,
    capabilities: ["CONTROL"],
    candidate: "candidate-7",
  }).lease;

  const continuation = buildWorkContinuation({
    task: task({
      transcript: "DO-NOT-CARRY-TRANSCRIPT",
      reasoning: "DO-NOT-CARRY-REASONING",
      prompt: "DO-NOT-CARRY-PROMPT",
      secret: "DO-NOT-CARRY-SECRET",
    }),
    lease,
    candidate: candidate(),
    evidence: [evidence()],
    audit: null,
    blockers: ["CI still running"],
    workspaceFingerprint: "workspace-fingerprint-1",
  });

  const serialized = JSON.stringify(continuation);
  assert.doesNotMatch(serialized, /DO-NOT-CARRY/);
  assert.equal("actor" in continuation, false);
  assert.equal("capabilities" in continuation, false);
  assert.deepEqual(Object.keys(continuation.task).sort(), ["action", "domain", "implementationDirection", "state", "taskId"]);
});

test("candidate and evidence generation mismatch is rejected", () => {
  const repoRoot = root();
  const lease = claimWorkLease(repoRoot, {
    taskId: "task-1",
    actor: actorA,
    capabilities: ["CONTROL"],
    candidate: "candidate-7",
  }).lease;

  assert.throws(() => buildWorkContinuation({
    task: task(),
    lease,
    candidate: candidate(),
    evidence: [evidence({ candidateGeneration: 6 })],
    audit: null,
    blockers: [],
    workspaceFingerprint: "workspace-fingerprint-1",
  }), /WORK_CONTINUATION_EVIDENCE_MISMATCH/);
});

test("active writer blocks fresh continuation and returned status grants no mutation capability", () => {
  const repoRoot = root();
  const writer = claimWorkLease(repoRoot, {
    taskId: "task-1",
    actor: actorA,
    capabilities: ["WORKSPACE_EDIT"],
    candidate: "candidate-7",
  });
  const continuation = buildWorkContinuation({
    task: task({ state: "IMPLEMENTING" }),
    lease: writer.lease,
    candidate: candidate(),
    evidence: [],
    audit: null,
    blockers: [],
    workspaceFingerprint: "workspace-fingerprint-1",
  });

  const result = validateContinuationForLease({
    continuation,
    lease: writer.lease,
    workspaceFingerprint: "workspace-fingerprint-1",
  });
  assert.equal(result.valid, false);
  assert.equal(result.reason, "WRITE_LEASE_ACTIVE");
  assert.equal("capabilities" in result.status, false);
  assert.equal("actor" in result.status, false);
  assert.equal(result.status.candidateId, "candidate-7");
});

test("workspace fingerprint mismatch fails closed", () => {
  const repoRoot = root();
  const lease = claimWorkLease(repoRoot, {
    taskId: "task-1",
    actor: actorA,
    capabilities: ["CONTROL"],
    candidate: "candidate-7",
  }).lease;
  const continuation = buildWorkContinuation({
    task: task(), lease, candidate: candidate(), evidence: [evidence()], audit: null, blockers: [], workspaceFingerprint: "fp-before",
  });
  const result = validateContinuationForLease({ continuation, lease, workspaceFingerprint: "fp-after" });
  assert.equal(result.valid, false);
  assert.equal(result.reason, "WORKSPACE_FINGERPRINT_MISMATCH");
});
