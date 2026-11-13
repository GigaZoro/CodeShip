import * as Predicate from "effect/Predicate";
import { Tool } from "effect/ai";

type Json = unknown;
type JsonObject = { [key: string]: Json };

const isNullSchema = (value: Json) =>
  Predicate.isObject(value) && value.type === "null" && Object.keys(value).length === 1;

const isBareAnyOf = (value: Json): value is { anyOf: Array<Json> } =>
  Predicate.isObject(value) && Array.isArray(value.anyOf) && Object.keys(value).length === 1;

// A `Schema.fromJsonString` fallback. Advertised beside object shapes, it invites stringified input.
const isJsonStringSchema = (value: Json) =>
  Predicate.isObject(value) &&
  value.type === "string" &&
  value.contentMediaType === "application/json";

const SAFE_INTEGER_BOUNDS: Record<string, number> = {
  maximum: Number.MAX_SAFE_INTEGER,
  minimum: Number.MIN_SAFE_INTEGER,
};

const tagOf = (branch: JsonObject, key: string): Json => {
  const property = Predicate.isObject(branch.properties) ? branch.properties[key] : undefined;
  return Predicate.isObject(property) && Array.isArray(property.enum) && property.enum.length === 1
    ? property.enum[0]
    : undefined;
};

/** One object for a tagged union of objects: each property once, the tag listing every value. */
const mergeTaggedObjects = (branches: ReadonlyArray<Json>): JsonObject | undefined => {
  if (branches.length < 2) return undefined;
  const objects = branches.filter(
    (branch): branch is JsonObject & { properties: JsonObject } =>
      Predicate.isObject(branch) &&
      branch.type === "object" &&
      Predicate.isObject(branch.properties),
  );
  if (objects.length !== branches.length) return undefined;
  const tag = Object.keys(objects[0]!.properties).find((key) => {
    const values = objects.map((object) => tagOf(object, key));
    return values.every((value) => value !== undefined) && new Set(values).size === values.length;
  });
  if (tag === undefined) return undefined;
  const properties: JsonObject = {
    [tag]: { type: "string", enum: objects.map((object) => tagOf(object, tag)) },
  };
  for (const object of objects) {
    for (const [name, property] of Object.entries(object.properties)) {
      if (name === tag) continue;
      const seen = properties[name];
      if (seen === undefined) properties[name] = property;
      else if (JSON.stringify(seen) !== JSON.stringify(property)) {
        const options = Predicate.isObject(seen) && isBareAnyOf(seen) ? seen.anyOf : [seen];
        if (!options.some((option) => JSON.stringify(option) === JSON.stringify(property)))
          properties[name] = { anyOf: [...options, property] };
      }
    }
  }
  const requiredBy = objects.map((object) =>
    Array.isArray(object.required) ? object.required : [],
  );
  const requiredByAll = Object.keys(properties).filter(
    (name) => name !== tag && requiredBy.every((required) => required.includes(name)),
  );
  // `required` can only list keys every branch needs, so say which branches need the others.
  for (const name of Object.keys(properties)) {
    if (name === tag || requiredByAll.includes(name)) continue;
    const values = objects
      .filter((_, index) => requiredBy[index]!.includes(name))
      .map((object) => `'${String(tagOf(object, tag))}'`);
    if (values.length === 0) continue;
    const property = properties[name];
    const note = `Required when ${tag} is ${values.join(" or ")}.`;
    properties[name] = Predicate.isObject(property)
      ? {
          ...property,
          description:
            typeof property.description === "string" ? `${property.description} ${note}` : note,
        }
      : property;
  }
  return { type: "object", properties, required: [tag, ...requiredByAll] };
};

const compact = (schema: Json, optional: boolean): Json => {
  if (Array.isArray(schema)) return schema.map((item) => compact(item, false));
  if (!Predicate.isObject(schema)) return schema;
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  let result: JsonObject = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === "additionalProperties" && value === true) continue;
    if (SAFE_INTEGER_BOUNDS[key] === value) continue;
    result[key] =
      key === "properties" && Predicate.isObject(value)
        ? Object.fromEntries(
            Object.entries(value).map(([name, property]) => [
              name,
              compact(property, !required.has(name)),
            ]),
          )
        : compact(value, false);
  }
  if (Array.isArray(result.anyOf)) {
    const branches = result.anyOf
      .flatMap((branch) => (isBareAnyOf(branch) ? branch.anyOf : [branch]))
      .filter((branch) => !(optional && isNullSchema(branch)) && !isJsonStringSchema(branch));
    const { anyOf: _anyOf, ...rest } = result;
    const only = branches.length === 1 ? branches[0] : mergeTaggedObjects(branches);
    result = Predicate.isObject(only) ? { ...only, ...rest } : { ...rest, anyOf: branches };
  }
  return result;
};

/**
 * The input schema T3 advertises: no `additionalProperties: true`, safe-integer bounds, nested
 * `anyOf`, JSON-string fallbacks, or `null` branches of optional properties. A tagged union of
 * objects becomes one object whose properties name the tags that require them; decoding still
 * applies each tag's own schema.
 */
export const advertisedJsonSchema = (tool: Tool.Any) =>
  compact(Tool.getJsonSchema(tool), false) as ReturnType<typeof Tool.getJsonSchema>;

/** The shapes a value may take: each `anyOf` or `oneOf` branch, `true` as a shape that takes anything. */
const alternatives = (schema: Json): ReadonlyArray<JsonObject> => {
  if (schema === true) return [{}];
  if (!Predicate.isObject(schema)) return [];
  const branches = Array.isArray(schema.anyOf)
    ? schema.anyOf
    : Array.isArray(schema.oneOf)
      ? schema.oneOf
      : undefined;
  return branches === undefined || "properties" in schema
    ? [schema]
    : branches.flatMap(alternatives);
};

const takes = (shape: JsonObject, type: string) =>
  shape.type === undefined ||
  shape.type === type ||
  (Array.isArray(shape.type) && shape.type.includes(type));

const OPEN_KEYWORDS = ["patternProperties", "propertyNames", "allOf", "anyOf", "oneOf", "$ref"];

/**
 * A struct's properties, the only keys it keeps; none for a shape that may keep others. A struct
 * advertises `additionalProperties: true` or nothing and drops other keys; a record or a struct
 * with a rest keeps them.
 */
const closedProperties = (shape: JsonObject): JsonObject | undefined => {
  if (OPEN_KEYWORDS.some((keyword) => keyword in shape)) return undefined;
  if (shape.additionalProperties === false && shape.properties === undefined) return {};
  return Predicate.isObject(shape.properties) &&
    (shape.additionalProperties === undefined || typeof shape.additionalProperties === "boolean")
    ? shape.properties
    : undefined;
};

/**
 * The paths in `value` that `schema`, an advertised input schema, has no property for, such as
 * `providerAccounts` or `workspaceStrategy.startFromOrigin`. A server drops them while decoding.
 * Nothing is reported under a shape that may keep other keys or that this cannot read.
 */
export const unknownArguments = (schema: Json, value: unknown, path = ""): Array<string> => {
  if (Array.isArray(value)) {
    const items = alternatives(schema)
      .filter((shape) => takes(shape, "array"))
      .map((shape) => shape.items);
    if (!items.every(Predicate.isObject)) return [];
    return value.flatMap((item, index) =>
      unknownArguments({ anyOf: items }, item, `${path}[${index}]`),
    );
  }
  if (!Predicate.isObject(value)) return [];
  const shapes = alternatives(schema)
    .filter((shape) => takes(shape, "object"))
    .map(closedProperties);
  if (shapes.length === 0 || shapes.includes(undefined)) return [];
  return Object.entries(value).flatMap(([key, item]) => {
    if (item === undefined) return [];
    const at = path === "" ? key : `${path}.${key}`;
    const properties = shapes.flatMap((kept) =>
      kept !== undefined && Object.hasOwn(kept, key) ? [kept[key]] : [],
    );
    return properties.length === 0 ? [at] : unknownArguments({ anyOf: properties }, item, at);
  });
};
