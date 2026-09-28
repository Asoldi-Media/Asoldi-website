import test from 'node:test';
import assert from 'node:assert/strict';
import { SALES_SCRIPTS, getSalesScriptById, salesScriptCount } from '../lib/sales-scripts.js';

test('scripts catalog starts with ny møte tid as written', () => {
  assert.equal(salesScriptCount(), 1);
  assert.equal(SALES_SCRIPTS[0].id, 'ny-mote-tid');
  assert.equal(SALES_SCRIPTS[0].name, 'Ny møte tid');
  const body = getSalesScriptById('ny-mote-tid').body;
  assert.match(body, /\[eier\]/);
  assert.match(body, /\[tidspunkt for forrige møte\]/);
  assert.match(body, /\[bård\]/);
  assert.match(body, /\[ledig tid\]/);
  assert.match(body, /\[navn\]/);
  assert.doesNotMatch(body, /\{\{/);
});
