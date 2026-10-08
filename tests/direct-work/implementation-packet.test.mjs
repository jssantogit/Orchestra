import test from "node:test";
import assert from "node:assert/strict";

import {
  buildImplementationPacket,
  assessImplementationReadiness,
} from "../../core/workflow/implementation-packet.mjs";

const packetInput = Object.freeze({
  taskId: "dw-2",
  candidateGeneration: 0,
  goal: "Fix number formatting precision without changing unrelated formatting behavior.",
  direction: {
    cause: "formatNumber rounds before applying the requested precision",
    change: "apply requested precision before final string formatting",
    preserve: ["existing locale separators", "negative-number formatting"],
  },
  anchors: [
    { symbol: "formatNumber", testHint: "formatter precision" },
  ],
  scope: {
    allowedAreas: ["src/formatter.js", "test/formatter.test.js"],
    forbidden: ["src/parser.js"],
  },
  permissions: {
    discovery: "DIRECTED",
    tests: "READ_ONLY",
    sideEffects: [],
  },
  validation: ["node --test test/formatter.test.js"],
  failurePolicy: {
    selfCaused: "REPAIR",
    unrelatedOrUncertain: "RETURN_TO_CONTROL",
  },
});

test("buildImplementationPacket creates a canonical implementation-ready packet", () => {
  const packet = buildImplementationPacket(packetInput);
  assert.equal(packet.schema, "orchestra.implementation-packet.v1");
  assert.equal(packet.taskId, "dw-2");
  assert.deepEqual(assessImplementationReadiness(packet), {
    ready: true,
    reason: "IMPLEMENTATION_READY",
  });
});

test("readiness rejects a structurally missing direction as PACKET_INSUFFICIENT", () => {
  const packet = buildImplementationPacket(packetInput);
  const { direction, ...withoutDirection } = packet;
  assert.deepEqual(assessImplementationReadiness(withoutDirection), {
    ready: false,
    reason: "PACKET_INSUFFICIENT",
  });
});

test("readiness rejects unresolved diagnostic direction even when schema-valid", () => {
  const packet = buildImplementationPacket({
    ...packetInput,
    direction: {
      cause: "find the bug",
      change: "figure out what should change",
      preserve: [],
    },
  });
  assert.deepEqual(assessImplementationReadiness(packet), {
    ready: false,
    reason: "PACKET_INSUFFICIENT",
  });
});

test("readiness requires implementation scope and validation", () => {
  const packet = buildImplementationPacket(packetInput);
  assert.deepEqual(assessImplementationReadiness({
    ...packet,
    scope: { allowedAreas: [], forbidden: [] },
  }), {
    ready: false,
    reason: "PACKET_INSUFFICIENT",
  });
  assert.deepEqual(assessImplementationReadiness({ ...packet, validation: [] }), {
    ready: false,
    reason: "PACKET_INSUFFICIENT",
  });
});

test("packet anchors may identify symbols and tests without exact paths", () => {
  const packet = buildImplementationPacket({
    ...packetInput,
    anchors: [{ symbol: "formatNumber", testHint: "precision regression" }],
  });
  assert.deepEqual(packet.anchors, [{ symbol: "formatNumber", testHint: "precision regression" }]);
  assert.equal(assessImplementationReadiness(packet).ready, true);
});

test("buildImplementationPacket rejects non-canonical packet structure", () => {
  assert.throws(() => buildImplementationPacket({
    ...packetInput,
    permissions: { discovery: "BROWSE_EVERYTHING", tests: "READ_ONLY", sideEffects: [] },
  }), /schema/i);
});
