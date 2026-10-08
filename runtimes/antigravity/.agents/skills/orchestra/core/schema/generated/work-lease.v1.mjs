// GENERATED FILE. DO NOT EDIT.
import { validateAgainstSchema } from "../runtime-validator.mjs";

export const schema = Object.freeze({"$schema":"https://json-schema.org/draft/2020-12/schema","$id":"orchestra.work-lease.v1","type":"object","additionalProperties":false,"required":["schema","projectLineage","workspaceId","taskId","generation","state","actor","capabilities","candidate"],"properties":{"schema":{"const":"orchestra.work-lease.v1"},"projectLineage":{"type":"string","minLength":1},"workspaceId":{"type":"string","minLength":1},"taskId":{"type":"string","minLength":1},"generation":{"type":"integer","minimum":0},"state":{"enum":["RESOLVING","IMPLEMENTING","CANDIDATE_READY","VERIFYING","ACCEPTANCE","DONE","BLOCKED","HUMAN_GATE"]},"actor":{"type":"object","additionalProperties":false,"required":["provider","sessionIdHash"],"properties":{"provider":{"type":"string","minLength":1},"sessionIdHash":{"type":"string","minLength":1}}},"capabilities":{"type":"array","uniqueItems":true,"items":{"type":"string"}},"candidate":{"type":["string","null"]}}});
export const schemaId = schema.$id;
export function validate(value) {
  return validateAgainstSchema(schema, value);
}
export default validate;
