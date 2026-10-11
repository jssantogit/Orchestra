import { createHash } from "node:crypto";

import { assertRuntimeEvent } from "../domain/runtime-event.mjs";
import { normalizeAuthorizationActor } from "../policy/capability-authorization.mjs";

function clean(value, max = 300) {
  const text = typeof value === "string" ? value.trim() : "";
  return text.length > max ? text.slice(0, max) : text;
}

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function eventIdFor(body) {
  const hash = createHash("sha256").update(JSON.stringify(body)).digest("hex");
  return `event-${hash.slice(0, 24)}`;
}

export function createRuntimeEvent({ eventId = null, type, generation, taskId = null, actor = null, payload = {}, factualRef = null } = {}) {
  const normalizedType = clean(type, 120);
  if (!normalizedType) fail("RUNTIME_EVENT_TYPE_REQUIRED");
  if (!Number.isInteger(generation) || generation < 0) fail("RUNTIME_EVENT_GENERATION_INVALID");
  if (!payload || typeof payload !== "object" || Array.isArray(payload) || Object.keys(payload).length > 0) {
    fail("RUNTIME_EVENT_PAYLOAD_NOT_BOUNDED");
  }

  const normalizedActor = actor ? normalizeAuthorizationActor(actor) : null;
  if (actor && !normalizedActor) fail("RUNTIME_EVENT_ACTOR_INVALID");
  const body = {
    type: normalizedType,
    generation,
    taskId: taskId == null ? null : clean(taskId, 300),
    actor: normalizedActor,
  };
  const event = {
    schema: "orchestra.runtime-event.v1",
    eventId: clean(eventId, 300) || eventIdFor(body),
    type: body.type,
    generation: body.generation,
    taskId: body.taskId,
    ...(normalizedActor ? { actor: normalizedActor } : {}),
    payload: {},
  };
  // factualRef is deliberately excluded from the canonical event. Provider
  // adapters may carry it in a bounded provider-local envelope instead.
  void factualRef;
  assertRuntimeEvent(event);
  return Object.freeze({
    ...event,
    ...(event.actor ? { actor: Object.freeze({ ...event.actor }) } : {}),
    payload: Object.freeze({}),
  });
}
