import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_EVENTS_PER_CALL,
  addressGroup,
  createSiteRequestLimits,
  createWindowLimiter,
  formFieldsProblem,
  normalizeTrafficEvents,
  sanitizeCommercePayload,
} from '../lib/site-public-guards.js';
import { assertClientFormAllowed, assertClientFormSize, resetClientFormLimitsForTests } from '../lib/client-forms.js';
import { resetSecurityCounters, securityCounters } from '../lib/security-counters.js';

test('the window limiter counts per key, refuses without counting and frees slots as the window moves', () => {
  let t = 0;
  const limiter = createWindowLimiter({ windowMs: 1000, max: 2, now: () => t });
  assert.equal(limiter.hit('a').ok, true);
  assert.equal(limiter.hit('a').ok, true);
  const refused = limiter.hit('a');
  assert.equal(refused.ok, false);
  assert.equal(refused.retryAfterSec, 1);
  assert.equal(limiter.hit('b').ok, true, 'keys are separate');
  t = 1000;
  assert.equal(limiter.hit('a').ok, true);
  const small = createWindowLimiter({ windowMs: 1000, max: 1, maxKeys: 3, now: () => t });
  for (const key of ['k1', 'k2', 'k3', 'k4', 'k5']) small.hit(key);
  assert.equal(small.size(), 3, 'memory stays bounded');
});

test('an address counts by its IPv6 /64, an IPv4-mapped address as its IPv4 address', () => {
  assert.equal(addressGroup('2001:db8:1:2::1'), '2001:db8:1:2::/64');
  assert.equal(addressGroup('2001:DB8:1:2:ffff:1:2:3'), '2001:db8:1:2::/64');
  assert.equal(addressGroup('[2001:db8:1:3::1]'), '2001:db8:1:3::/64');
  assert.equal(addressGroup('2001:db8::192.0.2.1'), '2001:db8:0:0::/64');
  assert.equal(addressGroup('fe80::1%eth0'), 'fe80:0:0:0::/64');
  assert.equal(addressGroup('::ffff:198.51.100.7'), '198.51.100.7');
  assert.equal(addressGroup('198.51.100.7'), '198.51.100.7');
  assert.equal(addressGroup(''), '');
  assert.equal(addressGroup('x'.repeat(100)).length, 64);
});

test('site request limits: per site and address without a credential; the credentialed server has a bucket of its own', () => {
  let t = 0;
  const limits = createSiteRequestLimits({ windowMs: 60_000, perSiteAddress: 3, perSite: 5, now: () => t });
  for (let i = 0; i < 3; i += 1) assert.equal(limits.take({ siteId: 's1', address: '192.0.2.1' }).ok, true);
  assert.equal(limits.take({ siteId: 's1', address: '192.0.2.1' }).ok, false);
  assert.equal(limits.take({ siteId: 's1', address: '192.0.2.2' }).ok, true);
  assert.equal(limits.take({ siteId: 's2', address: '192.0.2.1' }).ok, true, 'another site is not held up');
  assert.equal(limits.take({ siteId: 's1', address: '192.0.2.3' }).ok, true);
  assert.equal(limits.take({ siteId: 's1', address: '192.0.2.4' }).ok, false, 'the site bucket for calls without a credential (5) is full');
  for (let i = 0; i < 5; i += 1) assert.equal(limits.take({ siteId: 's1', address: '192.0.2.1', credentialValid: true }).ok, true, 'calls without the credential cannot use up the bucket of the site server');
  assert.equal(limits.take({ siteId: 's1', address: '192.0.2.1', credentialValid: true }).ok, false, 'the site server has its own per-site cap');
  t = 60_000;
  assert.equal(limits.take({ siteId: 's1', address: '192.0.2.1' }).ok, true);
  const v6 = createSiteRequestLimits({ windowMs: 60_000, perSiteAddress: 2, perSite: 100, now: () => t });
  assert.equal(v6.take({ siteId: 's1', address: '2001:db8:7:7::1' }).ok, true);
  assert.equal(v6.take({ siteId: 's1', address: '2001:db8:7:7::2' }).ok, true);
  assert.equal(v6.take({ siteId: 's1', address: '2001:db8:7:7::3' }).ok, false, 'new addresses in the same /64 do not reset the limit');
});

test('a soft site cap lets calls through past it, says so, and refuses only at the hard cap', () => {
  const limits = createSiteRequestLimits({ windowMs: 60_000, perSiteAddress: 1, perSite: 2, perSiteHard: 4, now: () => 0 });
  const answers = ['192.0.2.1', '192.0.2.2', '192.0.2.3', '192.0.2.4', '192.0.2.5'].map((address) => limits.take({ siteId: 's1', address }));
  assert.deepEqual(answers.map((a) => a.ok), [true, true, true, true, false]);
  assert.deepEqual(answers.map((a) => a.overSoft), [false, false, true, true, true]);
});

test('traffic events keep the fields the CMS stores, with its lengths, and drop the rest', () => {
  const now = Date.parse('2026-10-23T12:00:00Z');
  const events = normalizeTrafficEvents([
    { type: 'pageview', path: '/a', href: 'h'.repeat(1000), visitorId: 'v'.repeat(200), at: '2026-10-23T11:59:00Z', ms: 1234.4, extra: 'x', nested: { a: 1 } },
    { type: 'click', path: '/b', at: '2026-10-01T00:00:00Z', ms: -5 },
    { type: 'pageview', at: '2025-01-01T00:00:00Z' },
    { type: 'pageview', at: '2026-10-24T12:00:00Z' },
    { type: 'not a type!' },
    null,
    ['array'],
    'text',
  ], { now });
  assert.equal(events.length, 2);
  assert.deepEqual(Object.keys(events[0]).sort(), ['at', 'host', 'href', 'ms', 'path', 'referrer', 'sessionId', 'type', 'ua', 'visitorId']);
  assert.equal(events[0].href.length, 300);
  assert.equal(events[0].visitorId.length, 80);
  assert.equal(events[0].ms, 1234);
  assert.equal(events[1].ms, 0);
  const many = normalizeTrafficEvents(Array.from({ length: 500 }, () => ({ type: 'pageview' })), { now });
  assert.equal(many.length, MAX_EVENTS_PER_CALL);
  assert.deepEqual(normalizeTrafficEvents({ not: 'a list' }), []);
});

test('the commerce summary keeps known fields, bounds every value and refuses large or odd bodies', () => {
  const parsed = JSON.parse('{"orders":2,"revenue":"1000","aov":1e40,"__proto__":{"polluted":true},"topProducts":[{"name":"p","units":1,"constructor":{"x":1}}],"range":{"a":{"b":{"c":{"d":{"e":1}}}}},"other":1}');
  const result = sanitizeCommercePayload(parsed);
  assert.equal(result.ok, true);
  assert.deepEqual(Object.keys(result.payload).sort(), ['aov', 'orders', 'range', 'revenue', 'topProducts']);
  assert.equal(result.payload.aov, null);
  assert.equal(result.payload.topProducts[0].constructor, Object, 'no own constructor key is copied');
  assert.equal(Object.hasOwn(result.payload.topProducts[0], 'constructor'), false);
  assert.equal(result.payload.range.a.b.c.d, null, 'depth is bounded');
  assert.equal({}.polluted, undefined);
  assert.equal(sanitizeCommercePayload([]).ok, false);
  assert.equal(sanitizeCommercePayload(null).ok, false);
  assert.equal(sanitizeCommercePayload({ series: 'x'.repeat(70_000) }).reason, 'too-large');
});

test('form field limits: count, name length, value length and total size', () => {
  assert.equal(formFieldsProblem({ name: 'Kari', message: 'Hei' }), null);
  assert.equal(formFieldsProblem(Object.fromEntries(Array.from({ length: 41 }, (_, i) => [`f${i}`, 'x']))), 'too-many-fields');
  assert.equal(formFieldsProblem({ ['n'.repeat(101)]: 'x' }), 'field-name-too-long');
  assert.equal(formFieldsProblem({ message: 'x'.repeat(5001) }), 'field-too-long');
  assert.equal(formFieldsProblem(Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`f${i}`, 'x'.repeat(4500)]))), 'form-too-large');
  assert.throws(() => assertClientFormSize({ message: 'x'.repeat(5001) }), (error) => error.status === 413);
});

test('visitor forms are limited per site and address with the proxy-aware address, not the first forwarded entry', () => {
  resetClientFormLimitsForTests();
  const req = (forwardedFor) => ({ headers: { 'x-forwarded-for': forwardedFor }, socket: { remoteAddress: '127.0.0.1' }, get: () => '' });
  // A visitor that writes its own X-Forwarded-For entries is still counted by the address the proxy saw.
  for (let i = 0; i < 8; i += 1) assertClientFormAllowed(req(`10.9.9.${i}, 198.51.100.7`), { siteId: 'site-1' });
  assert.throws(() => assertClientFormAllowed(req('10.9.9.99, 198.51.100.7'), { siteId: 'site-1' }), (error) => error.status === 429 && error.retryAfterSec > 0);
  assertClientFormAllowed(req('198.51.100.7'), { siteId: 'site-2' });
  assertClientFormAllowed(req('198.51.100.7'), { siteId: 'site-1', credentialValid: true });
  resetClientFormLimitsForTests();
});

test('visitor forms from many addresses are still delivered past the soft site cap, counted, up to the hard ceiling', () => {
  resetClientFormLimitsForTests();
  resetSecurityCounters();
  const req = (address) => ({ headers: { 'x-forwarded-for': address }, socket: { remoteAddress: '127.0.0.1' }, get: () => '' });
  const warn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    let delivered = 0;
    let refused = 0;
    for (let i = 0; i < 1010; i += 1) {
      try {
        assertClientFormAllowed(req(`198.18.${Math.floor(i / 250)}.${i % 250}`), { siteId: 'busy-site' });
        delivered += 1;
      } catch (error) {
        assert.equal(error.status, 429);
        refused += 1;
      }
    }
    assert.equal(delivered, 1000, 'callers from many addresses cannot switch the form off at 120');
    assert.equal(refused, 10, 'the hard ceiling protects the inbox');
    assert.equal(securityCounters()['client-form-site-busy'].total, 890, 'every form past 120 is counted');
    assert.equal(warnings.filter((line) => line.includes('[client-forms]')).length, 1, 'logged once per site and window');
    assertClientFormAllowed(req('198.51.100.200'), { siteId: 'busy-site', credentialValid: true });
  } finally {
    console.warn = warn;
    resetClientFormLimitsForTests();
  }
});
