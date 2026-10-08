import { assertSchema, validateSchema } from "../schema/validator.mjs";

const SCHEMA = "implementation-packet.v1.schema.json";

export const DISCOVERY_MODES = Object.freeze({
  NONE: "NONE",
  DIRECTED: "DIRECTED",
  INVESTIGATIVE: "INVESTIGATIVE",
});

export function validateImplementationPacket(value) {
  return validateSchema(SCHEMA, value);
}

export function assertImplementationPacket(value) {
  return assertSchema(SCHEMA, value);
}
