// JSON out of model text, and a small JSON-schema validator (no dependencies).
// Every provider's output is validated here, so a schema means the same thing on Claude, Gemini and DeepSeek.

import { SchemaValidationError } from './errors.js';

/** First JSON object or array in a reply; handles ```json fences and prose around it. Returns undefined if none. */
export function extractJson(raw = '') {
  const source = String(raw ?? '').trim();
  if (!source) return undefined;
  const unfenced = source
    .replace(/^```(?:json|JSON)?\s*/, '')
    .replace(/\s*```\s*$/, '')
    .trim();
  try {
    return JSON.parse(unfenced);
  } catch {
    // fall through
  }
  const fence = source.match(/```(?:json|JSON)?\s*([\s\S]*?)```/);
  if (fence) {
    try {
      return JSON.parse(fence[1].trim());
    } catch {
      // fall through
    }
  }
  const starts = [unfenced.indexOf('{'), unfenced.indexOf('[')].filter((i) => i >= 0).sort((a, b) => a - b);
  for (const start of starts) {
    const close = unfenced[start] === '{' ? '}' : ']';
    let tries = 0;
    for (let end = unfenced.lastIndexOf(close); end > start && tries < 200; end = unfenced.lastIndexOf(close, end - 1), tries += 1) {
      try {
        return JSON.parse(unfenced.slice(start, end + 1));
      } catch {
        // try a shorter span
      }
    }
  }
  return undefined;
}

function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

function matchesType(value, type) {
  const actual = typeOf(value);
  if (type === 'number') return actual === 'number' || actual === 'integer';
  return actual === type;
}

function resolveRef(root, ref) {
  if (typeof ref !== 'string' || !ref.startsWith('#/')) return null;
  return ref
    .slice(2)
    .split('/')
    .map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~'))
    .reduce((node, key) => (node && typeof node === 'object' ? node[key] : undefined), root);
}

const FORMATS = {
  email: (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v),
  date: (v) => /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(v)),
  'date-time': (v) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v) && Number.isFinite(Date.parse(v)),
  uri: (v) => /^[a-z][a-z0-9+.-]*:/i.test(v),
};

/**
 * Validates `value` against a JSON schema subset: type, enum, const, properties, required,
 * additionalProperties, items, min/maxItems, min/maxLength, pattern, minimum/maximum (+exclusive),
 * multipleOf, anyOf, oneOf, allOf, not, $ref (#/...), format (email, date, date-time, uri).
 * @returns {{valid:boolean, errors:{path:string, message:string}[]}}
 */
export function validateJson(value, schema, { maxErrors = 50 } = {}) {
  const errors = [];
  const root = schema;
  const add = (path, message) => {
    if (errors.length < maxErrors) errors.push({ path: path || '/', message });
  };
  const check = (val, sch, path, depth) => {
    if (sch === true || sch === undefined || sch === null) return;
    if (sch === false) return add(path, 'no value is allowed here');
    if (depth > 64) return add(path, 'schema nesting too deep');
    if (sch.$ref) {
      const target = resolveRef(root, sch.$ref);
      if (!target) return add(path, `unresolved $ref ${sch.$ref}`);
      check(val, target, path, depth + 1);
    }
    if (sch.type !== undefined) {
      const types = Array.isArray(sch.type) ? sch.type : [sch.type];
      if (!types.some((t) => matchesType(val, t))) return add(path, `expected ${types.join('|')}, got ${typeOf(val)}`);
    }
    if (sch.enum && !sch.enum.some((option) => JSON.stringify(option) === JSON.stringify(val))) add(path, `must be one of ${JSON.stringify(sch.enum)}`);
    if (sch.const !== undefined && JSON.stringify(sch.const) !== JSON.stringify(val)) add(path, `must equal ${JSON.stringify(sch.const)}`);
    if (typeof val === 'string') {
      if (Number.isInteger(sch.minLength) && val.length < sch.minLength) add(path, `shorter than ${sch.minLength}`);
      if (Number.isInteger(sch.maxLength) && val.length > sch.maxLength) add(path, `longer than ${sch.maxLength}`);
      if (sch.pattern) {
        let re = null;
        try {
          re = new RegExp(sch.pattern, 'u');
        } catch {
          add(path, `invalid pattern ${sch.pattern}`);
        }
        if (re && !re.test(val)) add(path, `does not match ${sch.pattern}`);
      }
      if (sch.format && FORMATS[sch.format] && !FORMATS[sch.format](val)) add(path, `not a valid ${sch.format}`);
    }
    if (typeof val === 'number') {
      if (typeof sch.minimum === 'number' && val < sch.minimum) add(path, `less than ${sch.minimum}`);
      if (typeof sch.maximum === 'number' && val > sch.maximum) add(path, `greater than ${sch.maximum}`);
      if (typeof sch.exclusiveMinimum === 'number' && val <= sch.exclusiveMinimum) add(path, `not greater than ${sch.exclusiveMinimum}`);
      if (typeof sch.exclusiveMaximum === 'number' && val >= sch.exclusiveMaximum) add(path, `not less than ${sch.exclusiveMaximum}`);
      if (typeof sch.multipleOf === 'number' && sch.multipleOf > 0 && Math.abs(val / sch.multipleOf - Math.round(val / sch.multipleOf)) > 1e-9) add(path, `not a multiple of ${sch.multipleOf}`);
    }
    if (Array.isArray(val)) {
      if (Number.isInteger(sch.minItems) && val.length < sch.minItems) add(path, `fewer than ${sch.minItems} items`);
      if (Number.isInteger(sch.maxItems) && val.length > sch.maxItems) add(path, `more than ${sch.maxItems} items`);
      if (sch.items && typeof sch.items === 'object') val.forEach((item, i) => check(item, sch.items, `${path}/${i}`, depth + 1));
    }
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      const props = sch.properties || {};
      for (const key of sch.required || []) if (!Object.prototype.hasOwnProperty.call(val, key)) add(`${path}/${key}`, 'is required');
      for (const [key, child] of Object.entries(val)) {
        if (Object.prototype.hasOwnProperty.call(props, key)) check(child, props[key], `${path}/${key}`, depth + 1);
        else if (sch.additionalProperties === false) add(`${path}/${key}`, 'is not allowed');
        else if (sch.additionalProperties && typeof sch.additionalProperties === 'object') check(child, sch.additionalProperties, `${path}/${key}`, depth + 1);
      }
    }
    if (Array.isArray(sch.allOf)) sch.allOf.forEach((sub) => check(val, sub, path, depth + 1));
    if (Array.isArray(sch.anyOf) && !sch.anyOf.some((sub) => validateJson(val, { ...sub, $defs: root?.$defs, definitions: root?.definitions }).valid)) {
      add(path, 'does not match any allowed shape (anyOf)');
    }
    if (Array.isArray(sch.oneOf)) {
      const hits = sch.oneOf.filter((sub) => validateJson(val, { ...sub, $defs: root?.$defs, definitions: root?.definitions }).valid).length;
      if (hits !== 1) add(path, `matches ${hits} shapes; exactly one is required (oneOf)`);
    }
    if (sch.not && validateJson(val, { ...sch.not, $defs: root?.$defs, definitions: root?.definitions }).valid) add(path, 'matches a forbidden shape (not)');
  };
  check(value, schema, '', 0);
  return { valid: errors.length === 0, errors };
}

/** The bare JSON schema from either `{name, schema}` (facade shape) or a schema object. */
export function unwrapSchema(schema) {
  if (!schema || typeof schema !== 'object') return null;
  if (schema.schema && typeof schema.schema === 'object' && !schema.type && !schema.properties) return schema.schema;
  return schema;
}

/**
 * Parses model text as JSON and validates it. Throws SchemaValidationError (code schema_invalid) with the
 * validator's errors, so the router can fall back to the next provider.
 */
export function parseJsonOutput(text, schema = null) {
  const data = extractJson(text);
  if (data === undefined) throw new SchemaValidationError('The model did not return JSON.', { errors: [{ path: '/', message: 'no JSON found' }] });
  const bare = unwrapSchema(schema);
  if (bare) {
    const result = validateJson(data, bare);
    if (!result.valid) throw new SchemaValidationError(`The model's JSON does not match the schema (${result.errors.length} problem(s)).`, { errors: result.errors, data });
  }
  return data;
}
