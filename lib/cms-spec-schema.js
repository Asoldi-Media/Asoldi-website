/**
 * cms-spec schema (WS6 §3.4, WS6.8; the `email` section is WS7.31): one validator for the
 * settings channel from Asoldi to a client CMS.
 *
 *   validateCmsSpec({ featureSpec?, sections?, force? }, { registry }) -> { ok, errors: [{ path, message }] }
 *
 * `featureSpec` is checked by the feature registry (registry.validateFeatureSpec), the sections by
 * the schemas below. Paths are exact (`featureSpec.defaults.shop.foo`, `sections.email.recovery.steps[1].delayMinutes`)
 * so a writer, human or AI, can fix the value it sent. Only canonical values pass: writers
 * normalize aliases before they send.
 *
 * Portable on purpose: no imports, the registry is passed in. The hub authored this copy first
 * (WS6.8); the CMS takes it as server/cms-spec-schema.js (WS6.9) and from then on
 * scripts/sync-cms-feature-tree.mjs copies it back here, so the hub, the CMS and the Maker validate
 * with the same code. Sections are append-only: never remove a section or a field, never narrow a type.
 */

export const CMS_SPEC_SCHEMA_VERSION = 1;

const KEY_RE = /^[a-z][a-zA-Z0-9_]{0,39}$/;
const EMAIL_RE = /^[^\s@<>"']{1,64}@[^\s@<>"']{1,190}\.[A-Za-z]{2,24}$/;
const HTTPS_RE = /^https:\/\/[^\s"'<>]{3,500}$/;
const PATH_RE = /^\/(?!\/)[^\s"'<>]{0,300}$/;
const TIME_RE = /^\d{2}:\d{2}$/;

// ---------------------------------------------------------------- schema builders

const str = (max = 200, extra = {}) => ({ t: 'string', max, ...extra });
const email = () => ({ t: 'string', max: 254, format: 'email' });
const link = () => ({ t: 'string', max: 500, format: 'https-or-path' });
const httpsUrl = () => ({ t: 'string', max: 500, format: 'https' });
const bool = () => ({ t: 'boolean' });
const int = (min, max) => ({ t: 'integer', min, max });
const oneOf = (values) => ({ t: 'enum', values });
const list = (of, max = 50, min = 0) => ({ t: 'array', of, max, min });
const obj = (fields, { required = [], open = false } = {}) => ({ t: 'object', fields, required, open });
const map = (of, max = 50) => ({ t: 'map', of, max });
const nullable = (schema) => ({ ...schema, nullable: true });
const label = () => ({ t: 'label' });

const named = (name, schema) => ({ ...schema, name });

const hoursSchema = {
  ...named('hours', obj(
    Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((day) => [day, list(list(str(5, { pattern: TIME_RE, hint: 'HH:MM' }), 2, 2), 4)])),
  )),
  doc: '{mon|tue|wed|thu|fri|sat|sun: [["HH:MM","HH:MM"]] up to 4 ranges a day}',
};

const discountSchema = named('discount', nullable(obj({
  type: oneOf(['percent', 'amount', 'free_shipping']),
  value: { t: 'number', min: 0, max: 100000 },
  validDays: int(1, 30),
  minSubtotal: { t: 'number', min: 0, max: 10000000 },
}, { required: ['type', 'validDays'] })));

const customFieldSchema = named('field', obj({
  key: str(40, { pattern: KEY_RE, hint: 'camelCase key' }),
  label: label(),
  type: oneOf(['text', 'textarea', 'number', 'boolean', 'select', 'multiselect', 'date', 'url', 'image', 'images', 'video', 'richtext', 'reference']),
  appliesTo: list(str(40), 10),
  public: bool(),
  filterable: bool(),
  options: list(str(80), 100),
}, { required: ['key', 'label', 'type'] }));

// The settings each section carries (owner in the comment). A field not listed here is an error.
export const SECTION_SCHEMAS = Object.freeze({
  // WS6
  general: obj({
    siteName: str(120),
    contactEmail: email(),
    phone: str(40),
    languages: list(str(10, { pattern: /^[a-z]{2}(-[A-Z]{2})?$/, hint: 'language code like nb or en' }), 10),
    currency: str(3, { pattern: /^[A-Z]{3}$/, hint: 'ISO currency like NOK' }),
  }),
  'shop.seller': obj({
    legalName: str(120),
    orgNumber: str(30),
    vatRegistered: bool(),
    foretaksregisteret: bool(),
    address: str(200),
    postal: str(20),
    city: str(80),
    email: email(),
    phone: str(40),
  }),
  'shop.tax': obj({ pricesIncludeTax: bool(), exportZeroRated: bool() }),
  'shop.shipping': obj({
    zones: list(obj({
      id: str(60),
      name: str(80),
      countries: list(str(2, { pattern: /^([A-Z]{2}|\*)$/, hint: 'country code like NO, or *' }), 250),
      methods: list(obj({
        id: str(60),
        type: oneOf(['flat', 'free', 'weight', 'pickup']),
        name: str(80),
        price: { t: 'number', min: 0, max: 1000000 },
        freeOver: { t: 'number', min: 0, max: 10000000 },
        minAmount: { t: 'number', min: 0, max: 10000000 },
        tiers: list(obj({ upToGrams: int(1, 10000000), price: { t: 'number', min: 0, max: 1000000 } }), 20),
        estimateMinDays: int(0, 90),
        estimateMaxDays: int(0, 90),
        pickupAddress: str(200),
        enabled: bool(),
      }, { required: ['type'] }), 20),
    }, { required: ['countries'] }), 30),
  }),
  'shop.checkout': obj({ buttonText: str(60), termsUrl: link(), reminderConsent: bool() }),
  'shop.mode': obj({ mode: oneOf(['sell', 'display', 'closed']) }, { required: ['mode'] }),
  'shop.orders': obj({ testMode: bool() }),
  'shop.bookings': obj({
    hours: hoursSchema,
    slotStepMinutes: int(5, 240),
    payMode: oneOf(['prepay', 'reserve', 'both']),
    location: str(200),
    staff: list(obj({ id: str(60), name: str(80), hours: hoursSchema, active: bool() }, { required: ['name'] }), 50),
  }),
  'shop.menuOrdering': obj({
    orderTypes: list(oneOf(['pickup', 'delivery', 'dineIn']), 3, 1),
    hoursSource: oneOf(['bookings', 'own']),
    hours: hoursSchema,
    prepMinutes: int(0, 600),
    slotMinutes: int(5, 240),
    slotCapacity: int(1, 1000),
    asap: bool(),
    deliveryZones: list(obj({
      postals: list(str(10, { pattern: /^[0-9A-Za-z -]{2,10}$/ }), 2000, 1),
      feeMinor: int(0, 10000000),
      minOrderMinor: int(0, 100000000),
    }, { required: ['postals'] }), 50),
  }),
  customFields: list(customFieldSchema, 100),
  contentTypes: list(obj({
    key: str(40, { pattern: KEY_RE, hint: 'camelCase key' }),
    label: label(),
    fields: list(customFieldSchema, 60, 1),
    route: obj({ index: link(), item: link() }),
    public: bool(),
    enabled: bool(),
  }, { required: ['key', 'label', 'fields'] }), 30),
  blog: obj({ categories: list(str(60), 50), defaultAuthor: str(120) }),
  reviews: obj({ googlePlaceId: str(200, { pattern: /^[A-Za-z0-9_-]{10,200}$/, hint: 'Google place id' }) }),
  social: obj(Object.fromEntries(['facebook', 'instagram', 'linkedin', 'tiktok', 'youtube', 'x'].map((name) => [name, httpsUrl()]))),
  'content.seed': map(list({ t: 'seed-entry' }, 200), 30),
  integrations: obj({
    ga4MeasurementId: str(30, { pattern: /^G-[A-Z0-9]{4,20}$/, hint: 'G-XXXXXXX' }),
    metaPixelId: str(30, { pattern: /^\d{5,20}$/, hint: 'digits only' }),
  }),
  legal: obj({
    mode: oneOf(['generated', 'external']),
    termsUrl: link(),
    privacyUrl: link(),
    cookiesUrl: link(),
    returnsDays: int(0, 365),
    complaintsEmail: email(),
  }),
  compliance: obj({ regulated: bool(), categories: list(str(60), 20), approvalRequired: bool(), source: str(60) }),
  wizards: list(obj({ id: str(60), title: str(120), steps: list({ t: 'any' }, 30), target: str(120) }, { required: ['id'], open: true }), 20),
  // WS7 (WS7.31): applied once per revision by the CMS email settings; a section the client edited is skipped.
  email: obj({
    rev: int(0, 1000000),
    sender: obj({ name: str(80), replyTo: email() }),
    identity: obj({ legalName: str(120), orgNumber: str(30), address: str(200), email: email() }),
    recovery: obj({
      enabled: bool(),
      steps: { ...list(obj({ delayMinutes: int(30, 43200), discount: discountSchema }, { required: ['delayMinutes'] }), 3, 1), increasing: 'delayMinutes' },
      discount: discountSchema,
    }),
    welcome: obj({ enabled: bool(), discount: discountSchema }),
    winback: obj({ enabled: bool(), afterDays: int(14, 730) }),
    reviewRequest: obj({ enabled: bool() }),
    campaigns: obj({ enabled: bool() }),
    ownerNotifications: obj({ checkoutStarted: oneOf(['off', 'instant', 'digest']), dailyDigest: bool() }),
    evidence: map(str(500), 30),
    features: { t: 'feature-flags', prefix: 'email.' },
  }),
});

/** Which workstream owns each section (shown in the prompt and the editor). */
export const SECTION_OWNERS = Object.freeze(
  Object.fromEntries(Object.keys(SECTION_SCHEMAS).map((name) => [name, name === 'email' ? 'WS7' : 'WS6'])),
);

export const SECTION_NAMES = Object.freeze(Object.keys(SECTION_SCHEMAS));

// ---------------------------------------------------------------- validation

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Own property only: a name like toString or constructor is never found through the prototype. */
function own(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

/** Key names that would change an object's prototype when merged; never valid anywhere in a spec. */
export const RESERVED_KEYS = Object.freeze(['__proto__', 'constructor', 'prototype']);

export function isSectionName(name) {
  return typeof name === 'string' && own(SECTION_SCHEMAS, name);
}

/**
 * Every object key in a value tree named __proto__, constructor or prototype, as errors sorted by
 * path. Walks without recursion, so a deeply nested body cannot exhaust the stack.
 */
export function reservedKeyErrors(value, path = '') {
  const errors = [];
  const stack = [[value, path]];
  while (stack.length) {
    const [node, at] = stack.pop();
    if (Array.isArray(node)) node.forEach((entry, i) => stack.push([entry, join(at, i)]));
    else if (isPlainObject(node)) {
      for (const key of Object.keys(node)) {
        if (RESERVED_KEYS.includes(key)) errors.push({ path: join(at, key), message: 'This key name is reserved' });
        else stack.push([node[key], join(at, key)]);
      }
    }
  }
  return errors.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

function join(path, key) {
  if (typeof key === 'number') return `${path}[${key}]`;
  return path ? `${path}.${key}` : key;
}

const EVIDENCE_TYPES = ['review', 'quote', 'url'];
const EVIDENCE_NEEDS = { review: 'reviewId', quote: 'transcriptRef', url: 'url' };

function checkSeedEntry(value, path, errors, ctx) {
  if (!isPlainObject(value)) {
    errors.push({ path, message: 'Must be an object (the entry fields, or {fields:{...}})' });
    return;
  }
  // Testimonials need evidence (WS6 §3.9): a review id, a transcript quote reference or a public URL.
  if (ctx.seedType !== 'testimonials') return;
  const fields = isPlainObject(value.fields) ? value.fields : value;
  const evidence = isPlainObject(value.evidence) ? value.evidence : isPlainObject(fields.evidence) ? fields.evidence : null;
  const evidencePath = join(path, 'evidence');
  if (!evidence) {
    errors.push({ path: evidencePath, message: 'A testimonial needs evidence: {type:"review"|"quote"|"url", reviewId | transcriptRef | url}' });
    return;
  }
  if (!EVIDENCE_TYPES.includes(evidence.type)) {
    errors.push({ path: join(evidencePath, 'type'), message: `Use one of: ${EVIDENCE_TYPES.join(', ')}` });
    return;
  }
  const need = EVIDENCE_NEEDS[evidence.type];
  const given = String(evidence[need] ?? '').trim();
  if (!given) errors.push({ path: join(evidencePath, need), message: `Evidence of type ${evidence.type} needs ${need}` });
  else if (evidence.type === 'url' && !HTTPS_RE.test(given)) errors.push({ path: join(evidencePath, 'url'), message: 'Must be an https URL' });
}

function checkFeatureFlags(schema, value, path, errors, ctx) {
  if (!isPlainObject(value)) {
    errors.push({ path, message: 'Must be an object of feature key: true|false' });
    return;
  }
  const byKey = ctx.registry ? new Map(ctx.registry.FEATURE_NODES.map((node) => [node.key, node])) : null;
  for (const [key, flag] of Object.entries(value)) {
    const at = join(path, key);
    if (!key.startsWith(schema.prefix)) errors.push({ path: at, message: `Only ${schema.prefix}* keys belong here` });
    else if (byKey && !byKey.has(key)) {
      const alias = ctx.registry.FEATURE_ALIASES?.[key];
      errors.push({ path: at, message: `Unknown feature key "${key}".${alias ? ` Use ${alias}.` : ''}` });
    } else if (byKey && byKey.get(key).type !== 'bool') errors.push({ path: at, message: `${key} is not an on/off key` });
    else if (typeof flag !== 'boolean') errors.push({ path: at, message: 'Must be true or false' });
  }
}

function checkFormat(schema, value, path, errors) {
  if (schema.format === 'email' && value && !EMAIL_RE.test(value)) errors.push({ path, message: 'Must be an email address' });
  if (schema.format === 'https' && value && !HTTPS_RE.test(value)) errors.push({ path, message: 'Must be an https URL' });
  if (schema.format === 'https-or-path' && value && !HTTPS_RE.test(value) && !PATH_RE.test(value)) {
    errors.push({ path, message: 'Must be an https URL or a site path starting with /' });
  }
  if (schema.pattern && value && !schema.pattern.test(value)) {
    errors.push({ path, message: `Has the wrong format${schema.hint ? ` (${schema.hint})` : ''}` });
  }
}

function check(schema, value, path, errors, ctx) {
  if (value === null && schema.nullable) return;
  switch (schema.t) {
    case 'any':
      return;
    case 'string':
      if (typeof value !== 'string') errors.push({ path, message: 'Must be text' });
      else if (value.length > schema.max) errors.push({ path, message: `At most ${schema.max} characters` });
      else checkFormat(schema, value, path, errors);
      return;
    case 'label':
      if (typeof value === 'string') {
        if (!value.trim() || value.length > 120) errors.push({ path, message: 'Must be 1-120 characters' });
      } else if (isPlainObject(value)) {
        for (const [lang, text] of Object.entries(value)) {
          if (!/^[a-z]{2}$/.test(lang) || typeof text !== 'string' || text.length > 120) {
            errors.push({ path: join(path, lang), message: 'Labels are {nb, en, ...}: text up to 120 characters' });
          }
        }
      } else errors.push({ path, message: 'Must be text or {nb, en}' });
      return;
    case 'boolean':
      if (typeof value !== 'boolean') errors.push({ path, message: 'Must be true or false' });
      return;
    case 'integer':
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value) || (schema.t === 'integer' && !Number.isInteger(value))) {
        errors.push({ path, message: schema.t === 'integer' ? 'Must be a whole number' : 'Must be a number' });
      } else if (value < schema.min || value > schema.max) errors.push({ path, message: `Must be between ${schema.min} and ${schema.max}` });
      return;
    case 'enum':
      if (!schema.values.includes(value)) errors.push({ path, message: `"${String(value).slice(0, 40)}" is not allowed. Use one of: ${schema.values.join(', ')}` });
      return;
    case 'array': {
      if (!Array.isArray(value)) {
        errors.push({ path, message: 'Must be a list' });
        return;
      }
      if (value.length > schema.max) errors.push({ path, message: `At most ${schema.max} entries` });
      if (value.length < (schema.min || 0)) errors.push({ path, message: `At least ${schema.min} entries` });
      value.slice(0, schema.max).forEach((entry, i) => check(schema.of, entry, join(path, i), errors, ctx));
      if (schema.increasing) {
        for (let i = 1; i < value.length; i += 1) {
          const prev = value[i - 1]?.[schema.increasing];
          const next = value[i]?.[schema.increasing];
          if (typeof prev === 'number' && typeof next === 'number' && next <= prev) {
            errors.push({ path: join(join(path, i), schema.increasing), message: `Must be larger than the step before (${prev})` });
          }
        }
      }
      return;
    }
    case 'object': {
      if (!isPlainObject(value)) {
        errors.push({ path, message: 'Must be an object' });
        return;
      }
      for (const key of schema.required || []) {
        if (value[key] === undefined) errors.push({ path: join(path, key), message: 'Required' });
      }
      for (const [key, entry] of Object.entries(value)) {
        if (own(schema.fields, key)) check(schema.fields[key], entry, join(path, key), errors, ctx);
        else if (!schema.open) errors.push({ path: join(path, key), message: `Unknown field. Allowed: ${Object.keys(schema.fields).join(', ')}` });
      }
      return;
    }
    case 'map': {
      if (!isPlainObject(value)) {
        errors.push({ path, message: 'Must be an object' });
        return;
      }
      const entries = Object.entries(value);
      if (entries.length > schema.max) errors.push({ path, message: `At most ${schema.max} entries` });
      for (const [key, entry] of entries.slice(0, schema.max)) {
        if (!/^[A-Za-z0-9_.-]{1,80}$/.test(key)) errors.push({ path: join(path, key), message: 'Keys are letters, digits, . _ and -' });
        else if (RESERVED_KEYS.includes(key)) errors.push({ path: join(path, key), message: 'This key name is reserved' });
        else check(schema.of, entry, join(path, key), errors, { ...ctx, seedType: key });
      }
      return;
    }
    case 'seed-entry':
      checkSeedEntry(value, path, errors, ctx);
      return;
    case 'feature-flags':
      checkFeatureFlags(schema, value, path, errors, ctx);
      return;
    default:
      errors.push({ path, message: 'Unsupported schema' });
  }
}

/** Errors for one section value ([] when valid). */
export function validateSection(name, value, { registry = null, prefix = 'sections' } = {}) {
  const path = prefix ? `${prefix}.${name}` : String(name);
  if (!isSectionName(name)) return [{ path, message: `Unknown section. Use one of: ${SECTION_NAMES.join(', ')}` }];
  const errors = reservedKeyErrors(value, path);
  if (errors.length) return errors;
  check(SECTION_SCHEMAS[name], value, path, errors, { registry });
  return errors;
}

const SPEC_TOP_FIELDS = ['featureSpec', 'sections', 'force'];

/**
 * Validate a spec write: { featureSpec?, sections?, force? }. A section set to null means "remove the
 * section" and is valid. A key named __proto__, constructor or prototype anywhere in the spec is
 * refused before anything else is checked. Returns { ok, errors }.
 */
export function validateCmsSpec(spec, { registry = null } = {}) {
  if (!isPlainObject(spec)) return { ok: false, errors: [{ path: '', message: 'The spec must be an object' }] };
  const reserved = reservedKeyErrors(spec);
  if (reserved.length) return { ok: false, errors: reserved };
  const errors = [];
  for (const key of Object.keys(spec)) {
    if (!SPEC_TOP_FIELDS.includes(key)) errors.push({ path: key, message: `Unknown field. Allowed: ${SPEC_TOP_FIELDS.join(', ')}` });
  }
  if (spec.featureSpec !== undefined) {
    if (!registry) errors.push({ path: 'featureSpec', message: 'The feature registry is not available' });
    else errors.push(...registry.validateFeatureSpec(spec.featureSpec, { prefix: 'featureSpec' }).errors);
  }
  if (spec.sections !== undefined) {
    if (!isPlainObject(spec.sections)) errors.push({ path: 'sections', message: 'Must be an object of section: settings' });
    else {
      for (const [name, value] of Object.entries(spec.sections)) {
        if (value === null) {
          if (!isSectionName(name)) errors.push({ path: `sections.${name}`, message: `Unknown section. Use one of: ${SECTION_NAMES.join(', ')}` });
          continue;
        }
        errors.push(...validateSection(name, value, { registry }));
      }
    }
  }
  if (spec.force !== undefined) {
    if (!Array.isArray(spec.force)) errors.push({ path: 'force', message: 'Must be a list of section names' });
    else {
      spec.force.forEach((name, i) => {
        if (!isSectionName(name)) errors.push({ path: `force[${i}]`, message: `Unknown section "${String(name).slice(0, 60)}"` });
      });
    }
  }
  return { ok: errors.length === 0, errors };
}

// ---------------------------------------------------------------- prompt text

const NAMED_TYPES = [hoursSchema, discountSchema, customFieldSchema];

function describe(schema, { expand = false } = {}) {
  if (schema.name && !expand) return schema.name;
  if (schema.doc) return schema.doc;
  const orNull = schema.nullable ? ' or null' : '';
  switch (schema.t) {
    case 'string': {
      if (schema.format === 'email') return `email${orNull}`;
      if (schema.format === 'https') return `https URL${orNull}`;
      if (schema.format === 'https-or-path') return `https URL or /path${orNull}`;
      return (schema.hint ? `text (${schema.hint})` : `text<=${schema.max}`) + orNull;
    }
    case 'label': return 'text or {nb,en}';
    case 'boolean': return 'bool';
    case 'integer': return `int ${schema.min}-${schema.max}`;
    case 'number': return `number ${schema.min}-${schema.max}`;
    case 'enum': return schema.values.join('|');
    case 'array': {
      const size = schema.min ? ` ${schema.min}-${schema.max}` : ` <=${schema.max}`;
      return `[${describe(schema.of)}]${size}${schema.increasing ? ` (${schema.increasing} increasing)` : ''}`;
    }
    case 'object': {
      const fields = Object.entries(schema.fields).map(([key, field]) => `${key}${(schema.required || []).includes(key) ? '*' : ''} ${describe(field)}`);
      return `{${fields.join(', ')}${schema.open ? ', ...' : ''}}${orNull}`;
    }
    case 'map': return `{key: ${describe(schema.of)}}`;
    case 'seed-entry': return 'entry';
    case 'feature-flags': return `{${schema.prefix}* key: bool}`;
    default: return 'any';
  }
}

/**
 * The section fields for AI writers and the editor's prompt button: the shared types once, then each
 * section with one line per field (* = required).
 */
export function sectionPromptLines(names = SECTION_NAMES) {
  const out = [`Types: ${NAMED_TYPES.map((type) => `${type.name} = ${describe(type, { expand: true })}`).join('; ')}`];
  for (const name of names) {
    if (!isSectionName(name)) continue;
    const schema = SECTION_SCHEMAS[name];
    if (name === 'content.seed') {
      out.push('content.seed: {typeKey: [entry]}, seeded once; testimonials entries need evidence {type review|quote|url, reviewId|transcriptRef|url}');
    } else if (schema.t === 'object' && !schema.open) {
      out.push(`${name}:`);
      for (const [key, field] of Object.entries(schema.fields)) {
        out.push(`  ${key}${(schema.required || []).includes(key) ? '*' : ''} ${describe(field)}`);
      }
    } else out.push(`${name}: ${describe(schema)}`);
  }
  return out;
}
