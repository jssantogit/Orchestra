// GENERATED FILE. DO NOT EDIT.
import { validateAgainstSchema } from "../runtime-validator.mjs";

export const schema = Object.freeze({"$schema":"https://json-schema.org/draft/2020-12/schema","$id":"orchestra.runtime-event.v1","type":"object","additionalProperties":false,"required":["schema","eventId","taskId","type","timestamp","data"],"properties":{"schema":{"const":"orchestra.runtime-event.v1"},"eventId":{"type":"string","minLength":1},"taskId":{"type":"string","minLength":1},"type":{"type":"string","minLength":1},"timestamp":{"type":"string","minLength":1},"data":{"type":"object"}}});
export const schemaId = schema.$id;
export function validate(value) {
  return validateAgainstSchema(schema, value);
}
export default validate;
