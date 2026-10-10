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
  businessName: 'TASS',
  contactPerson: 'Are',
  contactEmail: 'are@tass.no',
  websiteEmail: 'hei@tass.no',
  contactPhone: '47 13 13 80',
  industry: 'reklamebyrå',
  websiteDomain: 'tass.no',
  orgNumber: '925992720',
  meetingPlace: 'Vasøyveien 103, 7167 Vallersund',
  businessAddress: 'Vasøyveien 103, 7167 Vallersund',
  notes: 'Salgsnotat her',
  details: {
    instagramUrl: 'https://www.instagram.com/tass.norge/',
    facebookUrl: 'https://www.facebook.com/tassnorge/',
    proffUrl: 'https://www.proff.no/selskap/x/x/x/925992720',
    googleBusinessProfile: 'https://maps.google.com/?cid=1',
    otherLinks: 'https://tiktok.com/@tass\nmailto:skip@x.com',
  },
};

test('salesKundekortView copies Kundekort page 1 fields and splits other links', () => {
  const view = salesKundekortView(client);
  assert.equal(view.productLabel, 'Nettside');
  assert.equal(view.businessName, 'TASS');
  assert.equal(view.websiteEmail, 'hei@tass.no');
  assert.equal(view.orgNumber, '925992720');
  assert.equal(view.instagramUrl, 'https://www.instagram.com/tass.norge/');
  assert.deepEqual(view.otherLinks, ['https://tiktok.com/@tass', 'mailto:skip@x.com']);
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
      full: 'TASS er en markedsplass. Are driver den fra Vallersund.',
      source: 'sales-card',
    }),
  };
  assert.equal(compactClientIdentityLine(withBrief), 'Markedsplass i Norge.');
  const brief = clientIdentityBrief(withBrief);
  assert.equal(brief.ready, true);
  assert.match(brief.full, /Vallersund/);
});

test('kundekortHref opens links, mail, phone, and a bare domain', () => {
  assert.equal(kundekortHref('tass.no', 'domain'), 'https://tass.no');
  assert.equal(kundekortHref('are@tass.no', 'email'), 'mailto:are@tass.no');
  assert.equal(kundekortHref('47 13 13 80', 'phone'), 'tel:47131380');
  assert.equal(kundekortHref('https://www.instagram.com/tass.norge/'), 'https://www.instagram.com/tass.norge/');
  assert.equal(kundekortHref('mailto:hei@tass.no'), 'mailto:hei@tass.no');
  assert.equal(kundekortHref(''), '');
});
