import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildContextSearchQueries,
  classifyContextLinkKind,
  pickContextLinks,
  researchClientContextLinks,
  scoreContextLink,
} from '../lib/client-context-links.js';

const client = {
  id: 'c1',
  businessName: 'Frogner Grill',
  meetingPlace: 'Frognerveien 1, Oslo',
};

test('context queries ask for Trustpilot and local news, not Maps or email', () => {
  const queries = buildContextSearchQueries(client);
  assert.equal(queries.length, 2);
  assert.match(queries[0], /Trustpilot/i);
  assert.match(queries[1], /nyheter/i);
  assert.doesNotMatch(queries.join(' '), /maps|mailto/i);
});

test('only Trustpilot and known news hosts are keepable', () => {
  assert.equal(classifyContextLinkKind('https://www.trustpilot.com/review/frognergrill.no'), 'trustpilot');
  assert.equal(classifyContextLinkKind('https://www.adressa.no/nyheter/frogner-grill/'), 'news');
  assert.equal(classifyContextLinkKind('https://www.google.com/maps?cid=1'), '');
  assert.equal(classifyContextLinkKind('mailto:post@frognergrill.no'), '');
  assert.equal(classifyContextLinkKind('https://www.instagram.com/frognergrill/'), '');
});

test('a Trustpilot hit for another business is rejected', () => {
  const verdict = scoreContextLink({
    url: 'https://www.trustpilot.com/review/otherplace.no',
    title: 'Other Place Reviews',
    snippet: 'Read customer reviews of Other Place in Bergen.',
  }, client);
  assert.equal(verdict.keep, false);
  assert.equal(verdict.reason, 'name-not-in-result');
});

test('a matching news article is kept', () => {
  const picked = pickContextLinks([
    {
      url: 'https://www.adressa.no/nyheter/naeringsliv/frogner-grill-apner',
      title: 'Frogner Grill åpner ny sal i Oslo',
      snippet: 'Frogner Grill utvider i Frogner.',
      query: '"Frogner Grill" Oslo nyheter',
    },
    {
      url: 'https://maps.google.com/?cid=9',
      title: 'Frogner Grill - Google Maps',
      snippet: 'Find Frogner Grill on Maps',
    },
  ], client);
  assert.equal(picked.kept.length, 1);
  assert.equal(picked.kept[0].kind, 'news');
  assert.equal(picked.rejected.some((entry) => entry.reason === 'not-trustpilot-or-news'), true);
});

test('research pools search results without writing client data', async () => {
  const result = await researchClientContextLinks(client, {
    search: async (query) => {
      if (/Trustpilot/i.test(query)) {
        return [{
          url: 'https://www.trustpilot.com/review/frognergrill.no',
          title: 'Frogner Grill Reviews | Trustpilot',
          snippet: 'Frogner Grill is rated on Trustpilot.',
        }];
      }
      return [];
    },
  });
  assert.equal(result.clientId, 'c1');
  assert.equal(result.kept[0].kind, 'trustpilot');
  assert.ok(Array.isArray(result.queries));
});
