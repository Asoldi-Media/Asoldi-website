import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clientIdentityBrief,
  compactClientIdentityLine,
  kundekortHref,
  persistClientBrief,
  salesKundekortView,
} from '../lib/sales-kundekort.js';

const client = {
  product: 'asoldi',
  businessName: 'JUNIPER',
  contactPerson: 'Are',
  contactEmail: 'person-8688c1@juniper.test',
  websiteEmail: 'hei@juniper.test',
  contactPhone: '22 00 00 01',
  industry: 'reklamebyrå',
  websiteDomain: 'juniper.test',
  orgNumber: '123456789',
  meetingPlace: 'Exampleveien 1, 0000 Testby',
  businessAddress: 'Exampleveien 1, 0000 Testby',
  notes: 'Salgsnotat her',
  details: {
    instagramUrl: 'https://www.instagram.com/example.shop/',
    facebookUrl: 'https://www.facebook.com/exampleshop/',
    proffUrl: 'https://www.proff.no/selskap/x/x/x/123456789',
    googleBusinessProfile: 'https://maps.google.com/?cid=1',
    otherLinks: 'https://tiktok.com/@juniper\nmailto:skip@example.com',
  },
};

test('salesKundekortView copies Kundekort page 1 fields and splits other links', () => {
  const view = salesKundekortView(client);
  assert.equal(view.productLabel, 'Nettside');
  assert.equal(view.businessName, 'JUNIPER');
  assert.equal(view.websiteEmail, 'hei@juniper.test');
  assert.equal(view.orgNumber, '123456789');
  assert.equal(view.instagramUrl, 'https://www.instagram.com/example.shop/');
  assert.deepEqual(view.otherLinks, ['https://tiktok.com/@juniper', 'mailto:skip@example.com']);
  assert.equal(view.notes, 'Salgsnotat her');
});

test('salesKundekortView reads a development item kundekort blob', () => {
  const view = salesKundekortView({ kundekort: salesKundekortView(client), notes: '' });
  assert.equal(view.facebookUrl, 'https://www.facebook.com/exampleshop/');
  assert.equal(view.industry, 'reklamebyrå');
});

test('empty clientBrief stays pending; compact line uses industry', () => {
  const brief = clientIdentityBrief(client);
  assert.equal(brief.ready, false);
  assert.equal(compactClientIdentityLine(client), 'reklamebyrå');
});

test('stored clientBrief is the card line and the full document text', () => {
  const withBrief = {
    ...client,
    clientBrief: persistClientBrief({
      short: 'Markedsplass i Norge.',
      full: 'JUNIPER er en markedsplass. Are driver den fra Testby.',
      source: 'sales-card',
    }),
  };
  assert.equal(compactClientIdentityLine(withBrief), 'Markedsplass i Norge.');
  const brief = clientIdentityBrief(withBrief);
  assert.equal(brief.ready, true);
  assert.match(brief.full, /Testby/);
});

test('kundekortHref opens links, mail, phone, and a bare domain', () => {
  assert.equal(kundekortHref('juniper.test', 'domain'), 'https://juniper.test');
  assert.equal(kundekortHref('person-8688c1@juniper.test', 'email'), 'mailto:person-8688c1@juniper.test');
  assert.equal(kundekortHref('22 00 00 01', 'phone'), 'tel:22000001');
  assert.equal(kundekortHref('https://www.instagram.com/example.shop/'), 'https://www.instagram.com/example.shop/');
  assert.equal(kundekortHref('mailto:hei@juniper.test'), 'mailto:hei@juniper.test');
  assert.equal(kundekortHref(''), '');
});
