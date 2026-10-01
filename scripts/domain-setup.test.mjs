import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DOMAIN_HELP_BUY,
  DOMAIN_HELP_OWNED,
  HOSTINGER_NAMESERVERS,
  domainHelpLabel,
  domainHelpMessage,
  isValidDomainName,
  normalizeDomainInput,
  normalizeDomainSetup,
} from '../lib/domain-setup.js';

test('normalizes and validates domain names', () => {
  assert.equal(normalizeDomainInput('https://www.Cafe-Test.NO/meny'), 'cafe-test.no');
  assert.equal(isValidDomainName('cafe-test.no'), true);
  assert.equal(isValidDomainName('not a domain'), false);
  assert.equal(isValidDomainName(''), false);
});

test('domain help labels distinguish owned vs not owned', () => {
  assert.deepEqual(HOSTINGER_NAMESERVERS, ['ns1.dns-parking.com', 'ns2.dns-parking.com']);
  assert.equal(domainHelpLabel(DOMAIN_HELP_OWNED), 'Hjelp kunde sette opp navnservere på eid domene');
  assert.equal(domainHelpLabel(DOMAIN_HELP_BUY), 'Hjelp kunde sette opp navnservere på ikke-eid domene');
  assert.match(domainHelpMessage({ kind: DOMAIN_HELP_OWNED, domain: 'cafe.no', businessName: 'Cafe' }), /eier domenet/);
  assert.match(domainHelpMessage({ kind: DOMAIN_HELP_BUY, domain: 'cafe.no' }), /kjøpe domenet/);
});

test('normalizeDomainSetup keeps only known ownership and kinds', () => {
  const row = normalizeDomainSetup({
    domain: 'HTTPS://WWW.Example.COM',
    ownership: 'maybe',
    requestKind: DOMAIN_HELP_OWNED,
    helpBuy: '1',
  });
  assert.equal(row.domain, 'example.com');
  assert.equal(row.ownership, '');
  assert.equal(row.requestKind, DOMAIN_HELP_OWNED);
  assert.equal(row.helpBuy, true);
});
