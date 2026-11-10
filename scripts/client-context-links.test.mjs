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
  businessName: 'Havnegata Grill',
  meetingPlace: 'Havnegata 1, Oslo',
};

const nordvik = {
  businessName: 'Nordvik Bydelskafe',
  websiteUrl: 'https://nordvikcafe.test',
};

test('one Google query uses the business name without quotes', () => {
  const queries = buildContextSearchQueries(client);
  assert.equal(queries.length, 1);
  assert.equal(queries[0], 'Havnegata Grill');
});

test('legal AS is stripped from the search name', () => {
  assert.equal(buildContextSearchQueries({
    businessName: 'Havnegata Grill AS',
    industry: 'restaurant',
  })[0], 'Havnegata Grill');
});

test('short names get the industry on the query', () => {
  assert.equal(buildContextSearchQueries({
    businessName: 'Kvist AS',
    industry: 'restaurant',
  })[0], 'Kvist restaurant');
});

test('a foreign restaurant with the same short name is dropped', () => {
  const verdict = scoreContextLink({
    url: 'https://www.tripadvisor.com/Restaurant_Review-g1-d1-Reviews-Restaurant_Kvist-Leiden_South_Holland_Province.html',
    title: 'RESTAURANT KVIST, Leiden - Restaurant Reviews',
    snippet: 'Restaurant Kvist in Leiden, Netherlands.',
  }, { businessName: 'Kvist', industry: 'restaurant' });
  assert.equal(verdict.keep, false);
  assert.equal(verdict.reason, 'not-norway');
});

test('Nordvik Bydelskafe is searched as typed and does not append the place', () => {
  const queries = buildContextSearchQueries({
    ...nordvik,
    place: 'Nordvik',
    meetingPlace: 'Nordvik',
  });
  assert.equal(queries[0], 'Nordvik Bydelskafe');
});

test('maps, email, Instagram and Google search pages are not kept', () => {
  assert.equal(scoreContextLink({
    url: 'https://www.google.com/maps?cid=1',
    title: 'Havnegata Grill',
    snippet: 'Havnegata Grill on Maps',
  }, client).keep, false);
  assert.equal(scoreContextLink({
    url: 'mailto:post@example.com',
    title: 'email',
    snippet: '',
  }, client).keep, false);
  assert.equal(scoreContextLink({
    url: 'https://www.instagram.com/havnegatagrill/',
    title: 'Havnegata Grill',
    snippet: 'Havnegata Grill on Instagram',
  }, client).keep, false);
  assert.equal(scoreContextLink({
    url: 'https://www.google.com/search?q=havnegata',
    title: 'Google',
    snippet: 'Havnegata Grill',
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

test('sharing one name word is not enough — Nordvik Golf is not the cafe', () => {
  const verdict = scoreContextLink({
    url: 'https://www.nordvikgolf.no/',
    title: 'Nordvik Golf',
    snippet: 'Velkommen til Nordvik Golf. Treningsstudio åpent hver dag.',
  }, nordvik);
  assert.equal(verdict.keep, false);
  assert.equal(verdict.reason, 'name-not-in-result');
});

test('directories, wikipedia and the own website are dropped', () => {
  assert.equal(scoreContextLink({
    url: 'https://www.1881.no/restaurant/lundsvik/nordvik-bydelscafe',
    title: 'Nordvik Bydelscafe, Lundsvik, Trondheim',
    snippet: 'Adressen til Nordvik Bydelscafe er Granveien 2',
  }, nordvik).reason, 'directory-duplicate');
  assert.equal(scoreContextLink({
    url: 'https://www.proff.no/selskap/nordvik-bydelscafe/lundsvik/912345678',
    title: 'Nordvik Bydelscafe - Org.nr. 912 345 678',
    snippet: 'Nordvik Bydelscafe. Org nr 912 345 678.',
  }, nordvik).reason, 'already-have');
  assert.equal(scoreContextLink({
    url: 'https://www.cylex.no/restaurant/nordvik-bydelskafe',
    title: 'Nordvik Bydelskafe, Lundsvik - Restaurant',
    snippet: 'Nordvik Bydelskafe, Lundsvik. Ring 400 00 000',
  }, nordvik).reason, 'directory-duplicate');
  assert.equal(scoreContextLink({
    url: 'https://restaurantguru.com/Nordvik-Bydelskafe-Lundsvik',
    title: 'Nordvik Bydelskafe, Lundsvik',
    snippet: 'Nordvik Bydelskafe in Lundsvik rated 3.2 out of 5',
  }, nordvik).reason, 'directory-duplicate');
  assert.equal(scoreContextLink({
    url: 'https://no.wikipedia.org/wiki/Nordvik',
    title: 'Nordvik – Wikipedia',
    snippet: 'Nordvik er en tidligere kommune i Sør-Trøndelag.',
  }, nordvik).reason, 'encyclopedia');
  assert.equal(scoreContextLink({
    url: 'https://nordvikcafe.test/meny',
    title: 'Meny | Nordvik Bydelskafe',
    snippet: 'Koselig nabolagskafé i Nordvik, Trondheim.',
  }, nordvik).reason, 'already-have');
});

test('news and independent reviews about this business are kept', () => {
  const picked = pickContextLinks([
    {
      url: 'https://www.avisagaula.no/nordvik-bydelskaf-gi-godt-skussmal',
      title: 'Nordvik bydelskafe: – Gi godt skussmål til stedet.',
      snippet: 'På Velferdssenteret på Lundsvik er det både eldreboliger og kafe.',
    },
    {
      url: 'https://www.trustpilot.com/review/nordvikcafe.test',
      title: 'Nordvik Bydelskafe Reviews | Trustpilot',
      snippet: 'Read reviews of Nordvik Bydelskafe in Trondheim.',
    },
    {
      url: 'https://www.thefork.no/restaurant/havnegata-grill-oslo',
      title: 'Havnegata Grill Oslo – TheFork',
      snippet: 'Book Havnegata Grill.',
    },
    {
      url: 'https://www.1881.no/nordvik-bydelskafe',
      title: 'Nordvik Bydelskafe',
      snippet: 'Nordvik Bydelskafe i Lundsvik',
    },
  ], nordvik);
  assert.equal(picked.kept.length, 2);
  assert.ok(picked.kept.some((entry) => entry.url.includes('avisagaula.no')));
  assert.ok(picked.kept.some((entry) => entry.url.includes('trustpilot.com')));
});

test('at most three extra links are kept', () => {
  const results = [1, 2, 3, 4].map((n) => ({
    url: `https://www.adressa.no/nyheter/havnegata-grill-${n}`,
    title: `Havnegata Grill sak ${n}`,
    snippet: 'Havnegata Grill i Oslo.',
  }));
  const picked = pickContextLinks(results, client);
  assert.equal(picked.kept.length, 3);
});

test('AI judge can drop directory-like leftovers and keep 0-3 novel links', async () => {
  const selected = await selectNovelContextLinks([
    { url: 'https://www.avisagaula.no/a', title: 'A', snippet: '', kind: 'news', score: 9 },
    { url: 'https://www.trustpilot.com/review/x', title: 'B', snippet: '', kind: 'reviews', score: 8 },
    { url: 'https://www.adressa.no/b', title: 'C', snippet: '', kind: 'news', score: 7 },
  ], nordvik, {
    maxKeep: 3,
    judge: async () => [{ url: 'https://www.avisagaula.no/a' }],
  });
  assert.equal(selected.length, 1);
  assert.equal(selected[0].url, 'https://www.avisagaula.no/a');
});

test('a news article that names the cafe in the snippet is keepable', () => {
  const verdict = scoreContextLink({
    url: 'https://www.avisagaula.no/12-pa-gata-er-du-fornoyd-med-lonna-di/s/5-156-10002',
    title: '12 på gata: Er du fornøyd med lønna di?',
    snippet: 'Daglig leder Nordvik bydelskafé. Vil ikke oppgi lønn.',
  }, nordvik);
  assert.equal(verdict.keep, true);
  assert.equal(verdict.kind, 'news');
});

test('google news feature about the cafe is kept even without a snippet', () => {
  const verdict = scoreContextLink({
    url: 'https://www.avisagaula.no/nordvik-bydelskaf-gi-godt-skussmal-til-stedet-det-er-litt-stas-med-buffeen/s/5-156-10003',
    title: 'Nordvik bydelskafé: – Gi godt skussmål til stedet. Det er litt stas med buffeen',
    snippet: '',
  }, nordvik);
  assert.equal(verdict.keep, true);
  assert.equal(verdict.kind, 'news');
});

test('a Nordvik news story that is not about the cafe is dropped', () => {
  const verdict = scoreContextLink({
    url: 'https://www.avisagaula.no/ny-gangvei-apnet-i-nordvik/s/5-156-10001',
    title: 'Nordvik og Leinstrand, Lokalnytt | Ny gangvei er åpnet',
    snippet: '',
  }, nordvik);
  assert.equal(verdict.keep, false);
  assert.equal(verdict.reason, 'name-not-in-result');
});

test('research uses the search callback and does not invent URLs', async () => {
  const seen = [];
  const result = await researchClientContextLinks(client, {
    search: async (query, { engine } = {}) => {
      seen.push({ query, engine: engine || 'google' });
      if (engine === 'google_news') return [];
      return [{
        url: 'https://www.trustpilot.com/review/havnegatagrill.no',
        title: 'Havnegata Grill Reviews | Trustpilot',
        snippet: 'Havnegata Grill in Oslo is rated on Trustpilot.',
      }];
    },
  });
  assert.deepEqual(seen, [
    { query: 'Havnegata Grill', engine: 'google' },
    { query: 'Havnegata Grill', engine: 'google_news' },
  ]);
  assert.equal(result.kept[0].url, 'https://www.trustpilot.com/review/havnegatagrill.no');
});
