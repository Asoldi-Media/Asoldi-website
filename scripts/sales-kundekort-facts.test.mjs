import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeExtraFacts, salesKundekortView } from '../lib/sales-kundekort.js';

test('extra facts keep a label and value and drop empty rows', () => {
  const facts = normalizeExtraFacts([
    { id: 'a', label: 'Åpningstid', value: '10–18' },
    { label: '', value: '' },
    { label: 'Parkering', value: 'Bak bygget' },
  ]);
  assert.equal(facts.length, 2);
  assert.equal(facts[0].value, '10–18');
  assert.equal(facts[1].label, 'Parkering');
  const view = salesKundekortView({
    businessName: 'Zorba',
    details: { extraFacts: facts },
  });
  assert.equal(view.extraFacts.length, 2);
  assert.equal(view.extraFacts[1].value, 'Bak bygget');
});
