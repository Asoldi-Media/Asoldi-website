import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildContextSearchQueries,
  pickContextLinks,
  researchClientContextLinks,
  scoreContextLink,
  selectNovelContextLinks,
} from '../lib/client-context-links.js';

const client = {
  id: 'c1',
  businessName: 'Frogner Grill',
  meetingPlace: 'Frognerveien 1, Oslo',
};

const byneset = {
  businessName: 'Byneset Bydelskafe',
  websiteUrl: 'https://bynesetcafe.no',
};

test('one Google query quotes each business-name word', () => {
  const queries = buildContextSearchQueries(client);
  assert.equal(queries.length, 1);
  assert.equal(queries[0], '"Frogner" "Grill"');
});

test('Byneset Bydelskafe is quoted per word and does not append the place', () => {
  const queries = buildContextSearchQueries({
    ...byneset,
    place: 'Byneset',
    meetingPlace: 'Byneset',
  });
  assert.equal(queries[0], '"Byneset" "Bydelskafe"');
});

test('maps, email, Instagram and Google search pages are not kept', () => {
  assert.equal(scoreContextLink({
    url: 'https://www.google.com/maps?cid=1',
    title: 'Frogner Grill',
    snippet: 'Frogner Grill on Maps',
  }, client).keep, false);
  assert.equal(scoreContextLink({
    url: 'mailto:post@frognergrill.no',
    title: 'email',
    snippet: '',
  }, client).keep, false);
  assert.equal(scoreContextLink({
    url: 'https://www.instagram.com/frognergrill/',
    title: 'Frogner Grill',
    snippet: 'Frogner Grill on Instagram',
  }, client).keep, false);
  assert.equal(scoreContextLink({
    url: 'https://www.google.com/search?q=frogner',
    title: 'Google',
    snippet: 'Frogner Grill',
  }, client).keep, false);
});

test('a result about another business is rejected', () => {
  const verdict = scoreContextLink({
    url: 'https://www.trustpilot.com/review/otherplace.no',
    title: 'Other Place Reviews',
    snippet: 'Read customer reviews of Other Place in Bergen.',
  }, client);
  assert.equal(verdict.keep, false);
  assert.equal(verdict.reason, 'name-not-in-result');
});

test('sharing one name word is not enough — Byneset Golf is not the cafe', () => {
  const verdict = scoreContextLink({
    url: 'https://www.bynesetgolf.no/',
    title: 'Byneset Golf',
    snippet: 'Velkommen til Byneset Golf. Treningsstudio åpent hver dag.',
  }, byneset);
  assert.equal(verdict.keep, false);
  assert.equal(verdict.reason, 'name-not-in-result');
});

test('directories, wikipedia and the own website are dropped', () => {
  assert.equal(scoreContextLink({
    url: 'https://www.1881.no/restaurant/spongdal/byneset-bydelscafe',
    title: 'Byneset Bydelscafe, Spongdal, Trondheim',
    snippet: 'Adressen til Byneset Bydelscafe er Bråmyra 2',
  }, byneset).reason, 'directory-duplicate');
  assert.equal(scoreContextLink({
    url: 'https://www.proff.no/selskap/byneset-bydelscafe/spongdal/997078748',
    title: 'Byneset Bydelscafe - Org.nr. 997 078 748',
    snippet: 'Byneset Bydelscafe. Org nr 997 078 748.',
  }, byneset).reason, 'already-have');
  assert.equal(scoreContextLink({
    url: 'https://www.cylex.no/restaurant/byneset-bydelskafe',
    title: 'Byneset Bydelskafe, Spongdal - Restaurant',
    snippet: 'Byneset Bydelskafe, Spongdal. Ring 928 35 560',
  }, byneset).reason, 'directory-duplicate');
  assert.equal(scoreContextLink({
    url: 'https://restaurantguru.com/Byneset-Bydelskafe-Spongdal',
    title: 'Byneset Bydelskafe, Spongdal',
    snippet: 'Byneset Bydelskafe in Spongdal rated 3.2 out of 5',
  }, byneset).reason, 'directory-duplicate');
  assert.equal(scoreContextLink({
    url: 'https://no.wikipedia.org/wiki/Byneset',
    title: 'Byneset – Wikipedia',
    snippet: 'Byneset er en tidligere kommune i Sør-Trøndelag.',
  }, byneset).reason, 'encyclopedia');
  assert.equal(scoreContextLink({
    url: 'https://bynesetcafe.no/meny',
    title: 'Meny | Byneset Bydelskafe',
    snippet: 'Koselig nabolagskafé i Byneset, Trondheim.',
  }, byneset).reason, 'already-have');
});

test('news and independent reviews about this business are kept', () => {
  const picked = pickContextLinks([
    {
      url: 'https://www.avisagaula.no/byneset-bydelskaf-gi-godt-skussmal',
      title: 'Byneset bydelskafe: – Gi godt skussmål til stedet.',
      snippet: 'På Velferdssenteret på Spongdal er det både eldreboliger og kafe.',
    },
    {
      url: 'https://www.trustpilot.com/review/bynesetcafe.no',
      title: 'Byneset Bydelskafe Reviews | Trustpilot',
      snippet: 'Read reviews of Byneset Bydelskafe.',
    },
    {
      url: 'https://www.thefork.no/restaurant/frogner-grill-oslo',
      title: 'Frogner Grill Oslo – TheFork',
      snippet: 'Book Frogner Grill.',
    },
    {
      url: 'https://www.1881.no/byneset-bydelskafe',
      title: 'Byneset Bydelskafe',
      snippet: 'Byneset Bydelskafe i Spongdal',
    },
  ], byneset);
  assert.equal(picked.kept.length, 2);
  assert.ok(picked.kept.some((entry) => entry.url.includes('avisagaula.no')));
  assert.ok(picked.kept.some((entry) => entry.url.includes('trustpilot.com')));
});

test('at most three extra links are kept', () => {
  const results = [1, 2, 3, 4].map((n) => ({
    url: `https://www.adressa.no/nyheter/frogner-grill-${n}`,
    title: `Frogner Grill sak ${n}`,
    snippet: 'Frogner Grill i Oslo.',
  }));
  const picked = pickContextLinks(results, client);
  assert.equal(picked.kept.length, 3);
});

test('AI judge can drop directory-like leftovers and keep 0-3 novel links', async () => {
  const selected = await selectNovelContextLinks([
    { url: 'https://www.avisagaula.no/a', title: 'A', snippet: '', kind: 'news', score: 9 },
    { url: 'https://www.trustpilot.com/review/x', title: 'B', snippet: '', kind: 'reviews', score: 8 },
    { url: 'https://www.adressa.no/b', title: 'C', snippet: '', kind: 'news', score: 7 },
  ], byneset, {
    maxKeep: 3,
    judge: async () => [{ url: 'https://www.avisagaula.no/a' }],
  });
  assert.equal(selected.length, 1);
  assert.equal(selected[0].url, 'https://www.avisagaula.no/a');
});

test('research uses the search callback and does not invent URLs', async () => {
  const seen = [];
  const result = await researchClientContextLinks(client, {
    search: async (query) => {
      seen.push(query);
      return [{
        url: 'https://www.trustpilot.com/review/frognergrill.no',
        title: 'Frogner Grill Reviews | Trustpilot',
        snippet: 'Frogner Grill is rated on Trustpilot.',
      }];
    },
  });
  assert.deepEqual(seen, ['"Frogner" "Grill"']);
  assert.equal(result.kept[0].url, 'https://www.trustpilot.com/review/frognergrill.no');
});
