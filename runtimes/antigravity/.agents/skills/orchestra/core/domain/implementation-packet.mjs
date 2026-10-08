import { assertSchema, validateSchema } from '../schema/validator.mjs';

export const DISCOVERY_MODES = Object.freeze({
  NONE: 'NONE',
  DIRECTED: 'DIRECTED',
  INVESTIGATIVE: 'INVESTIGATIVE',
});

export function validateImplementationPacket(packet) {
  return validateSchema('implementation-packet.v1.schema.json', packet);
}

export function assertImplementationPacket(packet) {
  return assertSchema('implementation-packet.v1.schema.json', packet);
}
