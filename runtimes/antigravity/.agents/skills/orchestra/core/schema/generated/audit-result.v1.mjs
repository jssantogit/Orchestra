// GENERATED FILE. DO NOT EDIT.
import { validateAgainstSchema } from "../runtime-validator.mjs";

export const schema = Object.freeze({"$schema":"https://json-schema.org/draft/2020-12/schema","$id":"orchestra.audit-result.v1","type":"object","additionalProperties":false,"required":["schema","taskId","candidateGeneration","verdict","findings"],"properties":{"schema":{"const":"orchestra.audit-result.v1"},"taskId":{"type":"string","minLength":1},"candidateGeneration":{"type":"integer","minimum":0},"verdict":{"enum":["PASS","BLOCKING_FINDING"]},"findings":{"type":"array","items":{"type":"object","additionalProperties":false,"required":["location","packetRequirement","issue","evidence"],"properties":{"location":{"type":"string","minLength":1},"packetRequirement":{"type":"string","minLength":1},"issue":{"type":"string","minLength":1},"evidence":{"type":"string","minLength":1}}}}}});
export const schemaId = schema.$id;
export function validate(value) {
  return validateAgainstSchema(schema, value);
}
export default validate;
