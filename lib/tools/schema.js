/**
 * MCP JSON Schema → DSH parameter-DSL conversion.
 *
 * Why this exists: a promoted `directTools` tool used to be registered with a
 * single freeform `args: { type: 'json' }` parameter. The model therefore saw NO
 * real parameter names, so it guessed — in live testing it called a browser
 * screenshot tool with `{ query: "homepage" }`, a parameter that does not exist.
 * That defeats the whole point of promoting a tool for zero-latency calls.
 *
 * Converting the server's published `inputSchema` into DSH's parameter DSL gives
 * the model the true names, types, enums, and requiredness. The conversion is
 * deliberately conservative: anything the DSL cannot express faithfully degrades
 * to `json` (an unconstrained but lossless node) rather than being described
 * incorrectly — a wrong schema is worse than a permissive one, because the model
 * would trust it.
 *
 * @module dsh-mcp-adapter/tools/schema
 */

/** Scalar JSON Schema types the DSL supports directly. */
const SCALARS = new Set(['string', 'number', 'integer', 'boolean', 'null']);

/** Guard against pathological nesting in a hostile or generated schema. */
const MAX_DEPTH = 6;

/**
 * Convert one MCP tool `inputSchema` into DSH tool parameters.
 *
 * @param {unknown} inputSchema - the server-published JSON Schema.
 * @returns {{parameters: object, passthrough: boolean}} the DSL parameters, and
 *   `passthrough: true` when conversion was not possible and the caller must fall
 *   back to a single freeform `args` object.
 */
export function mcpSchemaToParameters(inputSchema) {
  const fallback = {
    parameters: {
      args: { type: 'json', description: 'Arguments object for this tool, as published by the MCP server.' },
    },
    passthrough: true,
  };

  if (!isPlainObject(inputSchema)) return fallback;
  // MCP tools declare an object root; anything else cannot map onto the DSL's
  // implicit object root.
  if (inputSchema.type !== undefined && inputSchema.type !== 'object') return fallback;

  const properties = inputSchema.properties;
  if (!isPlainObject(properties)) return fallback;

  const names = Object.keys(properties);
  // A tool with no declared properties is genuinely argument-free; an empty
  // parameter map is the honest representation.
  if (names.length === 0) return { parameters: {}, passthrough: false };

  const required = new Set(Array.isArray(inputSchema.required) ? inputSchema.required.filter((r) => typeof r === 'string') : []);

  /** @type {Record<string, object>} */
  const parameters = {};
  for (const name of names) {
    // A property name must be a plain identifier-ish key; the DSL rejects symbols
    // and an exotic key would not survive round-tripping.
    if (typeof name !== 'string' || name.length === 0) return fallback;
    const converted = convertNode(properties[name], 1);
    parameters[name] = required.has(name) ? { ...converted, required: true } : converted;
  }
  return { parameters, passthrough: false };
}

/**
 * Convert one JSON Schema node into a DSL value node.
 * @param {unknown} node - the schema node.
 * @param {number} depth - current recursion depth.
 * @returns {object} a DSL value-schema node.
 */
function convertNode(node, depth) {
  if (!isPlainObject(node) || depth > MAX_DEPTH) return { type: 'json' };

  const annotations = {};
  if (typeof node.description === 'string' && node.description.length > 0) {
    annotations.description = node.description.slice(0, 500);
  }
  if (typeof node.title === 'string' && node.title.length > 0) annotations.title = node.title.slice(0, 120);

  // Constructs the DSL cannot express faithfully: keep them lossless as `json`.
  // (`oneOf` exists in the DSL but demands every branch convert cleanly, and real
  // MCP schemas mostly use these for optionality, which `json` already allows.)
  if (node.$ref !== undefined || node.anyOf !== undefined || node.allOf !== undefined || node.oneOf !== undefined || node.not !== undefined) {
    return { type: 'json', ...annotations };
  }

  // A union type (e.g. ["string","null"]) has no DSL equivalent.
  const type = node.type;
  if (Array.isArray(type)) return { type: 'json', ...annotations };

  if (type === 'object') {
    const properties = node.properties;
    if (!isPlainObject(properties) || Object.keys(properties).length === 0) {
      // An open object with no declared shape is exactly what `json` means.
      return { type: 'json', ...annotations };
    }
    const nestedRequired = new Set(Array.isArray(node.required) ? node.required.filter((r) => typeof r === 'string') : []);
    /** @type {Record<string, object>} */
    const nested = {};
    for (const key of Object.keys(properties)) {
      const child = convertNode(properties[key], depth + 1);
      nested[key] = nestedRequired.has(key) ? { ...child, required: true } : child;
    }
    return {
      type: 'object',
      properties: nested,
      // Openness is mandatory in the DSL; mirror the schema, defaulting to open so
      // a server that accepts extra keys is not misdescribed as closed.
      additionalProperties: node.additionalProperties === false ? false : true,
      ...annotations,
    };
  }

  if (type === 'array') {
    const items = node.items;
    // A tuple form (array of schemas) has no DSL equivalent.
    if (Array.isArray(items)) return { type: 'json', ...annotations };
    return {
      type: 'array',
      ...(isPlainObject(items) ? { items: convertNode(items, depth + 1) } : {}),
      ...annotations,
    };
  }

  if (typeof type === 'string' && SCALARS.has(type)) {
    const result = { type, ...annotations };
    const values = normalizeEnum(node.enum, type);
    if (values) result.enum = values;
    return result;
  }

  // No usable `type` at all.
  return { type: 'json', ...annotations };
}

/**
 * Keep an `enum` only when every member matches the declared scalar type, since
 * the DSL's enum is type-correct.
 * @param {unknown} values - the raw enum.
 * @param {string} type - the declared scalar type.
 * @returns {unknown[] | undefined} a clean enum, or undefined.
 */
function normalizeEnum(values, type) {
  if (!Array.isArray(values) || values.length === 0) return undefined;
  const matches = values.every((value) => {
    if (type === 'string') return typeof value === 'string';
    if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
    if (type === 'integer') return typeof value === 'number' && Number.isInteger(value);
    if (type === 'boolean') return typeof value === 'boolean';
    if (type === 'null') return value === null;
    return false;
  });
  return matches ? values : undefined;
}

/**
 * Test for a plain (non-array, non-null) object.
 * @param {unknown} value - candidate.
 * @returns {boolean} true when a plain object.
 */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
