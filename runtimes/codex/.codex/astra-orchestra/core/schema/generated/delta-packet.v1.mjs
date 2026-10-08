// GENERATED FILE. DO NOT EDIT.
import { validateAgainstSchema } from "../runtime-validator.mjs";

export const schema = Object.freeze({"$schema":"https://json-schema.org/draft/2020-12/schema","$id":"https://orchestra.dev/schemas/delta-packet.v1.schema.json","title":"Orchestra Delta Packet v1","type":"object","additionalProperties":false,"required":["schema","taskId","parentCandidateIdentity","baseCandidateGeneration","candidateGeneration","direction","discovery","confirmedFinding","correctionArea","revalidation"],"properties":{"schema":{"const":"orchestra.delta-packet.v1"},"taskId":{"type":"string","minLength":1},"parentCandidateIdentity":{"type":"string","minLength":1},"baseCandidateGeneration":{"type":"integer","minimum":0},"candidateGeneration":{"type":"integer","minimum":1},"direction":{"type":"object","additionalProperties":false,"required":["cause","change","preserve"],"properties":{"cause":{"type":"string","minLength":1},"change":{"type":"string","minLength":1},"preserve":{"type":"array","items":{"type":"string"}}}},"discovery":{"enum":["NONE","DIRECTED"]},"confirmedFinding":{"type":"object","additionalProperties":false,"required":["statement","evidenceRef"],"properties":{"statement":{"type":"string","minLength":1},"evidenceRef":{"type":"string","minLength":1}}},"correctionArea":{"type":"object","additionalProperties":false,"required":["allowedAreas","statement"],"properties":{"allowedAreas":{"type":"array","minItems":1,"uniqueItems":true,"items":{"type":"string","minLength":1}},"statement":{"type":"string","minLength":1}}},"revalidation":{"type":"array","minItems":1,"items":{"type":"string","minLength":1}}}});
export const schemaId = schema.$id;
export function validate(value) {
  return validateAgainstSchema(schema, value);
}
export default validate;
