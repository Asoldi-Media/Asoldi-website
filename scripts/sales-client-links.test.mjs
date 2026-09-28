import test from 'node:test';
import assert from 'node:assert/strict';
import {
  fillProffUrlFromOrgNumber,
  mergeKeptSalesDetailLinks,
  promoteGoogleBusinessFromOtherLinks,
} from '../lib/sales-client-links.js';

function classify(url = '') {
  const value = String(url || '');
  if (value.includes('maps.google.') || value.includes('/maps') || value.includes('maps.app.goo.gl')) {
    return { kind: 'googleBusiness', url: value };
  }
  if (value.includes('instagram.com')) return { kind: 'instagram', url: value };
  return { kind: 'other', url: value };
}

test('MyPhoner empty payload keeps saved social, Proff and Maps URLs', () => {
  const merged = mergeKeptSalesDetailLinks(
    {
      instagramUrl: '',
      facebookUrl: '',
      proffUrl: '',
      googleBusinessProfile: '',
      otherLinks: '',
    },
    {
      instagramUrl: 'https://www.instagram.com/kafeen/',
      facebookUrl: 'https://www.facebook.com/kafeen/',
      proffUrl: 'https://www.proff.no/selskap/x/x/x/123456789',
      googleBusinessProfile: 'https://maps.google.com/?cid=1',
      otherLinks: 'https://kafeen.no',
    }
  );
  assert.equal(merged.instagramUrl, 'https://www.instagram.com/kafeen/');
  assert.equal(merged.facebookUrl, 'https://www.facebook.com/kafeen/');
  assert.equal(merged.proffUrl, 'https://www.proff.no/selskap/x/x/x/123456789');
  assert.equal(merged.googleBusinessProfile, 'https://maps.google.com/?cid=1');
  assert.equal(merged.otherLinks, 'https://kafeen.no');
});

test('incoming MyPhoner URLs still replace saved ones', () => {
  const merged = mergeKeptSalesDetailLinks(
    { instagramUrl: 'https://www.instagram.com/newhandle/' },
    { instagramUrl: 'https://www.instagram.com/oldhandle/' }
  );
  assert.equal(merged.instagramUrl, 'https://www.instagram.com/newhandle/');
});

test('Maps URL in other links moves into the Google field', () => {
  const promoted = promoteGoogleBusinessFromOtherLinks(
    {
      googleBusinessProfile: '',
      otherLinks: 'https://kafeen.no\nhttps://maps.google.com/?cid=42',
    },
    classify
  );
  assert.equal(promoted.googleBusinessProfile, 'https://maps.google.com/?cid=42');
  assert.equal(promoted.otherLinks, 'https://kafeen.no');
});

test('existing Google Maps URL is not replaced from other links', () => {
  const promoted = promoteGoogleBusinessFromOtherLinks(
    {
      googleBusinessProfile: 'https://maps.google.com/?cid=1',
      otherLinks: 'https://maps.google.com/?cid=2',
    },
    classify
  );
  assert.equal(promoted.googleBusinessProfile, 'https://maps.google.com/?cid=1');
  assert.equal(promoted.otherLinks, 'https://maps.google.com/?cid=2');
});

test('empty Proff URL is built from a 9-digit org number', () => {
  const url = fillProffUrlFromOrgNumber('', '934 327 497', {
    shouldResolve: (value) => !value,
    buildDirect: (orgnr) => `https://www.proff.no/selskap/x/x/x/${orgnr}`,
  });
  assert.equal(url, 'https://www.proff.no/selskap/x/x/x/934327497');
});

test('Proff URL is left empty without an org number', () => {
  const url = fillProffUrlFromOrgNumber('', '', {
    shouldResolve: () => true,
    buildDirect: () => 'https://www.proff.no/selskap/x/x/x/000000000',
  });
  assert.equal(url, '');
});
