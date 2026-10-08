// GENERATED FILE. DO NOT EDIT.
import { validateAgainstSchema } from "../runtime-validator.mjs";

export const schema = Object.freeze({"$schema":"https://json-schema.org/draft/2020-12/schema","$id":"orchestra.candidate.v1","type":"object","additionalProperties":false,"required":["schema","taskId","generation","identity","changedPaths"],"properties":{"schema":{"const":"orchestra.candidate.v1"},"taskId":{"type":"string","minLength":1},"generation":{"type":"integer","minimum":0},"identity":{"type":"string","minLength":1},"changedPaths":{"type":"array","items":{"type":"string"}},"workspaceFingerprint":{"type":["string","null"]},"head":{"type":["string","null"]}}});
export const schemaId = schema.$id;
export function validate(value) {
  return validateAgainstSchema(schema, value);
}
export default validate;
