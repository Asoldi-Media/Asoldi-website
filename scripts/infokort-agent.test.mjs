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
  assert.equal(isRegistryBrief('et enkeltpersonforetak registrert i Brønnøysundregistrene med org.nr. 937366221'), true);
  const brief = composeIdentityBrief({
    businessName: 'BAKKES BILPLEIE',
    industry: 'bilpleie',
    meetingPlace: 'Bråvann platå 64, 4624 KRISTIANSAND S',
    extra: 'Bakkes Bilpleie er et enkeltpersonforetak registrert i Brønnøysundregistrene.',
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
      meetingPlace: 'Bråvann platå 64, 4624 KRISTIANSAND S',
      orgNumber: '937366221',
      websiteDomain: '',
      details: { instagramUrl: '', facebookUrl: '', googleBusinessProfile: '' },
      clientBrief: { short: 'Bakkes Bilpleie er bilpleie i Kristiansand.' },
    },
    {
      persist: false,
      current: {
        orgNumber: '937366221',
        details: { googleBusinessProfile: 'https://maps.google.com/?cid=4582029138078882824' },
      },
    }
  );
  assert.equal(applied.details.googleBusinessProfile, 'https://maps.google.com/?cid=4582029138078882824');
  assert.equal(applied.orgNumber, '937366221');
});

test('normalizeInfokortSubmission stores host-only website, cid maps, and brief', () => {
  const submission = normalizeInfokortSubmission({
    industry: 'markedsplass',
    meetingPlace: 'Vasøyveien 103, 7167 Vallersund',
    orgNumber: '925992720',
    websiteDomain: 'https://www.tass.no/om-oss',
    instagramUrl: 'https://www.instagram.com/tass.norge/',
    facebookUrl: 'https://www.facebook.com/tassnorge/',
    proffUrl: 'https://www.proff.no/selskap/deles/x/x/925992720',
    googleBusinessProfile: 'https://maps.google.com/?cid=5208062932965149043',
    briefShort: 'TASS er en markedsplass.',
    briefFull: 'TASS drives av Deles Are Terjesen.',
  });
  assert.equal(submission.websiteDomain, 'tass.no');
  assert.equal(submission.details.proffUrl, 'https://www.proff.no/selskap/x/x/x/925992720');
  assert.equal(submission.details.googleBusinessProfile, 'https://maps.google.com/?cid=5208062932965149043');
  assert.equal(submission.clientBrief.source, 'infokort-haiku');
  assert.match(submission.clientBrief.short, /TASS/);
});

test('scoreInfokortMatch accepts empty Bakkes-style socials and alias industry', () => {
  const expected = {
    industry: 'bilverksted',
    websiteDomain: '',
    orgNumber: '937366221',
    meetingPlace: 'Bråvann platå 64, 4624 KRISTIANSAND S',
    instagramUrl: '',
    facebookUrl: '',
    googleBusinessProfile: '',
  };
  const actual = {
    industry: 'bilpleie',
    websiteDomain: '',
    orgNumber: '937366221',
    meetingPlace: 'Bråvann platå 64, 4624 Kristiansand S',
    details: {
      instagramUrl: '',
      facebookUrl: '',
      proffUrl: 'https://www.proff.no/selskap/x/x/x/937366221',
      googleBusinessProfile: '',
    },
  };
  const score = scoreInfokortMatch(expected, actual);
  assert.equal(score.ok, true, String(score.failed));
});

test('scoreInfokortMatch fails when industry is the leftover NACE', () => {
  const score = scoreInfokortMatch(
    { industry: 'markedsplass', websiteDomain: 'tass.no', orgNumber: '925992720', instagramUrl: '', facebookUrl: '', googleBusinessProfile: '' },
    { industry: 'reklamebyrå', websiteDomain: 'tass.no', orgNumber: '925992720', details: {} }
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
          input: { orgNumber: '925992720' },
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
          meetingPlace: 'Vasøyveien 103, 7167 Vallersund',
          orgNumber: '925992720',
          websiteDomain: 'tass.no',
          instagramUrl: '',
          facebookUrl: '',
          proffUrl: 'https://www.proff.no/selskap/x/x/x/925992720',
          googleBusinessProfile: '',
          briefShort: 'TASS er en markedsplass i Norge.',
        },
      }],
      usage: {},
    };
  };
  const result = await runInfokortAgent(
    { businessName: 'Deles Are Terjesen', orgNumber: '925992720' },
    {
      chat,
      search: async () => [],
      mapsSearch: async () => ({ ok: true, results: [] }),
      readWebsite: async () => [],
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          navn: 'DELES ARE TERJESEN',
          organisasjonsnummer: '925992720',
          forretningsadresse: { adresse: ['Vasøyveien 103'], postnummer: '7167', poststed: 'VALLERSUND' },
          hjemmeside: 'tass.no',
        }),
      }),
    }
  );
  assert.equal(result.ok, true);
  assert.equal(result.submission.industry, 'markedsplass');
  assert.equal(result.submission.websiteDomain, 'tass.no');
  const applied = applyInfokortResult('client-1', result.submission, {
    persist: true,
    update: (id, patch) => ({ id, ...patch }),
  });
  assert.equal(applied.id, 'client-1');
  assert.equal(applied.details.proffUrl, 'https://www.proff.no/selskap/x/x/x/925992720');
});

test('attachRegistryDefaults replaces a stale stored street with Brreg', async () => {
  const next = await attachRegistryDefaults(
    {
      industry: 'markedsplass',
      meetingPlace: 'Meieriveien 5',
      websiteDomain: 'tass.no',
      orgNumber: '925992720',
      details: {},
    },
    { businessName: 'Deles Are Terjesen', meetingPlace: 'Meieriveien 5', orgNumber: '925992720' },
    async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        navn: 'DELES ARE TERJESEN',
        organisasjonsnummer: '925992720',
        forretningsadresse: { adresse: ['Vasøyveien 103'], postnummer: '7167', poststed: 'VALLERSUND' },
        hjemmeside: 'tass.no',
      }),
    })
  );
  assert.match(next.meetingPlace, /Vasøyveien 103/i);
});

test('fillProvenPublicLinks writes TASS socials and Maps from trading-name hits', async () => {
  const filled = await fillProvenPublicLinks(
    {
      industry: 'markedsplass',
      meetingPlace: 'Vasøyveien 103 7167 VALLERSUND',
      websiteDomain: 'tass.no',
      orgNumber: '925992720',
      details: {
        instagramUrl: '',
        facebookUrl: '',
        googleBusinessProfile: '',
        proffUrl: 'https://www.proff.no/selskap/x/x/x/925992720',
      },
    },
    { businessName: 'Deles Are Terjesen', contactPhone: '47 13 13 80' },
    {
      readWebsite: async () => ([
        { url: 'https://www.instagram.com/tass.norge/', title: 'tass.no', snippet: 'tass.no' },
        { url: 'https://www.facebook.com/tassnorge/', title: 'tass.no', snippet: 'tass.no' },
      ]),
      search: async () => [],
      mapsSearch: async () => ({
        ok: true,
        results: [{
          title: 'TASS',
          address: 'Vasøyveien 103, 7167 Vallersund',
          phone: '47 13 13 80',
          website: 'https://tass.no',
          cid: '5208062932965149043',
          mapsUrl: 'https://maps.google.com/?cid=5208062932965149043',
        }],
      }),
    }
  );
  const score = scoreInfokortMatch({
    industry: 'markedsplass',
    websiteDomain: 'tass.no',
    orgNumber: '925992720',
    meetingPlace: 'Vasøyveien 103, 7167 Vallersund',
    instagramUrl: 'https://www.instagram.com/tass.norge/',
    facebookUrl: 'https://www.facebook.com/tassnorge/',
    googleBusinessProfile: 'https://maps.google.com/?cid=5208062932965149043',
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
          meetingPlace: 'Vasøyveien 103, 7167 Vallersund',
          orgNumber: '925992720',
          websiteDomain: 'tass.no',
          instagramUrl: '',
          facebookUrl: '',
          proffUrl: '',
          googleBusinessProfile: '',
          briefShort: 'TASS er en markedsplass.',
        },
      }],
      usage: {},
    };
  };
  const result = await runInfokortAgent(
    { businessName: 'Deles Are Terjesen', orgNumber: '925992720' },
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
          navn: 'DELES ARE TERJESEN',
          organisasjonsnummer: '925992720',
          forretningsadresse: { adresse: ['Vasøyveien 103'], postnummer: '7167', poststed: 'VALLERSUND' },
          hjemmeside: 'tass.no',
        }),
      }),
    }
  );
  assert.equal(result.ok, true);
  assert.equal(searches.length, INFOKORT_ORGANIC_SEARCH_LIMIT);
  assert.equal(maps.length, INFOKORT_MAPS_SEARCH_LIMIT);
});

test('fillProvenPublicLinks leaves Bakkes socials empty when search is empty', async () => {
  const filled = await fillProvenPublicLinks(
    {
      industry: 'bilpleie',
      meetingPlace: 'Bråvann platå 64, 4624 Kristiansand S',
      websiteDomain: '',
      orgNumber: '937366221',
      details: {},
    },
    { businessName: 'BAKKES BILPLEIE' },
    { search: async () => [], mapsSearch: async () => ({ ok: true, results: [] }) }
  );
  assert.equal(filled.details.instagramUrl, '');
  assert.equal(filled.details.facebookUrl, '');
  assert.equal(filled.details.googleBusinessProfile, '');
});
