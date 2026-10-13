import { assertDelegationRequest } from "../domain/delegation.mjs";

const findingSchema = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["message"],
  properties: Object.freeze({
    code: Object.freeze({ type: "string", minLength: 1, maxLength: 128 }),
    message: Object.freeze({ type: "string", minLength: 1, maxLength: 2048 }),
    path: Object.freeze({ type: "string", minLength: 1, maxLength: 1024 }),
    reference: Object.freeze({ type: "string", minLength: 1, maxLength: 1024 }),
  }),
});

export const WORKER_REPORT_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: Object.freeze(["summary", "findings", "evidenceRefs"]),
  properties: Object.freeze({
    summary: Object.freeze({ type: "string", maxLength: 8192 }),
    findings: Object.freeze({ type: "array", maxItems: 32, items: findingSchema }),
    evidenceRefs: Object.freeze({
      type: "array",
      maxItems: 64,
      uniqueItems: true,
      items: Object.freeze({ type: "string", minLength: 1, maxLength: 1024 }),
    }),
  }),
});

export function buildWorkerEnvelope(request) {
  assertDelegationRequest(request);
  const packet = request.packet;

  return {
    objective: packet.goal,
    logicalRole: request.target.logicalRole,
    purpose: request.purpose,
    context: {
      direction: packet.direction,
      anchors: packet.anchors,
    },
    scope: packet.scope,
    validation: packet.validation,
    capabilities: [...request.authority.capabilities],
    prohibitions: {
      mutation: "FORBIDDEN",
      network: "FORBIDDEN",
      delegation: "FORBIDDEN",
    },
    outputContract: WORKER_REPORT_SCHEMA,
    limits: {
      timeoutMs: request.limits.timeoutMs,
      maxOutputBytes: request.limits.maxOutputBytes,
    },
  };
}
