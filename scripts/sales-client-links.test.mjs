import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDirectProffUrlFromOrgNumber,
  extractOrganizationNumberFromLead,
  extractOrganizationNumberFromText,
  fillProffUrlFromOrgNumber,
  isValidNorwegianOrgNumber,
  mergeKeptSalesDetailLinks,
  organizationNumberFromProffUrl,
  promoteGoogleBusinessFromOtherLinks,
  filterCustomOtherLinks,
  looksLikeEmailLink,
  looksLikeMapsOrGoogleBusinessLink,
  websiteUrlFromDomain,
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

test('existing Google Maps URL is not replaced, and extra maps/email leave other links', () => {
  const promoted = promoteGoogleBusinessFromOtherLinks(
    {
      googleBusinessProfile: 'https://maps.google.com/?cid=1',
      otherLinks: 'https://maps.google.com/?cid=2\nmailto:post@kafeen.no\npost@kafeen.no\nhttps://kafeen.no',
    },
    classify
  );
  assert.equal(promoted.googleBusinessProfile, 'https://maps.google.com/?cid=1');
  assert.equal(promoted.otherLinks, 'https://kafeen.no');
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

test('Norwegian org numbers extract from dots, hyphens, extra spaces, and NO prefix', () => {
  assert.equal(isValidNorwegianOrgNumber('936585345'), true);
  assert.equal(extractOrganizationNumberFromText('936.585.345'), '936585345');
  assert.equal(extractOrganizationNumberFromText('936-585-345'), '936585345');
  assert.equal(extractOrganizationNumberFromText('936  585  345'), '936585345');
  assert.equal(extractOrganizationNumberFromText('NO 936 585 345'), '936585345');
  assert.equal(extractOrganizationNumberFromText('Org.nr: 936585345'), '936585345');
});

test('MyPhoner Org. nummer and organisasjonsnr fields fill the org number', () => {
  assert.equal(
    extractOrganizationNumberFromLead({}, new Map([['orgnummer', '936.585.345']])),
    '936585345'
  );
  assert.equal(
    extractOrganizationNumberFromLead({}, new Map([['organisasjonsnr', '936 585 345']])),
    '936585345'
  );
  assert.equal(
    extractOrganizationNumberFromLead({ organizationNumber: '936585345' }, new Map()),
    '936585345'
  );
});

test('a checksum-valid org number in a random MyPhoner field is used', () => {
  assert.equal(
    extractOrganizationNumberFromLead(
      {},
      new Map([['notes', 'Se Brreg 936 585 345 Trondheim']])
    ),
    '936585345'
  );
});

test('pretty Proff URLs without a 9-digit org are replaced from MyPhoner org number', () => {
  const pretty = 'https://www.proff.no/selskap/byggmester-jan-overrein/trondheim/bygg-og-anleggsleverandorer/IFHM9VL0CVG';
  assert.equal(organizationNumberFromProffUrl(pretty), '');
  assert.equal(
    fillProffUrlFromOrgNumber(pretty, '936585345'),
    'https://www.proff.no/selskap/x/x/x/936585345'
  );
  assert.equal(
    fillProffUrlFromOrgNumber('', '936585345'),
    buildDirectProffUrlFromOrgNumber('936585345')
  );
});

test('an existing Proff URL that already has the org number is kept', () => {
  const current = 'https://www.proff.no/selskap/x/x/x/936585345';
  assert.equal(organizationNumberFromProffUrl(current), '936585345');
  assert.equal(fillProffUrlFromOrgNumber(current, '936585345'), current);
});

test('other links drop maps, emails, and copies of dedicated fields', () => {
  assert.equal(looksLikeEmailLink('mailto:post@kafeen.no'), true);
  assert.equal(looksLikeEmailLink('post@kafeen.no'), true);
  assert.equal(looksLikeEmailLink('https://post@kafeen.no'), true);
  assert.equal(looksLikeEmailLink('https://kafeen.no'), false);
  assert.equal(looksLikeMapsOrGoogleBusinessLink('https://www.google.com/maps/search/?api=1&query=Oslo'), true);
  const cleaned = filterCustomOtherLinks(
    [
      'https://maps.google.com/?cid=9',
      'mailto:hei@kafeen.no',
      'https://www.instagram.com/kafeen/',
      'https://kafeen.no/meny',
      'https://kafeen.no/meny',
    ].join('\n'),
    { instagramUrl: 'https://www.instagram.com/kafeen/' }
  );
  assert.equal(cleaned, 'https://kafeen.no/meny');
});

test('website URL mirrors the sales domain and ignores an email', () => {
  assert.equal(websiteUrlFromDomain('nordlys.no'), 'https://nordlys.no');
  assert.equal(websiteUrlFromDomain('https://www.Nordlys.no/kontakt'), 'https://nordlys.no');
  assert.equal(websiteUrlFromDomain('karpiakaneta@gmail.com'), '');
  assert.equal(websiteUrlFromDomain('https://Karpiakaneta@gmail.com/'), '');
  assert.equal(looksLikeEmailLink('https://Karpiakaneta@gmail.com/'), true);
});
