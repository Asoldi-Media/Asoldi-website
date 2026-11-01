import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeStoredWebsiteEmail, resolveWebsiteEmail } from '../lib/sales-website-email.js';

test('website email is stored only when it differs from the contact email', () => {
  assert.equal(normalizeStoredWebsiteEmail('post@ivy.test', 'person-becafc@ivy.test'), 'post@ivy.test');
  assert.equal(normalizeStoredWebsiteEmail('person-becafc@ivy.test', 'person-becafc@ivy.test'), '');
  assert.equal(normalizeStoredWebsiteEmail('person-becafc@Ivy.test', 'person-becafc@ivy.test'), '');
  assert.equal(normalizeStoredWebsiteEmail('', 'person-becafc@ivy.test'), '');
});

test('website email falls back to the development card contact email', () => {
  assert.equal(resolveWebsiteEmail({ websiteEmail: 'post@ivy.test', contactEmail: 'person-becafc@ivy.test' }), 'post@ivy.test');
  assert.equal(resolveWebsiteEmail({ websiteEmail: '', contactEmail: 'person-becafc@ivy.test' }), 'person-becafc@ivy.test');
  assert.equal(resolveWebsiteEmail({ contactEmail: 'person-becafc@ivy.test' }), 'person-becafc@ivy.test');
  assert.equal(resolveWebsiteEmail({}), '');
});
