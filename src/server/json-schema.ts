import { type TSchema, Type } from "typebox";

type JsonSchema = Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const warnedShapes = new Set<string>();

function unknownSchema(schema: unknown, reason: string): TSchema {
  if (!warnedShapes.has(reason)) {
    warnedShapes.add(reason);
    console.warn(`[pi] tool schema: ${reason}; treating it as unknown`);
  }
  return Type.Unknown(isRecord(schema) ? schemaOptions(schema) : {});
}

/** Keywords TypeBox can carry straight through to the model. `format` is deliberately dropped. */
function schemaOptions(schema: JsonSchema): Record<string, unknown> {
  const options: Record<string, unknown> = {};
  for (const key of [
    "title",
    "description",
    "default",
    "examples",
    "deprecated",
    "readOnly",
    "writeOnly",
  ]) {
    if (schema[key] !== undefined) options[key] = schema[key];
  }
  return options;
}

function copyNumberOptions(schema: JsonSchema, options: Record<string, unknown>): void {
  for (const key of ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf"]) {
    if (typeof schema[key] === "number") options[key] = schema[key];
  }
}

function copyStringOptions(schema: JsonSchema, options: Record<string, unknown>): boolean {
  if (schema.enum !== undefined) {
    if (!Array.isArray(schema.enum) || !schema.enum.every((value) => typeof value === "string")) {
      return false;
    }
    options.enum = [...schema.enum];
  }
  for (const key of ["minLength", "maxLength"]) {
    if (typeof schema[key] === "number") options[key] = schema[key];
  }
  if (typeof schema.pattern === "string") options.pattern = schema.pattern;
  return true;
}

function copyArrayOptions(schema: JsonSchema, options: Record<string, unknown>): void {
  for (const key of ["minItems", "maxItems", "uniqueItems"]) {
    if (typeof schema[key] === "number" || typeof schema[key] === "boolean") {
      options[key] = schema[key];
    }
  }
}

/**
 * Convert an MCP tool's JSON Schema to TypeBox. Only the shapes MCP servers emit are
 * needed; anything else becomes `Unknown` so one odd tool never stops boot.
 */
export function jsonSchemaToTypeBox(schema: unknown): TSchema {
  if (!isRecord(schema)) return unknownSchema(schema, "schema is not an object");

  const options = schemaOptions(schema);

  if (Array.isArray(schema.anyOf)) {
    if (schema.anyOf.length === 0) return unknownSchema(schema, "empty anyOf");
    return Type.Union(
      schema.anyOf.map((variant) => jsonSchemaToTypeBox(variant)) as [TSchema, ...TSchema[]],
      options,
    );
  }

  if (schema.type === "object" || (schema.type === undefined && schema.properties !== undefined)) {
    if (schema.properties !== undefined && !isRecord(schema.properties)) {
      return unknownSchema(schema, "object properties are not an object");
    }
    const required = new Set(
      Array.isArray(schema.required)
        ? schema.required.filter((name): name is string => typeof name === "string")
        : [],
    );
    const properties: Record<string, TSchema> = {};
    for (const [name, property] of Object.entries(schema.properties ?? {})) {
      const converted = jsonSchemaToTypeBox(property);
      properties[name] = required.has(name) ? converted : Type.Optional(converted);
    }
    return Type.Object(properties, options);
  }

  switch (schema.type) {
    case "string": {
      const stringOptions = { ...options };
      if (!copyStringOptions(schema, stringOptions)) {
        return unknownSchema(schema, "string enum contains a non-string value");
      }
      return Type.String(stringOptions);
    }
    case "number": {
      const numberOptions = { ...options };
      copyNumberOptions(schema, numberOptions);
      return Type.Number(numberOptions);
    }
    case "integer": {
      const integerOptions = { ...options };
      copyNumberOptions(schema, integerOptions);
      return Type.Integer(integerOptions);
    }
    case "boolean":
      return Type.Boolean(options);
    case "array": {
      if (schema.items === undefined) return unknownSchema(schema, "array has no items");
      const arrayOptions = { ...options };
      copyArrayOptions(schema, arrayOptions);
      return Type.Array(jsonSchemaToTypeBox(schema.items), arrayOptions);
    }
    case "null":
      return Type.Null(options);
    default:
      return unknownSchema(schema, `unsupported schema type ${JSON.stringify(schema.type)}`);
  }
}
