function typeMatches(expected, value) {
  const types = Array.isArray(expected) ? expected : [expected];
  return types.some((type) => {
    if (type === "null") return value === null;
    if (type === "array") return Array.isArray(value);
    if (type === "object") return value !== null && typeof value === "object" && !Array.isArray(value);
    if (type === "integer") return Number.isInteger(value);
    return typeof value === type;
  });
}

function escapePath(segment) {
  return String(segment).replaceAll("~", "~0").replaceAll("/", "~1");
}

function error(errors, path, keyword, message) {
  errors.push({ path, keyword, message });
}

function validateNode(schema, value, path, errors) {
  if (schema.const !== undefined && value !== schema.const) {
    error(errors, path, "const", `must equal ${JSON.stringify(schema.const)}`);
    return;
  }

  if (schema.enum && !schema.enum.some((item) => Object.is(item, value))) {
    error(errors, path, "enum", `must be one of ${schema.enum.join("|")}`);
    return;
  }

  if (schema.type && !typeMatches(schema.type, value)) {
    error(errors, path, "type", `must be ${Array.isArray(schema.type) ? schema.type.join("|") : schema.type}`);
    return;
  }

  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) error(errors, path, "minimum", `must be >= ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) error(errors, path, "maximum", `must be <= ${schema.maximum}`);
  }

  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) error(errors, path, "minLength", `must NOT have fewer than ${schema.minLength} characters`);
    if (schema.pattern && !(new RegExp(schema.pattern).test(value))) error(errors, path, "pattern", `must match pattern ${schema.pattern}`);
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) error(errors, path, "minItems", `must NOT have fewer than ${schema.minItems} items`);
    if (schema.uniqueItems && new Set(value.map((item) => JSON.stringify(item))).size !== value.length) error(errors, path, "uniqueItems", "must NOT contain duplicate items");
    if (schema.items) value.forEach((item, index) => validateNode(schema.items, item, `${path}/${index}`, errors));
    return;
  }

  if (value !== null && typeof value === "object") {
    const properties = schema.properties || {};
    for (const required of schema.required || []) {
      if (!Object.hasOwn(value, required)) error(errors, `${path}/${escapePath(required)}`, "required", `must have required property '${required}'`);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(properties, key)) error(errors, `${path}/${escapePath(key)}`, "additionalProperties", `must NOT have additional property '${key}'`);
      }
    }
    for (const [key, child] of Object.entries(properties)) {
      if (Object.hasOwn(value, key)) validateNode(child, value[key], `${path}/${escapePath(key)}`, errors);
    }
  }
}

export function validateAgainstSchema(schema, value) {
  const errors = [];
  validateNode(schema, value, "", errors);
  return { valid: errors.length === 0, errors };
}
