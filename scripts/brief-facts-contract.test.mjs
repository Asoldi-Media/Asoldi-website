// The delivery brief contract: scripts/schemas/delivery-brief.schema.json, its pinned hash and the
// synthetic fixtures in scripts/fixtures/delivery-brief/ (validated with the suite JSON-schema validator).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DELIVERY_BRIEF_FIXTURES_DIR,
  DELIVERY_BRIEF_SCHEMA_SHA256,
  checkSchemaHash,
  deliveryBriefSchema,
  readSchemaText,
  schemaTextHash,
  validateBriefFacts,
  validateDeliveryBrief,
} from '../lib/delivery-brief/facts-contract.js';
import { isFixturePhone } from '../packages/suite/core/llm/policy.js';

function fixtures() {
  return readdirSync(DELIVERY_BRIEF_FIXTURES_DIR)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => ({ name, brief: JSON.parse(readFileSync(join(DELIVERY_BRIEF_FIXTURES_DIR, name), 'utf8')) }));
}

function walkSchemas(node, visit, path = '') {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    node.forEach((child, index) => walkSchemas(child, visit, `${path}/${index}`));
    return;
  }
  visit(node, path);
  for (const [key, child] of Object.entries(node)) {
    if (key === 'enum' || key === 'const') continue;
    walkSchemas(child, visit, `${path}/${key}`);
  }
}

test('the schema file matches its pinned hash (CRLF and LF checkouts hash the same)', () => {
  const text = readSchemaText();
  const check = checkSchemaHash(text);
  assert.equal(check.ok, true, `schema hash ${check.actual} differs from the pinned ${check.expected}`);
  assert.equal(schemaTextHash(text.replace(/\r?\n/g, '\r\n')), DELIVERY_BRIEF_SCHEMA_SHA256);
  assert.equal(schemaTextHash(text.replace(/\r\n/g, '\n')), DELIVERY_BRIEF_SCHEMA_SHA256);
});

test('a changed schema fails the hash check', () => {
  const text = readSchemaText();
  const changed = text.replace('"maxLength": 400', '"maxLength": 401');
  assert.notEqual(changed, text);
  assert.equal(checkSchemaHash(changed).ok, false);
  const widened = JSON.stringify({ ...JSON.parse(text), title: 'other' }, null, 2);
  assert.equal(checkSchemaHash(widened).ok, false);
  assert.equal(checkSchemaHash(text, 'f'.repeat(64)).ok, false, 'a wrong pin fails too');
});

test('the schema is 2020-12, append-only and makes every field except schema optional', () => {
  const schema = deliveryBriefSchema();
  assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
  assert.equal(schema.title, 'asoldi.delivery-brief/1');
  assert.deepEqual(schema.required, ['schema']);
  assert.deepEqual(schema.properties.schema, { const: 'asoldi.delivery-brief/1' });
  assert.deepEqual(schema.$defs.facts.properties.schema, { const: 'asoldi.brief.facts/1' });
  const problems = [];
  walkSchemas(schema, (node, path) => {
    if (path && Array.isArray(node.required) && node.required.length) problems.push(`${path}: required`);
    if (node.additionalProperties === false) problems.push(`${path}: closed object`);
  });
  assert.deepEqual(problems, []);
});

test('at least six synthetic fixtures, covering tiers 1-3, a dual offer, a regulated claim and no transcripts', () => {
  const list = fixtures();
  assert.ok(list.length >= 6, `only ${list.length} fixtures`);
  const tiers = new Set(list.map(({ brief }) => brief.sitePlan?.tierId).filter(Boolean));
  for (const tier of ['tier-1-standard', 'tier-2-seo', 'tier-3-ecommerce']) assert.ok(tiers.has(tier), tier);
  assert.ok(list.some(({ brief }) => (brief.offer?.alternatives || []).length >= 2), 'dual offer');
  assert.ok(list.some(({ brief }) => brief.facts?.claims?.regulated?.domain && (brief.facts.claims.regulated.approvedClaims || []).length), 'regulated claim');
  assert.ok(list.some(({ brief }) => Array.isArray(brief.transcripts) && brief.transcripts.length === 0 && Array.isArray(brief.inputs?.meetings) && !brief.inputs.meetings.length), 'no transcripts');
});

test('every fixture and its facts block validate', () => {
  for (const { name, brief } of fixtures()) {
    const result = validateDeliveryBrief(brief);
    assert.equal(result.valid, true, `${name}: ${JSON.stringify(result.errors)}`);
    if (brief.facts) {
      const facts = validateBriefFacts(brief.facts);
      assert.equal(facts.valid, true, `${name} facts: ${JSON.stringify(facts.errors)}`);
    }
  }
});

test('broken briefs fail validation', () => {
  const base = fixtures().find(({ name }) => name === 'tier-3-shop.json').brief;
  const cases = {
    'wrong schema id': { ...base, schema: 'asoldi.delivery-brief/2' },
    'bad hash': { ...base, hash: 'md5:1234' },
    'unknown directive kind': { ...base, directives: [{ ...base.directives[0], kind: 'rewrite' }] },
    'quote over 400 characters': { ...base, directives: [{ ...base.directives[0], quote: 'x'.repeat(401) }] },
    'bad fact status': { ...base, factSources: { 'contact.phone': { kind: 'client', status: 'maybe' } } },
    'transcript ref without a sha256': { ...base, transcripts: [{ meetingId: 'm', sha256: 'abc', chars: 10 }] },
    'facts of another schema': { ...base, facts: { ...base.facts, schema: 'other/1' } },
    'stat value as text': { ...base, facts: { ...base.facts, claims: { stats: [{ id: 's1', value: 'mange' }] } } },
  };
  for (const [label, brief] of Object.entries(cases)) {
    assert.equal(validateDeliveryBrief(brief).valid, false, label);
  }
  assert.equal(validateDeliveryBrief({}).valid, false, 'schema is the one required field');
  assert.equal(validateDeliveryBrief({ schema: 'asoldi.delivery-brief/1', laterField: { any: true } }).valid, true, 'unknown fields are allowed (append-only)');
});

test('fixtures hold only reserved contact data', () => {
  for (const { name, brief } of fixtures()) {
    const text = JSON.stringify(brief);
    for (const email of text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) || []) {
      assert.match(email, /@example\.(com|org|net)$/, `${name}: ${email}`);
    }
    for (const phone of text.match(/\+47[\d ]{8,12}/g) || []) {
      assert.equal(isFixturePhone(phone), true, `${name}: ${phone}`);
    }
  }
});
