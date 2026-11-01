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
  contactPhone: '40 00 08 41',
  industry: 'reklamebyrå',
  websiteDomain: 'juniper.test',
  orgNumber: '925992720',
  meetingPlace: 'Vasøyveien 103, 7167 Vallersund',
  businessAddress: 'Vasøyveien 103, 7167 Vallersund',
  notes: 'Salgsnotat her',
  details: {
    instagramUrl: 'https://www.instagram.com/tass.norge/',
    facebookUrl: 'https://www.facebook.com/tassnorge/',
    proffUrl: 'https://www.proff.no/selskap/x/x/x/925992720',
    googleBusinessProfile: 'https://maps.google.com/?cid=1',
    otherLinks: 'https://tiktok.com/@juniper\nmailto:skip@example.com',
  },
};

test('salesKundekortView copies Kundekort page 1 fields and splits other links', () => {
  const view = salesKundekortView(client);
  assert.equal(view.productLabel, 'Nettside');
  assert.equal(view.businessName, 'JUNIPER');
  assert.equal(view.websiteEmail, 'hei@juniper.test');
  assert.equal(view.orgNumber, '925992720');
  assert.equal(view.instagramUrl, 'https://www.instagram.com/tass.norge/');
  assert.deepEqual(view.otherLinks, ['https://tiktok.com/@juniper', 'mailto:skip@example.com']);
  assert.equal(view.notes, 'Salgsnotat her');
});

test('salesKundekortView reads a development item kundekort blob', () => {
  const view = salesKundekortView({ kundekort: salesKundekortView(client), notes: '' });
  assert.equal(view.facebookUrl, 'https://www.facebook.com/tassnorge/');
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
      full: 'JUNIPER er en markedsplass. Are driver den fra Vallersund.',
      source: 'sales-card',
    }),
  };
  assert.equal(compactClientIdentityLine(withBrief), 'Markedsplass i Norge.');
  const brief = clientIdentityBrief(withBrief);
  assert.equal(brief.ready, true);
  assert.match(brief.full, /Vallersund/);
});

test('kundekortHref opens links, mail, phone, and a bare domain', () => {
  assert.equal(kundekortHref('juniper.test', 'domain'), 'https://juniper.test');
  assert.equal(kundekortHref('person-8688c1@juniper.test', 'email'), 'mailto:person-8688c1@juniper.test');
  assert.equal(kundekortHref('40 00 08 41', 'phone'), 'tel:40000841');
  assert.equal(kundekortHref('https://www.instagram.com/tass.norge/'), 'https://www.instagram.com/tass.norge/');
  assert.equal(kundekortHref('mailto:hei@juniper.test'), 'mailto:hei@juniper.test');
  assert.equal(kundekortHref(''), '');
});
