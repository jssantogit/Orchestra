import test from "node:test";
import assert from "node:assert/strict";
import {
  validateRuntimeOwnerV2,
  validateProviderEventObservationV2,
  validateLivenessAssessmentV2,
} from "../../v2/liveness/contracts.mjs";
import { createOperationLivenessService } from "../../v2/liveness/operation-liveness-service.mjs";

const NOW = "2026-10-17T14:00:00.000Z";
const digest = `sha256:${"a".repeat(64)}`;

function operation(overrides = {}) {
  return {
    schema: "orchestra.operation.v2",
    operationId: "operation-1",
    projectId: "project-1",
    workId: "work-1",
    generation: 1,
    kind: "TOOL_MUTATION",
    actorRef: "actor-hash",
    capabilities: ["MUTATE_WORKSPACE"],
    liveness: "LIVE",
    workflowState: "IN_PROGRESS",
    startedAt: "2026-10-17T13:50:00.000Z",
    heartbeatAt: "2026-10-17T13:59:30.000Z",
    deadlineAt: "2026-10-17T14:05:00.000Z",
    runtimeOwnerRef: "provider-owner:operation-1",
    workspaceRef: null,
    resultRef: null,
    ...overrides,
  };
}

function owner(overrides = {}) {
  return {
    schema: "orchestra.runtime-owner.v2",
    runtimeOwnerId: "provider-owner:operation-1",
    operationId: "operation-1",
    kind: "PROVIDER_EVENT",
    correlationRef: digest,
    startedAt: "2026-10-17T13:50:00.000Z",
    lastProviderEventAt: "2026-10-17T13:59:30.000Z",
    deadlineAt: "2026-10-17T14:05:00.000Z",
    registeredAt: "2026-10-17T13:50:00.000Z",
    ...overrides,
  };
}

function event(overrides = {}) {
  return {
    schema: "orchestra.provider-event-observation.v2",
    runtimeOwnerId: "provider-owner:operation-1",
    correlationRef: digest,
    status: "POSITIVE",
    eventAt: "2026-10-17T13:59:30.000Z",
    observedAt: NOW,
    ...overrides,
  };
}

function serviceFor({ storedOwner = owner(), observedEvent = event(), ...options } = {}) {
  return createOperationLivenessService({
    runtimeOwnerStore: { async read() { return storedOwner; } },
    ownerProbe: { async observe() { throw new Error("provider event owner must not use PID probe"); } },
    providerEventProbe: { async observe() { return observedEvent; } },
    now: () => NOW,
    ...options,
  });
}

function assertAssessment(assessment, liveness) {
  assert.equal(validateLivenessAssessmentV2(assessment).valid, true);
  assert.equal(assessment.liveness, liveness);
}

test("provider-event owners validate without a local PID descriptor", () => {
  assert.equal(validateRuntimeOwnerV2(owner()).valid, true);
  assert.equal(validateRuntimeOwnerV2(owner({ process: { pid: 42, startIdentity: "pid-start" } })).valid, false);
});

test("the liveness service requires at least one owner probe", () => {
  assert.throws(() => createOperationLivenessService({
    runtimeOwnerStore: { async read() { return owner(); } },
    now: () => NOW,
  }), /ownerProbe\.observe is required/);
});

test("a fresh positive provider event proves LIVE only while its deadline is open", async () => {
  const assessment = await serviceFor().assess(operation());
  assertAssessment(assessment, "LIVE");
  assert.equal(assessment.evidence.providerEventFresh, true);
  assert.equal(assessment.evidence.deadlineExpired, false);
});

test("an expired deadline and stale event without fresh contradiction is recoverable", async () => {
  const expired = "2026-10-17T13:59:00.000Z";
  const staleEvent = event({ eventAt: "2026-10-17T13:50:30.000Z" });
  const assessment = await serviceFor({
    storedOwner: owner({ deadlineAt: expired, lastProviderEventAt: staleEvent.eventAt }),
    observedEvent: staleEvent,
  }).assess(operation({ deadlineAt: expired }));
  assertAssessment(assessment, "STALE_RECOVERABLE");
  assert.equal(assessment.evidence.providerEventFresh, false);
  assert.equal(assessment.evidence.deadlineExpired, true);
});

test("missing, contradictory, future-skewed, and reordered events stay UNKNOWN", async (t) => {
  const cases = [
    ["missing event", null],
    ["contradictory correlation", event({ correlationRef: `sha256:${"b".repeat(64)}` })],
    ["future skew", event({ eventAt: "2026-10-17T14:00:10.000Z" })],
    ["reordered before start", event({ eventAt: "2026-10-17T13:49:59.000Z" })],
  ];
  for (const [name, observation] of cases) {
    await t.test(name, async () => {
      const assessment = await serviceFor({ observedEvent: observation }).assess(operation());
      assertAssessment(assessment, "UNKNOWN");
    });
  }
  assert.equal(validateProviderEventObservationV2(event()).valid, true);
});

test("a persisted factual terminal operation remains TERMINAL", async () => {
  const assessment = await serviceFor().assess(operation({ liveness: "TERMINAL" }));
  assertAssessment(assessment, "TERMINAL");
});

test("an expired timeout never reports success or terminal state", async () => {
  const expired = "2026-10-17T13:59:00.000Z";
  const staleEvent = event({ eventAt: "2026-10-17T13:50:30.000Z" });
  const assessment = await serviceFor({
    storedOwner: owner({ deadlineAt: expired, lastProviderEventAt: staleEvent.eventAt }),
    observedEvent: staleEvent,
  }).assess(operation({ deadlineAt: expired }));
  assert.notEqual(assessment.liveness, "TERMINAL");
  assert.notEqual(assessment.liveness, "SUCCEEDED");
  assert.equal(validateLivenessAssessmentV2(assessment).valid, true);
});

test("provider-event boundaries and identity inconsistencies remain UNKNOWN", async (t) => {
  const expired = "2026-10-17T13:59:00.000Z";
  const stale = event({ eventAt: "2026-10-17T13:50:30.000Z" });
  const cases = [
    ["fresh event after deadline", {
      storedOwner: owner({ deadlineAt: expired }),
      observedEvent: event(),
      operation: operation({ deadlineAt: expired }),
    }],
    ["stale event before open deadline", {
      storedOwner: owner({ lastProviderEventAt: stale.eventAt }),
      observedEvent: stale,
    }],
    ["event reordered after start", {
      storedOwner: owner({ lastProviderEventAt: "2026-10-17T13:59:00.000Z" }),
      observedEvent: event({ eventAt: "2026-10-17T13:58:00.000Z" }),
    }],
    ["operation identity mismatch", {
      storedOwner: owner({ operationId: "other-operation" }),
    }],
    ["owner reference mismatch", {
      operation: operation({ runtimeOwnerRef: "provider-owner:other" }),
    }],
    ["deadline mismatch", {
      storedOwner: owner({ deadlineAt: "2026-10-17T14:06:00.000Z" }),
    }],
    ["correlation mismatch", {
      observedEvent: event({ correlationRef: `sha256:${"c".repeat(64)}` }),
    }],
    ["future observation skew", {
      observedEvent: event({ observedAt: "2026-10-17T14:00:10.000Z" }),
    }],
    ["observation predates event", {
      observedEvent: event({ observedAt: "2026-10-17T13:59:20.000Z" }),
    }],
    ["owner start contradicts operation start", {
      storedOwner: owner({ startedAt: "2026-10-17T13:51:00.000Z" }),
    }],
  ];
  for (const [name, input] of cases) {
    await t.test(name, async () => {
      const { operation: currentOperation = operation(), ...serviceInput } = input;
      const assessment = await serviceFor(serviceInput).assess(currentOperation);
      assertAssessment(assessment, "UNKNOWN");
    });
  }

  await t.test("missing provider event probe", async () => {
    const assessment = await createOperationLivenessService({
      runtimeOwnerStore: { async read() { return owner(); } },
      ownerProbe: { async observe() { throw new Error("local process probe is not used for provider owners"); } },
      now: () => NOW,
    }).assess(operation());
    assertAssessment(assessment, "UNKNOWN");
  });
});
