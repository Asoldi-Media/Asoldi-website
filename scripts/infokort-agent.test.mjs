import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyInfokortResult,
  attachRegistryDefaults,
  composeIdentityBrief,
  fillProvenPublicLinks,
  INFOKORT_MAPS_SEARCH_LIMIT,
  INFOKORT_ORGANIC_SEARCH_LIMIT,
  isRegistryBrief,
  normalizeInfokortSubmission,
  runInfokortAgent,
  scoreInfokortMatch,
} from '../lib/infokort-agent.js';

test('registry dump is replaced by industry + what they do', () => {
  assert.equal(isRegistryBrief('et enkeltpersonforetak registrert i Brønnøysundregistrene med org.nr. 912346285'), true);
  const brief = composeIdentityBrief({
    businessName: 'FJORDVIK BILPLEIE',
    industry: 'bilpleie',
    meetingPlace: 'Prøvegata 64, 4624 KRISTIANSAND S',
    extra: 'Fjordvik Bilpleie er et enkeltpersonforetak registrert i Brønnøysundregistrene.',
  });
  assert.match(brief.short, /bilpleie/i);
  assert.match(brief.short, /Kristiansand/i);
  assert.equal(isRegistryBrief(brief.short), false);
});

test('applyInfokortResult keeps an existing Maps CID when the agent leaves Maps empty', () => {
  const applied = applyInfokortResult(
    'client-1',
    {
      industry: 'bilpleie',
      meetingPlace: 'Prøvegata 64, 4624 KRISTIANSAND S',
      orgNumber: '912346285',
      websiteDomain: '',
      details: { instagramUrl: '', facebookUrl: '', googleBusinessProfile: '' },
      clientBrief: { short: 'Fjordvik Bilpleie er bilpleie i Kristiansand.' },
    },
    {
      persist: false,
      current: {
        orgNumber: '912346285',
        details: { googleBusinessProfile: 'https://maps.google.com/?cid=4000000000000000001' },
      },
    }
  );
  assert.equal(applied.details.googleBusinessProfile, 'https://maps.google.com/?cid=4000000000000000001');
  assert.equal(applied.orgNumber, '912346285');
});

test('normalizeInfokortSubmission stores host-only website, cid maps, and brief', () => {
  const submission = normalizeInfokortSubmission({
    industry: 'markedsplass',
    meetingPlace: 'Prøvegata 103, 7167 Vallersund',
    orgNumber: '912346919',
    websiteDomain: 'https://www.torgli.example/om-oss',
    instagramUrl: 'https://www.instagram.com/torgli.example/',
    facebookUrl: 'https://www.facebook.com/torgli.example.fb/',
    proffUrl: 'https://www.proff.no/selskap/torg/x/x/912346919',
    googleBusinessProfile: 'https://maps.google.com/?cid=4000000000000000002',
    briefShort: 'TORGLI er en markedsplass.',
    briefFull: 'TORGLI drives av Torg Kari Eksempelsen.',
  });
  assert.equal(submission.websiteDomain, 'torgli.example');
  assert.equal(submission.details.proffUrl, 'https://www.proff.no/selskap/x/x/x/912346919');
  assert.equal(submission.details.googleBusinessProfile, 'https://maps.google.com/?cid=4000000000000000002');
  assert.equal(submission.clientBrief.source, 'infokort-haiku');
  assert.match(submission.clientBrief.short, /TORGLI/);
});

test('scoreInfokortMatch accepts empty Fjordvik-style socials and alias industry', () => {
  const expected = {
    industry: 'bilverksted',
    websiteDomain: '',
    orgNumber: '912346285',
    meetingPlace: 'Prøvegata 64, 4624 KRISTIANSAND S',
    instagramUrl: '',
    facebookUrl: '',
    googleBusinessProfile: '',
  };
  const actual = {
    industry: 'bilpleie',
    websiteDomain: '',
    orgNumber: '912346285',
    meetingPlace: 'Prøvegata 64, 4624 Kristiansand S',
    details: {
      instagramUrl: '',
      facebookUrl: '',
      proffUrl: 'https://www.proff.no/selskap/x/x/x/912346285',
      googleBusinessProfile: '',
    },
  };
  const score = scoreInfokortMatch(expected, actual);
  assert.equal(score.ok, true, String(score.failed));
});

test('scoreInfokortMatch fails when industry is the leftover NACE', () => {
  const score = scoreInfokortMatch(
    { industry: 'markedsplass', websiteDomain: 'torgli.example', orgNumber: '912346919', instagramUrl: '', facebookUrl: '', googleBusinessProfile: '' },
    { industry: 'reklamebyrå', websiteDomain: 'torgli.example', orgNumber: '912346919', details: {} }
  );
  assert.equal(score.ok, false);
  assert.ok(score.failed.includes('industry'));
});

test('runInfokortAgent follows tools then submit_card without calling Claude', async () => {
  const calls = [];
  const chat = async ({ messages }) => {
    calls.push(messages.length);
    if (calls.length === 1) {
      return {
        content: [{
          type: 'tool_use',
          id: '1',
          name: 'brreg_get',
          input: { orgNumber: '912346919' },
        }],
        usage: {},
      };
    }
    return {
      content: [{
        type: 'tool_use',
        id: '2',
        name: 'submit_card',
        input: {
          industry: 'markedsplass',
          meetingPlace: 'Prøvegata 103, 7167 Vallersund',
          orgNumber: '912346919',
          websiteDomain: 'torgli.example',
          instagramUrl: '',
          facebookUrl: '',
          proffUrl: 'https://www.proff.no/selskap/x/x/x/912346919',
          googleBusinessProfile: '',
          briefShort: 'TORGLI er en markedsplass i Norge.',
        },
      }],
      usage: {},
    };
  };
  const result = await runInfokortAgent(
    { businessName: 'Torg Kari Eksempelsen', orgNumber: '912346919' },
    {
      chat,
      search: async () => [],
      mapsSearch: async () => ({ ok: true, results: [] }),
      readWebsite: async () => [],
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          navn: 'TORG KARI EKSEMPELSEN',
          organisasjonsnummer: '912346919',
          forretningsadresse: { adresse: ['Prøvegata 103'], postnummer: '7167', poststed: 'VALLERSUND' },
          hjemmeside: 'torgli.example',
        }),
      }),
    }
  );
  assert.equal(result.ok, true);
  assert.equal(result.submission.industry, 'markedsplass');
  assert.equal(result.submission.websiteDomain, 'torgli.example');
  const applied = applyInfokortResult('client-1', result.submission, {
    persist: true,
    update: (id, patch) => ({ id, ...patch }),
  });
  assert.equal(applied.id, 'client-1');
  assert.equal(applied.details.proffUrl, 'https://www.proff.no/selskap/x/x/x/912346919');
});

test('attachRegistryDefaults replaces a stale stored street with Brreg', async () => {
  const next = await attachRegistryDefaults(
    {
      industry: 'markedsplass',
      meetingPlace: 'Meieriveien 5',
      websiteDomain: 'torgli.example',
      orgNumber: '912346919',
      details: {},
    },
    { businessName: 'Torg Kari Eksempelsen', meetingPlace: 'Meieriveien 5', orgNumber: '912346919' },
    async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        navn: 'TORG KARI EKSEMPELSEN',
        organisasjonsnummer: '912346919',
        forretningsadresse: { adresse: ['Prøvegata 103'], postnummer: '7167', poststed: 'VALLERSUND' },
        hjemmeside: 'torgli.example',
      }),
    })
  );
  assert.match(next.meetingPlace, /Prøvegata 103/i);
});

test('fillProvenPublicLinks writes TORGLI socials and Maps from trading-name hits', async () => {
  const filled = await fillProvenPublicLinks(
    {
      industry: 'markedsplass',
      meetingPlace: 'Prøvegata 103 7167 VALLERSUND',
      websiteDomain: 'torgli.example',
      orgNumber: '912346919',
      details: {
        instagramUrl: '',
        facebookUrl: '',
        googleBusinessProfile: '',
        proffUrl: 'https://www.proff.no/selskap/x/x/x/912346919',
      },
    },
    { businessName: 'Torg Kari Eksempelsen', contactPhone: '22 00 00 01' },
    {
      readWebsite: async () => ([
        { url: 'https://www.instagram.com/torgli.example/', title: 'torgli.example', snippet: 'torgli.example' },
        { url: 'https://www.facebook.com/torgli.example.fb/', title: 'torgli.example', snippet: 'torgli.example' },
      ]),
      search: async () => [],
      mapsSearch: async () => ({
        ok: true,
        results: [{
          title: 'TORGLI',
          address: 'Prøvegata 103, 7167 Vallersund',
          phone: '22 00 00 01',
          website: 'https://torgli.example',
          cid: '4000000000000000002',
          mapsUrl: 'https://maps.google.com/?cid=4000000000000000002',
        }],
      }),
    }
  );
  const score = scoreInfokortMatch({
    industry: 'markedsplass',
    websiteDomain: 'torgli.example',
    orgNumber: '912346919',
    meetingPlace: 'Prøvegata 103, 7167 Vallersund',
    instagramUrl: 'https://www.instagram.com/torgli.example/',
    facebookUrl: 'https://www.facebook.com/torgli.example.fb/',
    googleBusinessProfile: 'https://maps.google.com/?cid=4000000000000000002',
  }, filled);
  assert.equal(score.ok, true, String(score.failed));
});

test('runInfokortAgent spends at most 2 Google searches and 1 Maps search', async () => {
  const searches = [];
  const maps = [];
  let step = 0;
  const chat = async () => {
    step += 1;
    if (step <= 5) {
      return {
        content: [{
          type: 'tool_use',
          id: String(step),
          name: 'google_search',
          input: { query: `query ${step} site:instagram.com` },
        }],
        usage: {},
      };
    }
    if (step <= 7) {
      return {
        content: [{
          type: 'tool_use',
          id: String(step),
          name: 'maps_search',
          input: { query: `maps ${step}` },
        }],
        usage: {},
      };
    }
    return {
      content: [{
        type: 'tool_use',
        id: 'done',
        name: 'submit_card',
        input: {
          industry: 'markedsplass',
          meetingPlace: 'Prøvegata 103, 7167 Vallersund',
          orgNumber: '912346919',
          websiteDomain: 'torgli.example',
          instagramUrl: '',
          facebookUrl: '',
          proffUrl: '',
          googleBusinessProfile: '',
          briefShort: 'TORGLI er en markedsplass.',
        },
      }],
      usage: {},
    };
  };
  const result = await runInfokortAgent(
    { businessName: 'Torg Kari Eksempelsen', orgNumber: '912346919' },
    {
      chat,
      search: async (query) => {
        searches.push(query);
        return [];
      },
      mapsSearch: async (query) => {
        maps.push(query);
        return { ok: true, results: [] };
      },
      readWebsite: async () => [],
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          navn: 'TORG KARI EKSEMPELSEN',
          organisasjonsnummer: '912346919',
          forretningsadresse: { adresse: ['Prøvegata 103'], postnummer: '7167', poststed: 'VALLERSUND' },
          hjemmeside: 'torgli.example',
        }),
      }),
    }
  );
  assert.equal(result.ok, true);
  assert.equal(searches.length, INFOKORT_ORGANIC_SEARCH_LIMIT);
  assert.equal(maps.length, INFOKORT_MAPS_SEARCH_LIMIT);
});

test('fillProvenPublicLinks leaves Fjordvik socials empty when search is empty', async () => {
  const filled = await fillProvenPublicLinks(
    {
      industry: 'bilpleie',
      meetingPlace: 'Prøvegata 64, 4624 Kristiansand S',
      websiteDomain: '',
      orgNumber: '912346285',
      details: {},
    },
    { businessName: 'FJORDVIK BILPLEIE' },
    { search: async () => [], mapsSearch: async () => ({ ok: true, results: [] }) }
  );
  assert.equal(filled.details.instagramUrl, '');
  assert.equal(filled.details.facebookUrl, '');
  assert.equal(filled.details.googleBusinessProfile, '');
});
