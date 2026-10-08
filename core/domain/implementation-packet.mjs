import { assertSchema, validateSchema } from "../schema/validator.mjs";

export const DISCOVERY_MODES = Object.freeze({
  NONE: "NONE",
  DIRECTED: "DIRECTED",
  INVESTIGATIVE: "INVESTIGATIVE",
});

const SCHEMA = "implementation-packet.v1.schema.json";

export function validateImplementationPacket(packet) {
  return validateSchema(SCHEMA, packet);
}

export function assertImplementationPacket(packet) {
  return assertSchema(SCHEMA, packet);
}
