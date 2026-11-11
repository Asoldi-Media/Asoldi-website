// Contract fixtures shared with the Maker: synthetic briefs that must validate against the hub's
// delivery brief schema, plus the schema hash both repos pin.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkSchemaHash, readSchemaText, validateDeliveryBrief } from '../lib/delivery-brief/facts-contract.js';

const DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'delivery-brief', 'contract');
const PINNED_SHA = '8586fb0b764618020e39e0f13db5caa840293a448d13ed7005d6d31c421fb963';
const files = readdirSync(DIR).filter((name) => name.endsWith('.json')).sort();

test('the contract fixtures exist', () => {
  assert.ok(files.length >= 5, `expected at least 5 contract fixtures, found ${files.length}`);
});

test('the hub schema hash equals the hash the Maker vendors', () => {
  const check = checkSchemaHash(readSchemaText(), PINNED_SHA);
  assert.equal(check.ok, true, `schema hash ${check.actual} differs from ${PINNED_SHA}`);
  assert.equal(checkSchemaHash(readSchemaText().replace('"maxLength": 400', '"maxLength": 401'), PINNED_SHA).ok, false);
});

for (const name of files) {
  test(`contract fixture ${name} validates`, () => {
    const brief = JSON.parse(readFileSync(join(DIR, name), 'utf8'));
    const result = validateDeliveryBrief(brief);
    assert.deepEqual(result.errors, []);
    assert.equal(result.valid, true);
  });
}

test('a fixture with a wrong schema marker fails validation', () => {
  const brief = JSON.parse(readFileSync(join(DIR, files[0]), 'utf8'));
  assert.equal(validateDeliveryBrief({ ...brief, schema: 'other/1' }).valid, false);
});
